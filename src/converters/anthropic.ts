import https from "node:https";
import type { ServerResponse } from "node:http";
import { ocId } from "../utils/ids.js";
import type { AnthropicMessageRequest, ZenFullResponse } from "../types/api.js";
import type { ZenPreparedRequest } from "../providers/zenClient.js";
import type { ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";
import { extractTokenUsage } from "../utils/tokenUsage.js";

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

export const openAIToAnthropic = (oaiResp: any, model: string, inputTokens: number) => {
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
      let input = {};
      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: toolCall.id || ocId("toolu"),
        name: toolCall.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
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

export const handleAnthropicFullResponse = (zenResp: ZenFullResponse, model: string, inputTokens: number) => {
  if (zenResp.status === 429 || zenResp.data?.error) {
    const errMsg = zenResp.data?.error?.message || "Rate limit exceeded";
    return {
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: `${errMsg} (free model rate limit)` } },
    };
  }
  if (!zenResp.data?.choices) {
    return {
      status: 502,
      body: { type: "error", error: { type: "upstream_error", message: "Invalid upstream response" } },
    };
  }
  return { status: 200, body: openAIToAnthropic(zenResp.data, model, inputTokens) };
};

export const pipeZenAsAnthropic = (
  prepared: ZenPreparedRequest,
  model: string,
  res: ServerResponse,
  inputTokens: number,
  proxyPool?: ProxyPoolStore,
  metrics?: MetricsStore,
  retryPrepare?: (excludeProxyIds: ReadonlySet<string>) => ZenPreparedRequest,
  retryAttempt = false,
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
  const req = https.request(prepared.options, (zenRes) => {
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let contentIdx = 0;
    let toolIdx = -1;
    let firstChunkHandled = false;
    let observedTotalTokens: number | null = null;
    let observedUsageTokens = 0;
    let observedUsage = false;
    let rateLimitBody = "";

    const retryRateLimited = (): boolean => {
      if (retryAttempt || !retryPrepare || !proxyPool || !prepared.lease?.node?.id || res.headersSent) return false;
      const excluded = new Set<string>();
      if (prepared.lease?.node?.id) excluded.add(prepared.lease.node.id);
      const retryPrepared = retryPrepare(excluded);
      if (retryPrepared.lease?.requiredUnavailable) return false;
      retryStarted = true;
      pipeZenAsAnthropic(retryPrepared, model, res, inputTokens, proxyPool, metrics, retryPrepare, true);
      return true;
    };

    const sendSSE = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const sendHeaders = () => {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
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
      const str = chunk.toString();
      if (zenRes.statusCode === 429) {
        rateLimitBody += str;
        return;
      }
      if (!firstChunkHandled) {
        firstChunkHandled = true;
        const trimmed = str.trim();
        if (zenRes.statusCode === 429 || (trimmed.startsWith("{") && (trimmed.includes("FreeUsageLimitError") || trimmed.includes("rate_limit_error") || trimmed.toLowerCase().includes("rate limit")))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (zenRes.statusCode === 429 || parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit";
              if (prepared.lease?.node && proxyPool) {
                proxyPool.markFailure(prepared.lease.node.id, errMsg, { statusCode: 429 });
                markedFailure = true;
              }
              if (retryRateLimited()) {
                zenRes.resume();
                return;
              }
              if (!res.headersSent) {
                res.writeHead(429, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `${errMsg} (free model rate limit)` } }));
              }
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
        const usage = extractTokenUsage(parsed);
        if (usage.totalTokens !== null) {
          observedUsage = true;
          if (usage.inputTokens > 0 && usage.outputTokens > 0) observedTotalTokens = usage.totalTokens;
          else observedUsageTokens += usage.totalTokens;
        }
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;
        if (!delta) continue;

        sendHeaders();

        if (delta.content) {
          if (contentIdx === 0 && toolIdx === -1) {
            sendSSE("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            contentIdx = 1;
          }
          sendSSE("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } });
          outputTokens += Math.ceil(delta.content.length / 4);
        }

        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const idx = toolCall.index ?? 0;
            if (idx > toolIdx) {
              if (toolIdx === -1 && contentIdx > 0) sendSSE("content_block_stop", { type: "content_block_stop", index: 0 });
              toolIdx = idx;
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id: toolCall.id || ocId("toolu"), name: toolCall.function?.name || "" } });
            }
            if (toolCall.function?.arguments) {
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: toolCall.function.arguments } });
              outputTokens += Math.ceil(toolCall.function.arguments.length / 4);
            }
          }
        }

        if (choice.finish_reason) {
          const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
          for (let i = 0; i < totalBlocks; i += 1) sendSSE("content_block_stop", { type: "content_block_stop", index: i });
          let stopReason = "end_turn";
          if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
          else if (choice.finish_reason === "length") stopReason = "max_tokens";
          sendSSE("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } });
          sendSSE("message_stop", { type: "message_stop" });
        }
      }
    });

    zenRes.on("end", () => {
      if (retryStarted) return;
      if ((zenRes.statusCode || 502) === 429) {
        let errMsg = "Rate limit";
        try {
          const parsed = JSON.parse(rateLimitBody);
          errMsg = parsed.error?.message || parsed.message || errMsg;
        } catch {
          // Keep the generic rate-limit message for malformed upstream bodies.
        }
        if (prepared.lease?.node && proxyPool) {
          proxyPool.markFailure(prepared.lease.node.id, errMsg, { statusCode: 429 });
          markedFailure = true;
        }
        if (retryRateLimited()) return;
        if (!res.headersSent) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `${errMsg} (free model rate limit)` } }));
        }
        metrics?.recordUpstream({ statusCode: 429, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
        return;
      }
      if (prepared.lease?.node && proxyPool && !markedFailure) {
        proxyPool.markSuccess(prepared.lease.node.id);
        proxyPool.recordTokenUsage(prepared.lease.node.id, observedTotalTokens ?? (observedUsage ? observedUsageTokens : inputTokens + outputTokens));
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
    if (!req.destroyed) req.destroy();
  });

  req.on("error", (error) => {
    if (retryStarted) return;
    if (prepared.lease?.node && proxyPool && !markedFailure) proxyPool.markFailure(prepared.lease.node.id, error.message);
    metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: error.message });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "upstream_error", message: error.message } }));
    }
  });

  req.on("timeout", () => {
    if (retryStarted) return;
    req.destroy();
    if (prepared.lease?.node && proxyPool && !markedFailure) proxyPool.markFailure(prepared.lease.node.id, "Upstream timeout");
    metrics?.recordUpstream({ statusCode: 504, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "Upstream timeout" });
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "timeout_error", message: "Upstream timeout" } }));
    }
  });

  req.write(prepared.body);
  req.end();
};
