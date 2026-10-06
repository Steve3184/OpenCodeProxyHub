import { SSE_RESPONSE_HEADERS } from "../utils/responseHeaders.js";
import https from "node:https";
import type { ServerResponse } from "node:http";
import { ocId } from "../utils/ids.js";
import type { AnthropicMessageRequest, ZenFullResponse } from "../types/api.js";
import type { ZenPreparedRequest } from "../providers/zenClient.js";
import { isOpenCodeProxyAccessError, isUpstreamRateLimitError } from "../providers/opencodeAccessErrors.js";
import type { ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";
import { createTokenUsageAccumulator } from "../utils/tokenUsage.js";
import type { ToolNameMapper } from "./toolMapping.js";

export const anthropicToOpenAI = (body: AnthropicMessageRequest): { messages: unknown[]; tools?: unknown[]; toolChoice?: unknown; parameters: Record<string, unknown> } => {
  const messages: any[] = [];
  if (body.system) {
    const sys = typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((block) => block.text || "").join("\n")
        : "";
    if (sys) messages.push({ role: "system", content: sys });
  }

  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    const text = msg.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");
    const toolUses = msg.content.filter((block: any) => block.type === "tool_use");

    if (toolUses.length && msg.role === "assistant") {
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolUses.map((toolUse: any) => ({
          id: toolUse.id,
          type: "function",
          function: { name: toolUse.name, arguments: JSON.stringify(toolUse.input || {}) },
        })),
      });
      continue;
    }

    if (msg.content.some((block: any) => block.type === "tool_result")) {
      for (const block of msg.content.filter((item: any) => item.type === "tool_result")) {
        const resultText = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((part: any) => part.text || "").join("\n")
            : "";
        messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: resultText });
      }
      continue;
    }

    messages.push({ role: msg.role, content: text });
  }

  const tools = (body.tools || []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || {},
    },
  }));

  const parameters: Record<string, unknown> = {
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
  };

  return { messages, tools: tools.length ? tools : undefined, toolChoice: body.tool_choice, parameters };
};

export const openAIToAnthropic = (oaiResp: any, model: string, inputTokens: number, toolMapper?: ToolNameMapper) => {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content: any[] = [];
  if (choice.message?.content) content.push({ type: "text", text: choice.message.content });
  if (choice.message?.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      // Placeholder calls the client never declared are dropped entirely.
      const name = toolMapper ? toolMapper.toDownstream(toolCall.function?.name) : toolCall.function?.name;
      if (name === undefined) continue;
      let input = {};
      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: toolCall.id || ocId("toolu"),
        name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls" && content.some((block) => block.type === "tool_use")) stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
};

export const handleAnthropicFullResponse = (zenResp: ZenFullResponse, model: string, inputTokens: number, toolMapper?: ToolNameMapper) => {
  const rawError = typeof zenResp.raw === "string" ? zenResp.raw : "";
  const rateLimited = zenResp.status === 429 || rawError.includes("FreeUsageLimitError") || rawError.includes("rate_limit_error") || rawError.toLowerCase().includes("rate limit");
  if (rateLimited) {
    const errMsg = zenResp.data?.error?.message || "Rate limit exceeded";
    return {
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: `${errMsg} (free model rate limit)` } },
    };
  }
  if (zenResp.status < 200 || zenResp.status >= 300 || zenResp.data?.error) {
    return {
      status: zenResp.status >= 400 ? zenResp.status : 502,
      body: { type: "error", error: { type: "upstream_error", message: zenResp.data?.error?.message || "Invalid upstream response" } },
    };
  }
  if (!zenResp.data?.choices) {
    return {
      status: 502,
      body: { type: "error", error: { type: "upstream_error", message: "Invalid upstream response" } },
    };
  }
  return { status: 200, body: openAIToAnthropic(zenResp.data, model, inputTokens, toolMapper) };
};

export const pipeZenAsAnthropic = (
  prepared: ZenPreparedRequest,
  model: string,
  res: ServerResponse,
  inputTokens: number,
  proxyPool?: ProxyPoolStore,
  metrics?: MetricsStore,
  retryPrepare?: (excludeProxyIds: ReadonlySet<string>) => ZenPreparedRequest,
  retryCount = 0,
  toolMapper?: ToolNameMapper,
  maxRetries = 1,
): void => {
  if (prepared.lease?.requiredUnavailable) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "proxy_unavailable", message: "Proxy is required but no proxy node is available" } }));
    return;
  }
  const msgId = ocId("msg");
  const started = process.hrtime.bigint();
  const durationMs = () => Number(process.hrtime.bigint() - started) / 1_000_000;
  let markedFailure = false;
  let retryStarted = false;
  let settled = false;
  const req = https.request(prepared.options, (zenRes) => {
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let firstChunkHandled = false;
    const usageAccumulator = createTokenUsageAccumulator();
    let rateLimitBody = "";

    const retryWithAnotherProxy = (): boolean => {
      if (retryCount >= maxRetries || !retryPrepare || !proxyPool || !prepared.lease?.node?.id || res.headersSent) return false;
      const excluded = new Set<string>([prepared.lease.node.id]);
      const retryPrepared = retryPrepare(excluded);
      if (retryPrepared.lease?.requiredUnavailable) return false;
      retryStarted = true;
      const nextRetryPrepare = (additional: ReadonlySet<string>) => {
        const allExcluded = new Set(excluded);
        for (const id of additional) allExcluded.add(id);
        return retryPrepare(allExcluded);
      };
      pipeZenAsAnthropic(retryPrepared, model, res, inputTokens, proxyPool, metrics, nextRetryPrepare, retryCount + 1, toolMapper, maxRetries);
      return true;
    };

    const sendSSE = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Upstream tool names (`bash`) must come back in the client's spelling
    // (`Bash`), and placeholder calls the client never declared must be dropped.
    // A call's name may arrive in a later chunk than its id, so state is tracked
    // per tool index and the block only opens once the name is known; arguments
    // seen before then are buffered and flushed when the block opens.
    let nextBlockIndex = 0;
    let textBlockIndex = -1;
    let sawToolBlock = false;
    interface ToolState { blockIndex: number; opened: boolean; dropped: boolean; id?: string; pendingArgs: string; }
    const toolStates = new Map<number, ToolState>();
    const mapToolName = (name: unknown): string | undefined => (
      toolMapper ? toolMapper.toDownstream(name) : (typeof name === "string" ? name : undefined)
    );
    const emitToolArgs = (state: ToolState, args: string): void => {
      if (!args) return;
      sendSSE("content_block_delta", { type: "content_block_delta", index: state.blockIndex, delta: { type: "input_json_delta", partial_json: args } });
      outputTokens += Math.ceil(args.length / 4);
    };
    const openToolBlock = (state: ToolState, id: unknown, name: string): void => {
      state.blockIndex = nextBlockIndex;
      nextBlockIndex += 1;
      state.opened = true;
      sawToolBlock = true;
      sendSSE("content_block_start", { type: "content_block_start", index: state.blockIndex, content_block: { type: "tool_use", id: typeof id === "string" && id ? id : ocId("toolu"), name } });
      if (state.pendingArgs) {
        const pending = state.pendingArgs;
        state.pendingArgs = "";
        emitToolArgs(state, pending);
      }
    };

    const sendHeaders = () => {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, SSE_RESPONSE_HEADERS);
      sendSSE("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
    };

    zenRes.on("data", (chunk: Buffer) => {
      if (settled || retryStarted) return;
      const str = chunk.toString();
      if ((zenRes.statusCode || 502) >= 400) {
        rateLimitBody += str;
        return;
      }
      if (!firstChunkHandled) {
        firstChunkHandled = true;
        const trimmed = str.trim();
        if (trimmed.startsWith("{")) {
          try {
            const parsed = JSON.parse(trimmed);
            const upstreamStatus = zenRes.statusCode || 200;
            const rateLimited = isUpstreamRateLimitError(upstreamStatus, trimmed);
            const proxyAccessError = isOpenCodeProxyAccessError(upstreamStatus, trimmed);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit";
              const errorStatus = rateLimited ? 429 : proxyAccessError ? 403 : 502;
              if (prepared.lease?.node && proxyPool && !markedFailure) {
                proxyPool.markFailure(prepared.lease.node.id, errMsg, { statusCode: errorStatus, leaseId: prepared.lease.leaseId });
                markedFailure = true;
              }
              if ((rateLimited || proxyAccessError) && retryWithAnotherProxy()) {
                settled = true;
                zenRes.resume();
                return;
              }
              settled = true;
              if (!res.headersSent) {
                const responseStatus = rateLimited ? 429 : proxyAccessError ? 403 : 502;
                res.writeHead(responseStatus, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: rateLimited ? "rate_limit_error" : "upstream_error", message: rateLimited ? `${errMsg} (free model rate limit)` : errMsg } }));
              }
              metrics?.recordUpstream({ statusCode: rateLimited ? 429 : proxyAccessError ? 403 : 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
              zenRes.resume();
              return;
            }
          } catch {
            // Continue with normal stream parsing.
          }
        }
      }

      buffer += str;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        usageAccumulator.observe(parsed);
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;
        if (!delta) continue;

        sendHeaders();

        if (delta.content) {
          if (textBlockIndex === -1) {
            textBlockIndex = nextBlockIndex;
            nextBlockIndex += 1;
            sendSSE("content_block_start", { type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } });
          }
          sendSSE("content_block_delta", { type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text: delta.content } });
          outputTokens += Math.ceil(delta.content.length / 4);
        }

        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const idx = toolCall.index ?? 0;
            let state = toolStates.get(idx);
            if (!state) {
              state = { blockIndex: -1, opened: false, dropped: false, pendingArgs: "" };
              toolStates.set(idx, state);
            }
            if (state.dropped) continue;
            if (!state.opened) {
              if (typeof toolCall.id === "string" && toolCall.id) state.id = toolCall.id;
              const rawName = toolCall.function?.name;
              // The name may not have arrived yet; wait for it before deciding.
              if (typeof rawName !== "string") {
                if (toolCall.function?.arguments) state.pendingArgs += toolCall.function.arguments;
                continue;
              }
              const mappedName = mapToolName(rawName);
              if (mappedName === undefined) {
                // Placeholder call the client never declared: drop the block.
                state.dropped = true;
                state.pendingArgs = "";
                continue;
              }
              if (textBlockIndex !== -1) {
                sendSSE("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
                textBlockIndex = -1;
              }
              openToolBlock(state, state.id, mappedName);
            }
            if (toolCall.function?.arguments) emitToolArgs(state, toolCall.function.arguments);
          }
        }

        if (choice.finish_reason) {
          const openBlocks = [...toolStates.values()]
            .filter((state) => state.opened && !state.dropped)
            .map((state) => state.blockIndex)
            .sort((a, b) => a - b);
          if (textBlockIndex !== -1) openBlocks.push(textBlockIndex);
          for (const blockIndex of openBlocks.sort((a, b) => a - b)) {
            sendSSE("content_block_stop", { type: "content_block_stop", index: blockIndex });
          }
          let stopReason = "end_turn";
          if (choice.finish_reason === "tool_calls" && sawToolBlock) stopReason = "tool_use";
          else if (choice.finish_reason === "length") stopReason = "max_tokens";
          sendSSE("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } });
          sendSSE("message_stop", { type: "message_stop" });
        }
      }
    });

    zenRes.on("end", () => {
      if (settled || retryStarted) return;
      settled = true;
      const status = zenRes.statusCode || 502;
      if (status >= 400) {
        const rateLimited = isUpstreamRateLimitError(status, rateLimitBody);
        const proxyAccessError = isOpenCodeProxyAccessError(status, rateLimitBody);
        let errMsg = rateLimited ? "Rate limit" : `Upstream returned HTTP ${status}`;
        try {
          const parsed = JSON.parse(rateLimitBody);
          errMsg = parsed.error?.message || parsed.message || errMsg;
        } catch {
          // Keep the generic rate-limit message for malformed upstream bodies.
        }
        if (prepared.lease?.node && proxyPool && !markedFailure) {
          proxyPool.markFailure(prepared.lease.node.id, errMsg, { statusCode: rateLimited ? 429 : status, leaseId: prepared.lease.leaseId });
          markedFailure = true;
        }
        if ((rateLimited || proxyAccessError) && retryWithAnotherProxy()) return;
        if (!res.headersSent) {
          const responseStatus = rateLimited ? 429 : status;
          res.writeHead(responseStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: rateLimited ? "rate_limit_error" : "upstream_error", message: rateLimited ? `${errMsg} (free model rate limit)` : errMsg } }));
        }
        metrics?.recordUpstream({ statusCode: rateLimited ? 429 : status, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
        return;
      }
      if (prepared.lease?.node && proxyPool && !markedFailure) {
        const status = zenRes.statusCode || 502;
        if (status >= 200 && status < 300) {
          proxyPool.markSuccess(prepared.lease.node.id, prepared.lease.leaseId, status);
          proxyPool.recordTokenUsage(prepared.lease.node.id, usageAccumulator.totalTokens() ?? (inputTokens + outputTokens));
        } else {
          proxyPool.markFailure(prepared.lease.node.id, `Upstream returned HTTP ${status}`, { statusCode: status, leaseId: prepared.lease.leaseId });
          markedFailure = true;
        }
      }
      metrics?.recordUpstream({ statusCode: zenRes.statusCode || 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
      if (!headersSent) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "upstream_error", message: "Empty response" } }));
        }
        return;
      }
      res.end();
    });
  });

  res.on("close", () => {
    if (!settled && !retryStarted) {
      settled = true;
      if (prepared.lease?.node && proxyPool) proxyPool.release(prepared.lease.node.id, prepared.lease.leaseId);
    }
    if (!req.destroyed) req.destroy();
  });

  req.on("error", (error) => {
    if (settled || retryStarted) return;
    settled = true;
    if (prepared.lease?.node && proxyPool && !markedFailure) proxyPool.markFailure(prepared.lease.node.id, error.message, { leaseId: prepared.lease.leaseId });
    metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: error.message });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "upstream_error", message: error.message } }));
    }
  });

  req.on("timeout", () => {
    if (settled || retryStarted) return;
    settled = true;
    req.destroy();
    if (prepared.lease?.node && proxyPool && !markedFailure) proxyPool.markFailure(prepared.lease.node.id, "Upstream timeout", { statusCode: 504, leaseId: prepared.lease.leaseId });
    metrics?.recordUpstream({ statusCode: 504, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "Upstream timeout" });
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "timeout_error", message: "Upstream timeout" } }));
    }
  });

  req.write(prepared.body);
  req.end();
};
