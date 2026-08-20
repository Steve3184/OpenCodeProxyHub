import https from "node:https";
import type { ServerResponse } from "node:http";
import { ocId } from "../utils/ids.js";
import type { AppConfig } from "../config/env.js";
import type { ZenFullResponse } from "../types/api.js";
import type { ProxyLease, ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";
import { estimateTokens, extractTokenUsage } from "../utils/tokenUsage.js";

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
    const req = https.request(prepared.options, (zenRes) => {
      const chunks: Buffer[] = [];
      zenRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let data: any = null;
        try {
          data = JSON.parse(raw);
        } catch {
          // Preserve the raw upstream body for callers.
        }
        const status = zenRes.statusCode || 502;
        const rateLimited = status === 429 || raw.includes("FreeUsageLimitError") || raw.includes("rate_limit_error");
        if (prepared.lease?.node && proxyPool) {
          if (rateLimited) proxyPool.markFailure(prepared.lease.node.id, "Upstream returned 429", { statusCode: 429 });
          else {
            proxyPool.markSuccess(prepared.lease.node.id);
            const usage = extractTokenUsage(data);
            proxyPool.recordTokenUsage(prepared.lease.node.id, usage.totalTokens ?? estimateTokens(JSON.parse(prepared.body).messages) + estimateTokens(data?.choices?.[0]?.message?.content || ""));
          }
        }
        metrics?.recordUpstream({ statusCode: status, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
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

    req.on("error", (error) => {
      if (prepared.lease?.node && proxyPool) proxyPool.markFailure(prepared.lease.node.id, error.message);
      metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: error.message });
      reject(error);
    });
    req.on("timeout", () => {
      req.destroy();
      if (prepared.lease?.node && proxyPool) proxyPool.markFailure(prepared.lease.node.id, "Upstream timeout");
      metrics?.recordUpstream({ statusCode: 504, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "Upstream timeout" });
      reject(new Error("Upstream timeout"));
    });
    req.write(prepared.body);
    req.end();
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
  let scanBuffer = "";
  let observedTotalTokens: number | null = null;
  let observedUsageTokens = 0;
  let observedUsage = false;
  let observedOutputChars = 0;
  let rateLimitBody = "";
  const scanUsage = (chunk: Buffer | string) => {
    scanBuffer += chunk.toString();
    const lines = scanBuffer.split("\n");
    scanBuffer = lines.pop() || "";
    for (const line of lines) {
      const payload = line.startsWith("data: ") ? line.slice(6).trim() : line.trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        const usage = extractTokenUsage(parsed);
        if (usage.totalTokens !== null) {
          observedUsage = true;
          if (usage.inputTokens > 0 && usage.outputTokens > 0) observedTotalTokens = usage.totalTokens;
          else observedUsageTokens += usage.totalTokens;
        }
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
    pipeZenOpenAIResponse(retryPrepared, stream, res, proxyPool, metrics, retryPrepare, true);
    return true;
  };
  const req = https.request(prepared.options, (zenRes) => {
    let firstChunk: Buffer | null = null;
    let headersSent = false;

    zenRes.on("data", (chunk: Buffer) => {
      if (zenRes.statusCode === 429) {
        rateLimitBody += chunk.toString();
        return;
      }
      if (!firstChunk) {
        firstChunk = chunk;
        const str = chunk.toString().trim();
        if (zenRes.statusCode === 429 || (str.startsWith("{") && (str.includes("FreeUsageLimitError") || str.includes("rate_limit_error") || str.toLowerCase().includes("rate limit")))) {
          try {
            const parsed = JSON.parse(str);
            if (zenRes.statusCode === 429 || parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit exceeded";
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
                res.end(JSON.stringify({ error: { message: `${errMsg} (free model rate limit)`, type: "rate_limit_error", code: "rate_limit_exceeded" } }));
              }
              zenRes.resume();
              return;
            }
          } catch {
            // Continue with normal passthrough.
          }
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
        scanUsage(firstChunk);
        res.write(firstChunk);
        return;
      }

      scanUsage(chunk);
      if (headersSent) res.write(chunk);
    });

    zenRes.on("end", () => {
      if (retryStarted) return;
      if ((zenRes.statusCode || 502) === 429) {
        const parsed = (() => {
          try { return JSON.parse(rateLimitBody); } catch { return null; }
        })();
        const errMsg = parsed?.error?.message || parsed?.message || "Rate limit exceeded";
        if (prepared.lease?.node && proxyPool) {
          proxyPool.markFailure(prepared.lease.node.id, errMsg, { statusCode: 429 });
          markedFailure = true;
        }
        if (retryRateLimited()) return;
        if (!res.headersSent) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: `${errMsg} (free model rate limit)`, type: "rate_limit_error", code: "rate_limit_exceeded" } }));
        }
        metrics?.recordUpstream({ statusCode: 429, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
        return;
      }
      if (prepared.lease?.node && proxyPool && !markedFailure) {
        proxyPool.markSuccess(prepared.lease.node.id);
        let totalTokens = observedTotalTokens ?? (observedUsage ? observedUsageTokens : null);
        if (totalTokens === null && scanBuffer.trim()) {
          try {
            const usage = extractTokenUsage(JSON.parse(scanBuffer.trim()));
              totalTokens = usage.totalTokens;
          } catch {
            // Use the conservative request/visible-output estimate below.
          }
        }
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
      metrics?.recordUpstream({ statusCode: zenRes.statusCode || 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
      if (!headersSent && !firstChunk) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Empty response from upstream", type: "upstream_error" } }));
        }
        return;
      }
      if (headersSent) res.end();
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
      res.end(JSON.stringify({ error: { message: `Upstream error: ${error.message}`, type: "upstream_error" } }));
    }
  });

  req.on("timeout", () => {
    if (retryStarted) return;
    req.destroy();
    if (prepared.lease?.node && proxyPool && !markedFailure) proxyPool.markFailure(prepared.lease.node.id, "Upstream timeout");
    metrics?.recordUpstream({ statusCode: 504, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: "Upstream timeout" });
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Upstream timeout", type: "timeout_error" } }));
    }
  });

  req.write(prepared.body);
  req.end();
};
