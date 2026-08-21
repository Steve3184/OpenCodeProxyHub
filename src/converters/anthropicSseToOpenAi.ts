import https from "node:https";
import type { ServerResponse } from "node:http";
import { ocId } from "../utils/ids.js";
import type { ZenPreparedRequest } from "../providers/zenClient.js";
import type { ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";
import { createTokenUsageAccumulator } from "../utils/tokenUsage.js";

const noProxyAvailableError = "Proxy is required but no proxy node is available";

type FinishReason = "stop" | "tool_calls" | "length";

interface TransformState {
  id: string;
  created: number;
  model: string;
  roleSent: boolean;
  blockToToolIndex: Map<number, number>;
  nextToolIndex: number;
  sawToolCall: boolean;
  stopReason: FinishReason;
  doneSent: boolean;
}

interface SseBlock {
  event?: string;
  data: string;
}

const createState = (model: string): TransformState => ({
  id: ocId("chatcmpl"),
  created: Math.floor(Date.now() / 1000),
  model,
  roleSent: false,
  blockToToolIndex: new Map(),
  nextToolIndex: 0,
  sawToolCall: false,
  stopReason: "stop",
  doneSent: false,
});

const openAiChunk = (state: TransformState, delta: Record<string, unknown>, finishReason: FinishReason | null = null) => ({
  id: state.id,
  object: "chat.completion.chunk",
  created: state.created,
  model: state.model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const writeSse = (res: ServerResponse, payload: unknown): void => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const sendHeaders = (res: ServerResponse): void => {
  if (res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Transfer-Encoding": "chunked",
  });
};

const sendRole = (state: TransformState, res: ServerResponse): void => {
  if (state.roleSent) return;
  sendHeaders(res);
  writeSse(res, openAiChunk(state, { role: "assistant" }));
  state.roleSent = true;
};

const sendDone = (state: TransformState, res: ServerResponse): void => {
  if (state.doneSent) return;
  sendRole(state, res);
  writeSse(res, openAiChunk(state, {}, state.stopReason));
  res.write("data: [DONE]\n\n");
  state.doneSent = true;
};

const mapStopReason = (stopReason: unknown): FinishReason => {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
};

const parseSseBlock = (raw: string): SseBlock | null => {
  const dataLines: string[] = [];
  let event: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!event && dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
};

const extractSseBlocks = (buffer: string): { blocks: SseBlock[]; rest: string } => {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() || "";
  return { blocks: parts.map(parseSseBlock).filter((block): block is SseBlock => Boolean(block)), rest };
};

const isPlainJson = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
};

const writeOpenAiError = (res: ServerResponse, statusCode: number, message: string): void => {
  if (res.headersSent) return;
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "upstream_error" } }));
};

const handleParsedPayload = (state: TransformState, res: ServerResponse, parsed: any): void => {
  if (state.doneSent) return;

  if (Array.isArray(parsed?.choices)) {
    sendHeaders(res);
    // Some upstream deployments emit OpenAI-shaped chunks even on this path.
    // Keep the downstream alias visible in those raw chunks too.
    writeSse(res, { ...parsed, model: state.model });
    return;
  }

  if (parsed?.type === "message_start") {
    sendRole(state, res);
    return;
  }

  if (parsed?.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
    sendRole(state, res);
    const blockIndex = Number.isInteger(parsed.index) ? parsed.index : state.nextToolIndex;
    const toolIndex = state.nextToolIndex;
    state.nextToolIndex += 1;
    state.blockToToolIndex.set(blockIndex, toolIndex);
    state.sawToolCall = true;
    writeSse(res, openAiChunk(state, {
      tool_calls: [{
        index: toolIndex,
        id: parsed.content_block.id || ocId("toolu"),
        type: "function",
        function: { name: parsed.content_block.name || "", arguments: "" },
      }],
    }));
    return;
  }

  if (parsed?.type === "content_block_delta") {
    const delta = parsed.delta || {};
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      sendRole(state, res);
      writeSse(res, openAiChunk(state, { content: delta.text }));
      return;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
      sendRole(state, res);
      writeSse(res, openAiChunk(state, { reasoning_content: delta.thinking }));
      return;
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      sendRole(state, res);
      const blockIndex = Number.isInteger(parsed.index) ? parsed.index : -1;
      const toolIndex = state.blockToToolIndex.get(blockIndex) ?? 0;
      state.sawToolCall = true;
      writeSse(res, openAiChunk(state, {
        tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }],
      }));
    }
    return;
  }

  if (parsed?.type === "message_delta") {
    state.stopReason = mapStopReason(parsed.delta?.stop_reason);
    return;
  }

  if (parsed?.type === "message_stop") {
    if (state.sawToolCall && state.stopReason === "stop") state.stopReason = "tool_calls";
    sendDone(state, res);
  }
};

export const pipeAnthropicSseAsOpenAI = (
  prepared: ZenPreparedRequest,
  model: string,
  res: ServerResponse,
  proxyPool?: ProxyPoolStore,
  metrics?: MetricsStore,
  retryPrepare?: (excludeProxyIds: ReadonlySet<string>) => ZenPreparedRequest,
  retryAttempt = false,
): void => {
  if (prepared.lease?.requiredUnavailable) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: noProxyAvailableError, type: "proxy_unavailable" } }));
    return;
  }

  const state = createState(model);
  const started = process.hrtime.bigint();
  const durationMs = () => Number(process.hrtime.bigint() - started) / 1_000_000;
  let buffer = "";
  let markedFailure = false;
  let receivedData = false;
  let retryStarted = false;
  let settled = false;
  const usageAccumulator = createTokenUsageAccumulator();
  let observedOutputChars = 0;

  const retryRateLimited = (): boolean => {
    if (retryAttempt || !retryPrepare || !proxyPool || !prepared.lease?.node?.id || res.headersSent) return false;
    const excluded = new Set<string>();
    if (prepared.lease?.node?.id) excluded.add(prepared.lease.node.id);
    const retryPrepared = retryPrepare(excluded);
    if (retryPrepared.lease?.requiredUnavailable) return false;
    retryStarted = true;
    pipeAnthropicSseAsOpenAI(retryPrepared, model, res, proxyPool, metrics, retryPrepare, true);
    return true;
  };

  const req = https.request(prepared.options, (zenRes) => {
    zenRes.on("data", (chunk: Buffer) => {
      if (settled || retryStarted) return;
      receivedData = true;
      buffer += chunk.toString();

      if (!res.headersSent && isPlainJson(buffer)) {
        try {
          const parsed = JSON.parse(buffer);
          if (parsed.error || parsed.type === "error" || zenRes.statusCode === 429) {
            const message = parsed.error?.message || parsed.message || "Upstream error";
            const rateLimited = zenRes.statusCode === 429 || buffer.includes("FreeUsageLimitError") || buffer.includes("rate_limit_error") || buffer.toLowerCase().includes("rate limit");
            if (prepared.lease?.node && proxyPool && !markedFailure) {
              proxyPool.markFailure(prepared.lease.node.id, message, { statusCode: rateLimited ? 429 : 502, leaseId: prepared.lease.leaseId });
              markedFailure = true;
            }
            if (rateLimited && retryRateLimited()) {
              settled = true;
              zenRes.resume();
              return;
            }
            settled = true;
            const upstreamStatus = zenRes.statusCode || 502;
            const responseStatus = rateLimited ? 429 : (upstreamStatus >= 400 ? upstreamStatus : 502);
            writeOpenAiError(res, responseStatus, message);
            metrics?.recordUpstream({ statusCode: responseStatus, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
            zenRes.resume();
            return;
          }
        } catch {
          // Continue parsing as SSE if this is not a complete JSON error body.
        }
      }

      const extracted = extractSseBlocks(buffer);
      buffer = extracted.rest;
      for (const block of extracted.blocks) {
        if (state.doneSent) continue;
        if (block.data === "[DONE]") {
          sendDone(state, res);
          continue;
        }
        if (!block.data) continue;
        try {
          const parsed = JSON.parse(block.data);
          usageAccumulator.observe(parsed);
          const text = parsed.delta?.text || parsed.delta?.thinking || parsed.content_block?.text;
          if (typeof text === "string") observedOutputChars += text.length;
          handleParsedPayload(state, res, parsed);
        } catch {
          // Ignore malformed SSE payloads rather than corrupting the OpenAI stream.
        }
      }
    });

    zenRes.on("end", () => {
      if (settled || retryStarted) return;
      settled = true;
      const status = zenRes.statusCode || 502;
      if (status >= 400) {
        const rateLimited = status === 429 || buffer.includes("FreeUsageLimitError") || buffer.includes("rate_limit_error") || buffer.toLowerCase().includes("rate limit");
        if (prepared.lease?.node && proxyPool && !markedFailure) {
          proxyPool.markFailure(prepared.lease.node.id, `Upstream returned HTTP ${status}`, { statusCode: rateLimited ? 429 : status, leaseId: prepared.lease.leaseId });
          markedFailure = true;
        }
        if (rateLimited && retryRateLimited()) return;
        writeOpenAiError(res, rateLimited ? 429 : status, rateLimited ? "Upstream returned 429" : `Upstream returned HTTP ${status}`);
        if (!res.writableEnded) res.end();
        metrics?.recordUpstream({ statusCode: rateLimited ? 429 : status, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
        return;
      }
      if (prepared.lease?.node && proxyPool && !markedFailure) {
        const status = zenRes.statusCode || 502;
        if (status >= 200 && status < 300) proxyPool.markSuccess(prepared.lease.node.id, prepared.lease.leaseId, status);
        else {
          proxyPool.markFailure(prepared.lease.node.id, `Upstream returned HTTP ${status}`, { statusCode: status, leaseId: prepared.lease.leaseId });
          markedFailure = true;
        }
        const inputTokens = Math.ceil(prepared.body.length / 4);
        if (status >= 200 && status < 300) proxyPool.recordTokenUsage(prepared.lease.node.id, usageAccumulator.totalTokens() ?? (inputTokens + Math.ceil(observedOutputChars / 4)));
      }
      metrics?.recordUpstream({ statusCode: zenRes.statusCode || 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });

      if (!receivedData && !res.headersSent) {
        writeOpenAiError(res, 502, "Empty response from upstream");
        return;
      }
      if (!state.doneSent && !res.writableEnded) sendDone(state, res);
      if (!res.writableEnded) res.end();
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
    if (markedFailure) return;
    settled = true;
    if (prepared.lease?.node && proxyPool && !markedFailure) {
      proxyPool.markFailure(prepared.lease.node.id, error.message, { leaseId: prepared.lease.leaseId });
      markedFailure = true;
    }
    metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: error.message });
    if (!res.headersSent) {
      writeOpenAiError(res, 502, `Upstream error: ${error.message}`);
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  req.on("timeout", () => {
    if (settled || retryStarted) return;
    if (markedFailure) return;
    settled = true;
    req.destroy();
    if (prepared.lease?.node && proxyPool && !markedFailure) {
      proxyPool.markFailure(prepared.lease.node.id, "Upstream timeout", { statusCode: 504, leaseId: prepared.lease.leaseId });
      markedFailure = true;
    }
    metrics?.recordUpstream({ statusCode: 504, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "Upstream timeout" });
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Upstream timeout", type: "timeout_error" } }));
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  req.write(prepared.body);
  req.end();
};
