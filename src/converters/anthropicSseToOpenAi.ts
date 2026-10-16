import { SSE_RESPONSE_HEADERS } from "../utils/responseHeaders.js";
import https from "node:https";
import { readUpstreamResponse } from "../providers/upstreamResponse.js";
import type { ServerResponse } from "node:http";
import { registerResponseAttempt } from "../runtime/responseLifecycle.js";
import { ocId } from "../utils/ids.js";
import type { ZenPreparedRequest } from "../providers/zenClient.js";
import type { ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";
import { createTokenUsageAccumulator } from "../utils/tokenUsage.js";
import type { ToolNameMapper } from "./toolMapping.js";

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
  /** Set once the upstream ended with only dropped placeholder tool calls. */
  sawDroppedToolCall: boolean;
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
  sawDroppedToolCall: false,
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
  res.writeHead(200, SSE_RESPONSE_HEADERS);
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

const writeOpenAiError = (res: ServerResponse, statusCode: number, message: string): void => {
  if (res.headersSent) return;
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "upstream_error" } }));
};

const handleParsedPayload = (state: TransformState, res: ServerResponse, parsed: any, toolMapper?: ToolNameMapper): void => {
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
    const name = toolMapper ? toolMapper.toDownstream(parsed.content_block.name) : parsed.content_block.name;
    if (name === undefined) {
      // Placeholder tool the client never declared: drop the whole block.
      state.sawDroppedToolCall = true;
      state.blockToToolIndex.set(blockIndex, -1);
      return;
    }
    const toolIndex = state.nextToolIndex;
    state.nextToolIndex += 1;
    state.blockToToolIndex.set(blockIndex, toolIndex);
    state.sawToolCall = true;
    writeSse(res, openAiChunk(state, {
      tool_calls: [{
        index: toolIndex,
        id: parsed.content_block.id || ocId("toolu"),
        type: "function",
        function: { name, arguments: "" },
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
      if (toolIndex === -1) return;
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
    // Only dropped placeholders were emitted: the turn simply ends.
    else if (!state.sawToolCall && state.sawDroppedToolCall && state.stopReason === "tool_calls") state.stopReason = "stop";
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
  retryCount = 0,
  toolMapper?: ToolNameMapper,
  maxRetries = 1,
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
    pipeAnthropicSseAsOpenAI(retryPrepared, model, res, proxyPool, metrics, nextRetryPrepare, retryCount + 1, toolMapper, maxRetries);
    return true;
  };

  const req = https.request(prepared.options, (zenRes) => {
    readUpstreamResponse(zenRes, (chunk) => {
      if (settled || retryStarted) return;
      receivedData = true;
      buffer += chunk.toString();

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
          handleParsedPayload(state, res, parsed, toolMapper);
        } catch {
          // Ignore malformed SSE payloads rather than corrupting the OpenAI stream.
        }
      }
    }, () => {
      if (settled || retryStarted) return;
      settled = true;
      const status = zenRes.statusCode || 502;
      if (prepared.lease?.node && proxyPool && !markedFailure) {
        if (status >= 200 && status < 300) proxyPool.markSuccess(prepared.lease.node.id, prepared.lease.leaseId, status);
        else {
          proxyPool.markFailure(prepared.lease.node.id, `Upstream returned HTTP ${status}`, { statusCode: status, leaseId: prepared.lease.leaseId });
          markedFailure = true;
        }
        const inputTokens = Math.ceil(prepared.body.length / 4);
        if (status >= 200 && status < 300) proxyPool.recordTokenUsage(prepared.lease.node.id, usageAccumulator.totalTokens() ?? (inputTokens + Math.ceil(observedOutputChars / 4)));
      }
      metrics?.recordUpstream({ statusCode: status, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });

      if (!receivedData && !res.headersSent) {
        writeOpenAiError(res, 502, "Empty response from upstream");
        return;
      }
      if (!state.doneSent && !res.writableEnded) sendDone(state, res);
      if (!res.writableEnded) res.end();
    }, (failure) => {
      if (settled || retryStarted) return;
      settled = true;
      if (prepared.lease?.node && proxyPool && !markedFailure) {
        proxyPool.markFailure(prepared.lease.node.id, failure.message, {
          statusCode: failure.statusCode, leaseId: prepared.lease.leaseId, upstreamBody: failure.body,
        });
        markedFailure = true;
      }
      metrics?.recordUpstream({ statusCode: failure.statusCode, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
      if ((failure.rateLimited || failure.proxyAccessError) && retryRateLimited()) return;
      const body = JSON.stringify({ error: { message: failure.message, type: failure.rateLimited ? "rate_limit_error" : "upstream_error", ...(failure.rateLimited ? { code: "rate_limit_exceeded" } : {}) } });
      if (!res.headersSent) {
        res.writeHead(failure.statusCode, { "Content-Type": "application/json" });
        res.end(body);
      } else if (!res.writableEnded) {
        res.end(`event: error\ndata: ${body}\n\n`);
      }
    });
  });

  registerResponseAttempt(res, () => {
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
