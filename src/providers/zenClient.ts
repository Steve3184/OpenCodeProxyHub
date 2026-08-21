import https from "node:https";
import type { ServerResponse } from "node:http";
import { ocId } from "../utils/ids.js";
import type { AppConfig } from "../config/env.js";
import type { ZenFullResponse } from "../types/api.js";
import type { ProxyLease, ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";
import { createTokenUsageAccumulator, estimateTokens, extractTokenUsage } from "../utils/tokenUsage.js";

const OC_VERSION = "1.15.0";
const noProxyAvailableError = "Proxy is required but no proxy node is available";

export interface ZenRequestInput {
  model: string;
  messages: unknown[];
  stream?: boolean;
  tools?: unknown[];
  toolChoice?: unknown;
  parameters?: Record<string, unknown>;
  sessionId: string;
}

export interface ZenPreparedRequest {
  body: string;
  options: https.RequestOptions;
  lease?: ProxyLease;
}

export const prepareZenRequest = (config: AppConfig, input: ZenRequestInput, proxyPool?: ProxyPoolStore, excludeProxyIds: ReadonlySet<string> = new Set()): ZenPreparedRequest => {
  const requestBody: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: Boolean(input.stream),
  };
  if (input.tools?.length) requestBody.tools = input.tools;
  if (input.toolChoice) requestBody.tool_choice = input.toolChoice;
  for (const [key, value] of Object.entries(input.parameters || {})) {
    if (value !== undefined) requestBody[key] = value;
  }

  const body = JSON.stringify(requestBody);
  const requestId = ocId("msg");

  const lease = proxyPool?.acquire(excludeProxyIds);
  return {
    body,
    options: {
      hostname: config.zenHost,
      port: 443,
      path: config.zenPath,
      method: "POST",
      headers: {
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
  retryAttempt = false,
): Promise<ZenFullResponse> => {
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
        const raw = Buffer.concat(chunks).toString();
        let data: any = null;
        try {
          data = JSON.parse(raw);
        } catch {
          // Preserve the raw upstream body for callers.
        }
        const status = zenRes.statusCode || 502;
        const protocolError = !data || Boolean(data.error) || data.type === "error";
        const rateLimited = status === 429 || raw.includes("FreeUsageLimitError") || raw.includes("rate_limit_error") || raw.toLowerCase().includes("rate limit");
        const effectiveErrorStatus = rateLimited ? 429 : (status >= 400 ? status : protocolError ? 502 : status);
        if (prepared.lease?.node && proxyPool) {
          if (rateLimited) proxyPool.markFailure(prepared.lease.node.id, "Upstream returned 429", { statusCode: 429, leaseId: prepared.lease.leaseId });
          else if (status >= 200 && status < 300 && !protocolError) {
            proxyPool.markSuccess(prepared.lease.node.id, prepared.lease.leaseId, status);
            const usage = extractTokenUsage(data);
            proxyPool.recordTokenUsage(prepared.lease.node.id, usage.totalTokens ?? estimateTokens(JSON.parse(prepared.body).messages) + estimateTokens(data?.choices?.[0]?.message?.content || ""));
          } else {
            proxyPool.markFailure(prepared.lease.node.id, `Upstream returned HTTP ${effectiveErrorStatus}`, { statusCode: effectiveErrorStatus, leaseId: prepared.lease.leaseId });
          }
        }
        metrics?.recordUpstream({ statusCode: effectiveErrorStatus, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
        if (rateLimited && !retryAttempt && retryPrepare && proxyPool && prepared.lease?.node?.id) {
          const excluded = new Set<string>();
          if (prepared.lease?.node?.id) excluded.add(prepared.lease.node.id);
          const retryPrepared = retryPrepare(excluded);
          if (retryPrepared.lease?.node || !retryPrepared.lease?.requiredUnavailable) {
            requestZenFull(retryPrepared, proxyPool, metrics, retryPrepare, true).then(resolve, reject);
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
  retryAttempt = false,
  responseModel?: string,
): void => {
  if (prepared.lease?.requiredUnavailable) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: noProxyAvailableError, type: "proxy_unavailable" } }));
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
  const nonStreamChunks: Buffer[] = [];
  const rewriteStreamChunk = (chunk: Buffer | string, flush = false): Buffer => {
    if (!responseModel || !stream) return Buffer.from(chunk);
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
        if (typeof parsed === "object" && parsed !== null) parsed.model = responseModel;
        return `${match[1]}${JSON.stringify(parsed)}${match[3] || ""}`;
      } catch {
        return line;
      }
    }).join("\n") + (complete.length ? "\n" : ""));
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
        const content = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
        if (typeof content === "string") observedOutputChars += content.length;
      } catch {
        // The next chunk may complete this JSON payload.
      }
    }
  };
  const retryRateLimited = (): boolean => {
    if (retryAttempt || !retryPrepare || !proxyPool || !prepared.lease?.node?.id || res.headersSent) return false;
    const excluded = new Set<string>();
    if (prepared.lease?.node?.id) excluded.add(prepared.lease.node.id);
    const retryPrepared = retryPrepare(excluded);
    if (retryPrepared.lease?.requiredUnavailable) return false;
    retryStarted = true;
    pipeZenOpenAIResponse(retryPrepared, stream, res, proxyPool, metrics, retryPrepare, true, responseModel);
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
      res.end(JSON.stringify({ error: { message: `Upstream error: ${message}`, type: "upstream_error" } }));
    }
  };
  let req: ReturnType<typeof https.request>;
  try {
    req = https.request(prepared.options, (zenRes) => {
    let firstChunk: Buffer | null = null;
    let headersSent = false;

    zenRes.on("data", (chunk: Buffer) => {
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
            const rateLimited = str.includes("FreeUsageLimitError") || str.includes("rate_limit_error") || str.toLowerCase().includes("rate limit");
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit exceeded";
              if (prepared.lease?.node && proxyPool && !markedFailure) {
                proxyPool.markFailure(prepared.lease.node.id, errMsg, { statusCode: rateLimited ? 429 : 502, leaseId: prepared.lease.leaseId });
                markedFailure = true;
              }
              if (rateLimited && retryRateLimited()) {
                settled = true;
                zenRes.resume();
                return;
              }
              settled = true;
              if (!res.headersSent) {
                const responseStatus = rateLimited ? 429 : 502;
                res.writeHead(responseStatus, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: rateLimited ? `${errMsg} (free model rate limit)` : errMsg, type: rateLimited ? "rate_limit_error" : "upstream_error", ...(rateLimited ? { code: "rate_limit_exceeded" } : {}) } }));
              }
              metrics?.recordUpstream({ statusCode: rateLimited ? 429 : 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
              zenRes.resume();
              return;
            }
          } catch {
            // Continue with normal passthrough.
          }
        }

        scanUsage(firstChunk);
        if (!stream) {
          // Buffer all non-stream responses so protocol errors and aliases are
          // handled from the complete JSON body before headers are sent.
          nonStreamChunks.push(firstChunk);
          return;
        }

        headersSent = true;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            "Transfer-Encoding": "chunked",
          });
        } else {
          res.writeHead(zenRes.statusCode || 502, { "Content-Type": "application/json" });
        }
        res.write(rewriteStreamChunk(firstChunk));
        return;
      }

      scanUsage(chunk);
      if (!stream) {
        nonStreamChunks.push(chunk);
        return;
      }
      if (headersSent) res.write(rewriteStreamChunk(chunk));
    });

    zenRes.on("end", () => {
      if (settled || retryStarted) return;
      settled = true;
      const status = zenRes.statusCode || 502;
      const nonStreamRaw = !stream ? Buffer.concat(nonStreamChunks).toString() : "";
      let nonStreamData: Record<string, unknown> | null = null;
      let protocolError = false;
      if (!stream) {
        try {
          const parsed = JSON.parse(nonStreamRaw);
          nonStreamData = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
          protocolError = !nonStreamData || Boolean(nonStreamData.error) || nonStreamData.type === "error";
          if (nonStreamData) usageAccumulator.observe(nonStreamData);
        } catch {
          protocolError = true;
        }
      }
      const errorBody = status >= 400 ? responseErrorBody : nonStreamRaw;
      const rateLimited = status === 429 || errorBody.includes("FreeUsageLimitError") || errorBody.includes("rate_limit_error") || errorBody.toLowerCase().includes("rate limit");
      if (status >= 400 || (!stream && protocolError)) {
        const parsed = (() => {
          try { return JSON.parse(errorBody); } catch { return null; }
        })();
        const errMsg = parsed?.error?.message || parsed?.message || (status >= 400 ? `Upstream returned HTTP ${status}` : "Invalid upstream response");
        if (prepared.lease?.node && proxyPool && !markedFailure) {
          proxyPool.markFailure(prepared.lease.node.id, errMsg, { statusCode: rateLimited ? 429 : (status >= 400 ? status : 502), leaseId: prepared.lease.leaseId });
          markedFailure = true;
        }
        if (rateLimited && retryRateLimited()) return;
        if (!res.headersSent) {
          const responseStatus = rateLimited ? 429 : (status >= 400 ? status : 502);
          res.writeHead(responseStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: rateLimited ? `${errMsg} (free model rate limit)` : errMsg, type: rateLimited ? "rate_limit_error" : "upstream_error", ...(rateLimited ? { code: "rate_limit_exceeded" } : {}) } }));
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
              const requestMessages = JSON.parse(prepared.body).messages;
              totalTokens = estimateTokens(requestMessages) + Math.ceil(observedOutputChars / 4);
            } catch {
              totalTokens = Math.ceil(observedOutputChars / 4);
            }
          }
          proxyPool.recordTokenUsage(prepared.lease.node.id, totalTokens);
        }
      }
      metrics?.recordUpstream({ statusCode: status, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });

      if (!stream) {
        let body = nonStreamRaw;
        if (nonStreamData && responseModel) {
          nonStreamData.model = responseModel;
          body = JSON.stringify(nonStreamData);
        }
        if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
        if (!res.writableEnded) res.end(body);
        return;
      }
      if (!headersSent && !firstChunk) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Empty response from upstream", type: "upstream_error" } }));
        }
        return;
      }
      if (headersSent) {
        if (responseModel && stream) res.write(rewriteStreamChunk("", true));
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
      res.end(JSON.stringify({ error: { message: `Upstream error: ${error.message}`, type: "upstream_error" } }));
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
      res.end(JSON.stringify({ error: { message: "Upstream timeout", type: "timeout_error" } }));
    }
  });

  try {
    req.write(prepared.body);
    req.end();
  } catch (error) {
    handleRequestSetupError(error);
  }
};
