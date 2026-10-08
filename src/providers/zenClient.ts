import https from "node:https";
import { SSE_RESPONSE_HEADERS } from "../utils/responseHeaders.js";
import type { ServerResponse } from "node:http";
import { ocId } from "../utils/ids.js";
import type { AppConfig } from "../config/env.js";
import type { ZenFullResponse } from "../types/api.js";
import type { ProxyLease, ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";
import { createTokenUsageAccumulator, estimateTokens, extractTokenUsage } from "../utils/tokenUsage.js";
import { normalizeResponsesRequest } from "../converters/openAiResponses.js";
import { aggregateUpstreamBody, type UpstreamProtocol } from "../converters/streamAggregator.js";
import { DownstreamToolCallFilter, ResponsesStreamToolFilter, applyToolFilterToChatCompletion, applyToolFilterToResponsesResponse, toUpstreamMessages, toUpstreamToolChoice, toUpstreamTools, type ToolNameMapper } from "../converters/toolMapping.js";
import { isOpenCodeProxyAccessError, isUpstreamRateLimitError, shouldRetryWithAnotherProxy } from "./opencodeAccessErrors.js";
import { EXO_FREE_CLAUDE_MAX_BACKEND_RETRIES, ExoStreamGate, classifyExoBackendFromAggregated, exoBackendMismatchMessage, isExoClaudeGateApplicable } from "./exoClaudeGate.js";

const OC_VERSION = "1.18.31";
const noProxyAvailableError = "Proxy is required but no proxy node is available";

export interface ZenRequestInput {
  model: string;
  messages?: unknown[];
  stream?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  parameters?: Record<string, unknown>;
  sessionId: string;
  protocol?: "chat_completions" | "responses" | "systemone";
  responseBody?: Record<string, unknown>;
  /** Maps the client's tool names to the upstream spelling and back. */
  toolMapper: ToolNameMapper;
}

export interface ZenPreparedRequest {
  body: string;
  options: https.RequestOptions;
  lease?: ProxyLease;
}

export interface ZenStreamTransform {
  write(chunk: Buffer): Buffer;
  flush(): Buffer;
  errorBody?: (message: string, rateLimited: boolean) => unknown;
}

const requestInputForTokenEstimate = (body: string): unknown => {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return parsed.messages ?? parsed.input ?? parsed.instructions ?? parsed.state ?? parsed.questions ?? "";
  } catch {
    return "";
  }
};

const responseTextForTokenEstimate = (data: any): unknown => {
  const chatText = data?.choices?.[0]?.message?.content;
  if (chatText !== undefined) return chatText;
  if (Array.isArray(data?.output)) {
    return data.output.map((item: any) => item?.content ?? item?.arguments ?? "");
  }
  return "";
};

export const prepareZenRequest = (config: AppConfig, input: ZenRequestInput, proxyPool?: ProxyPoolStore, excludeProxyIds: ReadonlySet<string> = new Set()): ZenPreparedRequest => {
  const protocol = input.protocol || "chat_completions";
  const mapper = input.toolMapper;
  let requestBody: Record<string, unknown>;
  if (protocol === "systemone") {
    requestBody = { ...(input.responseBody || {}), model: input.model };
  } else if (protocol === "responses") {
    requestBody = normalizeResponsesRequest({
      ...(input.responseBody || {}),
      model: input.model,
    }, mapper);
    // The upstream gate requires streaming, so the body always asks for it and
    // the caller's own preference is tracked separately.
    requestBody.stream = true;
    requestBody.tools = toUpstreamTools(requestBody.tools, mapper, "responses");
  } else {
    requestBody = {
      model: input.model,
      messages: toUpstreamMessages(input.messages || [], mapper),
      // The upstream gate requires streaming, so the body always asks for it and
      // the caller's own preference is tracked separately.
      stream: true,
    };
    // Unconditional: the gate demands both declarations even when the client
    // declared no tools at all, so the placeholders must still be injected.
    requestBody.tools = toUpstreamTools(input.tools, mapper, "chat");
    if (input.toolChoice) requestBody.tool_choice = toUpstreamToolChoice(input.toolChoice, mapper);
    for (const [key, value] of Object.entries(input.parameters || {})) {
      if (value !== undefined) requestBody[key] = value;
    }
  }

  const body = JSON.stringify(requestBody);
  const requestId = ocId("msg");

  const lease = proxyPool?.acquire(excludeProxyIds, input.model);
  return {
    body,
    options: {
      hostname: config.zenHost,
      port: 443,
      path: protocol === "responses"
        ? config.zenResponsesPath
        : protocol === "systemone" ? config.zenSystemonePath : config.zenPath,
      method: "POST",
      headers: {
        "Accept-Encoding": "identity",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: "Bearer public",
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": input.sessionId,
      },
      ...(lease?.agent ? { agent: lease.agent } : {}),
      timeout: config.upstreamTimeoutMs,
    },
    lease,
  };
};

export const requestZenFull = (
  prepared: ZenPreparedRequest,
  proxyPool?: ProxyPoolStore,
  metrics?: MetricsStore,
  retryPrepare?: (excludeProxyIds: ReadonlySet<string>) => ZenPreparedRequest,
  retryCount = 0,
  protocol: UpstreamProtocol = "chat_completions",
  maxRetries = 1,
  exoRetryCount = 0,
): Promise<ZenFullResponse> => {
  const exoGated = isExoClaudeGateApplicable(prepared.body, protocol === "responses");
  return new Promise((resolve, reject) => {
    if (prepared.lease?.requiredUnavailable) {
      reject(new Error(noProxyAvailableError));
      return;
    }
    const started = process.hrtime.bigint();
    const durationMs = () => Number(process.hrtime.bigint() - started) / 1_000_000;
    let settled = false;
    let req: ReturnType<typeof https.request>;
    try {
      req = https.request(prepared.options, (zenRes) => {
      const chunks: Buffer[] = [];
      zenRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      zenRes.on("end", () => {
        if (settled) return;
        settled = true;
        const upstreamRaw = Buffer.concat(chunks).toString();
        // The upstream always streams, so a successful body is SSE. Fold it back
        // into the complete JSON document the caller expects; error bodies and
        // non-SSE replies are passed through as-is.
        const aggregated = aggregateUpstreamBody(upstreamRaw, protocol);
        const data: any = aggregated;
        const raw = aggregated ? JSON.stringify(aggregated) : upstreamRaw;
        const status = zenRes.statusCode || 502;
        const protocolError = !data || Boolean(data.error) || data.type === "error";
        const rateLimited = isUpstreamRateLimitError(status, raw);
        const proxyAccessError = isOpenCodeProxyAccessError(status, raw);
        const retryableProxyError = rateLimited || proxyAccessError;
        const effectiveErrorStatus = rateLimited ? 429 : (status >= 400 ? status : protocolError ? 502 : status);
        // exo-free only: a GPT backend (resp_ id) is a valid reply, but the
        // caller asked for Claude, so discard it and retry with a fresh
        // x-opencode-request until the Claude backend answers.
        if (exoGated && status >= 200 && status < 300 && !protocolError && classifyExoBackendFromAggregated(data) === "gpt") {
          if (prepared.lease?.node && proxyPool) proxyPool.release(prepared.lease.node.id, prepared.lease.leaseId);
          if (exoRetryCount < EXO_FREE_CLAUDE_MAX_BACKEND_RETRIES && retryPrepare) {
            const retryPrepared = retryPrepare(new Set());
            requestZenFull(retryPrepared, proxyPool, metrics, retryPrepare, retryCount, protocol, maxRetries, exoRetryCount + 1).then(resolve, reject);
            return;
          }
          metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "exo-free non-Claude backend" });
          resolve({ status: 502, data: { error: { message: exoBackendMismatchMessage(exoRetryCount + 1), type: "upstream_error" } }, raw: "" });
          return;
        }
        if (prepared.lease?.node && proxyPool) {
          if (rateLimited) proxyPool.markFailure(prepared.lease.node.id, "Upstream returned 429", { statusCode: 429, leaseId: prepared.lease.leaseId });
          else if (status >= 200 && status < 300 && !protocolError) {
            proxyPool.markSuccess(prepared.lease.node.id, prepared.lease.leaseId, status);
            const usage = extractTokenUsage(data);
            proxyPool.recordTokenUsage(prepared.lease.node.id, usage.totalTokens ?? estimateTokens(requestInputForTokenEstimate(prepared.body)) + estimateTokens(responseTextForTokenEstimate(data)));
          } else {
            proxyPool.markFailure(prepared.lease.node.id, `Upstream returned HTTP ${effectiveErrorStatus}`, { statusCode: effectiveErrorStatus, leaseId: prepared.lease.leaseId });
          }
        }
        metrics?.recordUpstream({ statusCode: effectiveErrorStatus, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
        if (retryableProxyError && retryCount < maxRetries && retryPrepare && proxyPool && prepared.lease?.node?.id) {
          const excluded = new Set<string>([prepared.lease.node.id]);
          const retryPrepared = retryPrepare(excluded);
          if (retryPrepared.lease?.node || !retryPrepared.lease?.requiredUnavailable) {
            const nextRetryPrepare = (additional: ReadonlySet<string>) => {
              const allExcluded = new Set(excluded);
              for (const id of additional) allExcluded.add(id);
              return retryPrepare(allExcluded);
            };
            requestZenFull(retryPrepared, proxyPool, metrics, nextRetryPrepare, retryCount + 1, protocol, maxRetries).then(resolve, reject);
            return;
          }
        }
        try {
          resolve({ status, data, raw });
        } catch {
          resolve({ status, data: null, raw });
        }
      });
      });
    } catch (error) {
      settled = true;
      const message = error instanceof Error ? error.message : "Failed to create upstream request";
      if (prepared.lease?.node && proxyPool) proxyPool.markFailure(prepared.lease.node.id, message, { statusCode: 502, leaseId: prepared.lease.leaseId });
      metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: message });
      reject(error instanceof Error ? error : new Error(message));
      return;
    }

    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (prepared.lease?.node && proxyPool) proxyPool.markFailure(prepared.lease.node.id, error.message, { leaseId: prepared.lease.leaseId });
      metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: error.message });
      reject(error);
    });
    req.on("timeout", () => {
      if (settled) return;
      settled = true;
      req.destroy();
      if (prepared.lease?.node && proxyPool) proxyPool.markFailure(prepared.lease.node.id, "Upstream timeout", { statusCode: 504, leaseId: prepared.lease.leaseId });
      metrics?.recordUpstream({ statusCode: 504, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "Upstream timeout" });
      reject(new Error("Upstream timeout"));
    });
    try {
      req.write(prepared.body);
      req.end();
    } catch (error) {
      if (!settled) {
        settled = true;
        const message = error instanceof Error ? error.message : "Failed to write upstream request";
        if (prepared.lease?.node && proxyPool) proxyPool.markFailure(prepared.lease.node.id, message, { statusCode: 502, leaseId: prepared.lease.leaseId });
        metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: message });
        reject(error instanceof Error ? error : new Error(message));
      }
    }
  });
};

export const pipeZenOpenAIResponse = (
  prepared: ZenPreparedRequest,
  stream: boolean,
  res: ServerResponse,
  proxyPool?: ProxyPoolStore,
  metrics?: MetricsStore,
  retryPrepare?: (excludeProxyIds: ReadonlySet<string>) => ZenPreparedRequest,
  retryCount = 0,
  responseModel?: string,
  streamTransform?: ZenStreamTransform,
  toolMapper?: ToolNameMapper,
  responsesProtocol = false,
  maxRetries = 1,
  exoRetryCount = 0,
): void => {
  if (prepared.lease?.requiredUnavailable) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(streamTransform?.errorBody?.(noProxyAvailableError, false) ?? { error: { message: noProxyAvailableError, type: "proxy_unavailable" } }));
    return;
  }
  const started = process.hrtime.bigint();
  const durationMs = () => Number(process.hrtime.bigint() - started) / 1_000_000;
  let markedFailure = false;
  let retryStarted = false;
  let settled = false;
  let scanBuffer = "";
  const usageAccumulator = createTokenUsageAccumulator();
  let observedOutputChars = 0;
  let responseErrorBody = "";
  let responseRewriteBuffer = "";
  // Upstream always streams; a non-streaming caller gets the stream folded back
  // into a single JSON body once the upstream has finished.
  const aggregateUpstream = !stream;
  const nonStreamChunks: Buffer[] = [];
  const toolCallFilter = toolMapper ? new DownstreamToolCallFilter(toolMapper) : undefined;
  const responsesToolFilter = toolMapper && responsesProtocol ? new ResponsesStreamToolFilter(toolMapper) : undefined;
  const errorBody = (message: string, rateLimited: boolean): string => JSON.stringify(
    streamTransform?.errorBody?.(message, rateLimited) ?? {
      error: {
        message,
        type: rateLimited ? "rate_limit_error" : "upstream_error",
        ...(rateLimited ? { code: "rate_limit_exceeded" } : {}),
      },
    },
  );
  const rewriteStreamChunk = (chunk: Buffer | string, flush = false): Buffer => {
    if (!stream || (!responseModel && !toolCallFilter)) return Buffer.from(chunk);
    responseRewriteBuffer += chunk.toString();
    const lines = responseRewriteBuffer.split(/\n/);
    const remainder = lines.pop() || "";
    const complete = flush ? lines.concat(remainder ? [remainder] : []) : lines;
    responseRewriteBuffer = flush ? "" : remainder;
    return Buffer.from(complete.map((line) => {
      const match = line.match(/^(data:\s*)(.*?)(\r?)$/);
      if (!match || !match[2] || match[2] === "[DONE]") return line;
      try {
        const parsed = JSON.parse(match[2]) as Record<string, unknown>;
        if (typeof parsed === "object" && parsed !== null) {
          if (responseModel) {
            parsed.model = responseModel;
            const response = parsed.response;
            if (response && typeof response === "object" && !Array.isArray(response)) {
              (response as Record<string, unknown>).model = responseModel;
            }
          }
          // The upstream reply carries the upstream spelling (`bash`); restore
          // the caller's own spelling (`Bash`) and drop placeholder calls.
          if (toolCallFilter) toolCallFilter.applyChunk(parsed);
        }
        return `${match[1]}${JSON.stringify(parsed)}${match[3] || ""}`;
      } catch {
        return line;
      }
    }).join("\n") + (complete.length ? "\n" : ""));
  };
  // Only used on the Responses passthrough path, where the upstream events are
  // forwarded verbatim and placeholder tool calls have to be filtered out.
  let responsesFilterBuffer = "";
  const filterResponsesChunk = (chunk: Buffer | string, flush = false): Buffer => {
    responsesFilterBuffer += chunk.toString();
    const lines = responsesFilterBuffer.split(/\n/);
    const remainder = lines.pop() || "";
    const complete = flush ? lines.concat(remainder ? [remainder] : []) : lines;
    responsesFilterBuffer = flush ? "" : remainder;
    const out: string[] = [];
    for (const line of complete) {
      const match = line.match(/^(data:\s*)(.*?)(\r?)$/);
      if (!match || !match[2] || match[2] === "[DONE]") {
        out.push(line);
        continue;
      }
      try {
        const parsed = JSON.parse(match[2]) as Record<string, unknown>;
        const filtered = responsesToolFilter?.applyPayload(parsed) ?? parsed;
        if (filtered === null) continue;
        if (responseModel) {
          filtered.model = responseModel;
          const response = filtered.response;
          if (response && typeof response === "object" && !Array.isArray(response)) {
            (response as Record<string, unknown>).model = responseModel;
          }
        }
        out.push(`${match[1]}${JSON.stringify(filtered)}${match[3] || ""}`);
      } catch {
        out.push(line);
      }
    }
    return Buffer.from(out.join("\n") + (complete.length ? "\n" : ""));
  };
  const transformStreamChunk = (chunk: Buffer | string, flush = false): Buffer => {
    if (streamTransform) return flush ? streamTransform.flush() : streamTransform.write(Buffer.from(chunk));
    if (responsesToolFilter) return filterResponsesChunk(chunk, flush);
    return rewriteStreamChunk(chunk, flush);
  };
  const scanUsage = (chunk: Buffer | string) => {
    scanBuffer += chunk.toString();
    const lines = scanBuffer.split("\n");
    scanBuffer = lines.pop() || "";
    for (const line of lines) {
      const payload = line.startsWith("data: ") ? line.slice(6).trim() : line.trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        usageAccumulator.observe(parsed);
        const content = parsed.choices?.[0]?.delta?.content
          ?? parsed.choices?.[0]?.message?.content
          ?? (typeof parsed.delta === "string" ? parsed.delta : undefined);
        if (typeof content === "string") observedOutputChars += content.length;
      } catch {
        // The next chunk may complete this JSON payload.
      }
    }
  };
  const retryWithAnotherProxy = (): boolean => {
    if (retryCount >= maxRetries || !retryPrepare || !proxyPool || !prepared.lease?.node?.id || res.headersSent) return false;
    const excluded = new Set<string>([prepared.lease.node.id]);
    const retryPrepared = retryPrepare(excluded);
    if (retryPrepared.lease?.requiredUnavailable) return false;
    retryStarted = true;
    res.setMaxListeners(0);
    const nextRetryPrepare = (additional: ReadonlySet<string>) => {
      const allExcluded = new Set(excluded);
      for (const id of additional) allExcluded.add(id);
      return retryPrepare(allExcluded);
    };
    pipeZenOpenAIResponse(retryPrepared, stream, res, proxyPool, metrics, nextRetryPrepare, retryCount + 1, responseModel, streamTransform, toolMapper, responsesProtocol, maxRetries);
    return true;
  };
  const handleRequestSetupError = (error: unknown): void => {
    if (settled || retryStarted) return;
    settled = true;
    markedFailure = true;
    const message = error instanceof Error ? error.message : "Failed to create upstream request";
    if (prepared.lease?.node && proxyPool) proxyPool.markFailure(prepared.lease.node.id, message, { statusCode: 502, leaseId: prepared.lease.leaseId });
    metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: message });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(errorBody(`Upstream error: ${message}`, false));
    }
  };
  // exo-free only: hold the stream until the first id reveals the backend.
  // `msg_` (Claude) flushes the buffered chunks downstream; `resp_` (GPT)
  // aborts and retries with a fresh x-opencode-request.
  const exoGated = isExoClaudeGateApplicable(prepared.body, responsesProtocol);
  const exoGate = exoGated && stream ? new ExoStreamGate() : undefined;
  const retryExoBackend = (): boolean => {
    if (exoRetryCount >= EXO_FREE_CLAUDE_MAX_BACKEND_RETRIES || !retryPrepare || res.headersSent) return false;
    if (prepared.lease?.node && proxyPool) proxyPool.release(prepared.lease.node.id, prepared.lease.leaseId);
    retryStarted = true;
    // Each retry re-registers close/finish listeners; lift the default cap.
    res.setMaxListeners(0);
    const retryPrepared = retryPrepare(new Set());
    pipeZenOpenAIResponse(retryPrepared, stream, res, proxyPool, metrics, retryPrepare, retryCount, responseModel, streamTransform, toolMapper, responsesProtocol, maxRetries, exoRetryCount + 1);
    return true;
  };
  let req: ReturnType<typeof https.request>;
  try {
    req = https.request(prepared.options, (zenRes) => {
    let firstChunk: Buffer | null = null;
    let headersSent = false;

    const processChunk = (chunk: Buffer): void => {
      if (settled || retryStarted) return;
      const status = zenRes.statusCode || 502;
      if (status >= 400) {
        responseErrorBody += chunk.toString();
        return;
      }
      if (!firstChunk) {
        firstChunk = chunk;
        const str = chunk.toString().trim();
        if (str.startsWith("{")) {
          try {
            const parsed = JSON.parse(str);
            const rateLimited = isUpstreamRateLimitError(status, str);
            const proxyAccessError = isOpenCodeProxyAccessError(status, str);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit exceeded";
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
                res.end(errorBody(rateLimited ? `${errMsg} (free model rate limit)` : errMsg, rateLimited));
              }
              metrics?.recordUpstream({ statusCode: rateLimited ? 429 : proxyAccessError ? 403 : 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
              zenRes.resume();
              return;
            }
          } catch {
            // Continue with normal passthrough.
          }
        }

        scanUsage(firstChunk);
        if (aggregateUpstream) {
          // Buffer the upstream stream so protocol errors and aliases are
          // handled from the complete response before headers are sent.
          nonStreamChunks.push(firstChunk);
          return;
        }

        headersSent = true;
        res.writeHead(200, SSE_RESPONSE_HEADERS);
        res.write(transformStreamChunk(firstChunk));
        return;
      }

      scanUsage(chunk);
      if (aggregateUpstream) {
        nonStreamChunks.push(chunk);
        return;
      }
      if (headersSent) res.write(transformStreamChunk(chunk));
    };

    zenRes.on("data", (chunk: Buffer) => {
      if (!exoGate || exoGate.decided) {
        processChunk(chunk);
        return;
      }
      // Hold chunks until the backend is known; on Claude, replay them through
      // the normal pipeline; on GPT, abort the request and retry.
      if (settled || retryStarted) return;
      const decision = exoGate.push(chunk);
      if (decision === "pending") return;
      if (decision === "gpt") {
        settled = true;
        zenRes.resume();
        if (!retryExoBackend()) {
          metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "exo-free non-Claude backend" });
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(errorBody(exoBackendMismatchMessage(exoRetryCount + 1), false));
          }
        }
        return;
      }
      for (const buffered of exoGate.drain()) processChunk(buffered);
    });

    zenRes.on("end", () => {
      if (settled || retryStarted) return;
      // A stream that ended before the backend was decided (no classifiable id
      // at all): fail open and replay whatever was buffered.
      if (exoGate && !exoGate.decided) {
        for (const buffered of exoGate.drain()) processChunk(buffered);
      }
      if (settled || retryStarted) return;
      settled = true;
      const status = zenRes.statusCode || 502;
      const upstreamBody = aggregateUpstream ? Buffer.concat(nonStreamChunks).toString() : "";
      // The upstream streams even for non-streaming callers, so fold the SSE
      // body back into the complete JSON document they expect.
      let nonStreamData: Record<string, unknown> | null = null;
      let protocolError = false;
      if (aggregateUpstream && status < 400) {
        nonStreamData = aggregateUpstreamBody(upstreamBody, responsesProtocol ? "responses" : "chat_completions");
        protocolError = !nonStreamData || Boolean(nonStreamData.error) || nonStreamData.type === "error";
        if (nonStreamData) usageAccumulator.observe(nonStreamData);
      }
      // exo-free non-stream caller: the GPT backend must be rejected too.
      if (exoGated && aggregateUpstream && !protocolError && nonStreamData
        && classifyExoBackendFromAggregated(nonStreamData) === "gpt") {
        if (retryExoBackend()) return;
        metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "exo-free non-Claude backend" });
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(errorBody(exoBackendMismatchMessage(exoRetryCount + 1), false));
        }
        return;
      }
      const upstreamErrorRaw = status >= 400 ? responseErrorBody : upstreamBody;
      const rateLimited = isUpstreamRateLimitError(status, upstreamErrorRaw);
      const proxyAccessError = isOpenCodeProxyAccessError(status, upstreamErrorRaw);
      if (status >= 400 || (aggregateUpstream && protocolError)) {
        const parsed = (() => {
          try { return JSON.parse(upstreamErrorRaw); } catch { return null; }
        })();
        const errMsg = parsed?.error?.message || parsed?.message || (status >= 400 ? `Upstream returned HTTP ${status}` : "Invalid upstream response");
        if (prepared.lease?.node && proxyPool && !markedFailure) {
          proxyPool.markFailure(prepared.lease.node.id, errMsg, { statusCode: rateLimited ? 429 : (status >= 400 ? status : 502), leaseId: prepared.lease.leaseId });
          markedFailure = true;
        }
        if ((rateLimited || proxyAccessError) && retryWithAnotherProxy()) return;
        if (!res.headersSent) {
          const responseStatus = rateLimited ? 429 : (status >= 400 ? status : 502);
          res.writeHead(responseStatus, { "Content-Type": "application/json" });
          res.end(errorBody(rateLimited ? `${errMsg} (free model rate limit)` : errMsg, rateLimited));
        }
        metrics?.recordUpstream({ statusCode: rateLimited ? 429 : (status >= 400 ? status : 502), durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
        return;
      }
      if (prepared.lease?.node && proxyPool && !markedFailure) {
        if (status >= 200 && status < 300) {
          proxyPool.markSuccess(prepared.lease.node.id, prepared.lease.leaseId, status);
        } else {
          proxyPool.markFailure(prepared.lease.node.id, `Upstream returned HTTP ${status}`, { statusCode: status, leaseId: prepared.lease.leaseId });
          markedFailure = true;
        }
        if (status >= 200 && status < 300) {
          if (scanBuffer.trim()) {
            try { usageAccumulator.observe(JSON.parse(scanBuffer.trim())); } catch { /* use fallback estimate */ }
          }
          let totalTokens = usageAccumulator.totalTokens();
          if (totalTokens === null) {
            try {
              totalTokens = estimateTokens(requestInputForTokenEstimate(prepared.body)) + Math.ceil(observedOutputChars / 4);
            } catch {
              totalTokens = Math.ceil(observedOutputChars / 4);
            }
          }
          proxyPool.recordTokenUsage(prepared.lease.node.id, totalTokens);
        }
      }
      metrics?.recordUpstream({ statusCode: status, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });

      if (aggregateUpstream) {
        if (nonStreamData) {
          // Tool names come back in the upstream spelling; restore the caller's.
          if (toolMapper && responsesProtocol) applyToolFilterToResponsesResponse(nonStreamData, toolMapper);
          else if (toolMapper) applyToolFilterToChatCompletion(nonStreamData, toolMapper);
          if (responseModel) {
            nonStreamData.model = responseModel;
            const response = nonStreamData.response;
            if (response && typeof response === "object" && !Array.isArray(response)) {
              (response as Record<string, unknown>).model = responseModel;
            }
          }
        }
        const body = nonStreamData ? JSON.stringify(nonStreamData) : upstreamBody;
        if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
        if (!res.writableEnded) res.end(body);
        return;
      }
      if (!headersSent && !firstChunk) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(errorBody("Empty response from upstream", false));
        }
        return;
      }
      if (headersSent) {
        if (streamTransform || responseModel || responsesToolFilter) res.write(transformStreamChunk("", true));
        if (!res.writableEnded) res.end();
      }
    });
    });
  } catch (error) {
    handleRequestSetupError(error);
    return;
  }

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
    if (prepared.lease?.node && proxyPool && !markedFailure) proxyPool.markFailure(prepared.lease.node.id, error.message, { leaseId: prepared.lease.leaseId });
    markedFailure = true;
    metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: error.message });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(errorBody(`Upstream error: ${error.message}`, false));
    }
  });

  req.on("timeout", () => {
    if (settled || retryStarted) return;
    if (markedFailure) return;
    settled = true;
    req.destroy();
    if (prepared.lease?.node && proxyPool && !markedFailure) proxyPool.markFailure(prepared.lease.node.id, "Upstream timeout", { statusCode: 504, leaseId: prepared.lease.leaseId });
    markedFailure = true;
    metrics?.recordUpstream({ statusCode: 504, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "Upstream timeout" });
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(errorBody("Upstream timeout", false));
    }
  });

  try {
    req.write(prepared.body);
    req.end();
  } catch (error) {
    handleRequestSetupError(error);
  }
};
