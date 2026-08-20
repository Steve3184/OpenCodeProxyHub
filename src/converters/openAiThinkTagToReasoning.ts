import https from "node:https";
import type { ServerResponse } from "node:http";
import type { ZenPreparedRequest } from "../providers/zenClient.js";
import type { ProxyPoolStore } from "../proxy/proxyPool.js";
import type { MetricsStore } from "../observability/metrics.js";
import { extractTokenUsage } from "../utils/tokenUsage.js";

const noProxyAvailableError = "Proxy is required but no proxy node is available";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

interface SseBlock {
  event?: string;
  data: string;
}

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

/**
 * Splits incoming `content` text into reasoning (inside `<think>...</think>`)
 * and visible content (outside), maintaining state across chunks. Tags may be
 * split across chunk boundaries (e.g. "<thi" | "nk>"), so a tail that could be
 * the start of a tag is carried over to the next call.
 */
class ThinkTagSplitter {
  private insideThink = false;
  private carry = "";

  /** Returns the longest suffix of `text` that is a strict prefix of `tag`. */
  private partialTagSuffix(text: string, tag: string): number {
    const max = Math.min(text.length, tag.length - 1);
    for (let len = max; len > 0; len -= 1) {
      if (text.slice(text.length - len) === tag.slice(0, len)) return len;
    }
    return 0;
  }

  push(input: string): { reasoning: string; content: string } {
    let work = this.carry + input;
    this.carry = "";
    let reasoning = "";
    let content = "";

    while (work.length > 0) {
      if (this.insideThink) {
        const closeIdx = work.indexOf(CLOSE_TAG);
        if (closeIdx === -1) {
          // Hold back a possible partial close tag at the end.
          const hold = this.partialTagSuffix(work, CLOSE_TAG);
          reasoning += work.slice(0, work.length - hold);
          this.carry = work.slice(work.length - hold);
          return { reasoning, content };
        }
        reasoning += work.slice(0, closeIdx);
        work = work.slice(closeIdx + CLOSE_TAG.length);
        this.insideThink = false;
      } else {
        const openIdx = work.indexOf(OPEN_TAG);
        if (openIdx === -1) {
          const hold = this.partialTagSuffix(work, OPEN_TAG);
          content += work.slice(0, work.length - hold);
          this.carry = work.slice(work.length - hold);
          return { reasoning, content };
        }
        content += work.slice(0, openIdx);
        work = work.slice(openIdx + OPEN_TAG.length);
        this.insideThink = true;
      }
    }

    return { reasoning, content };
  }

  /** Flush any carried-over text at stream end (treat leftover as content if outside think). */
  flush(): { reasoning: string; content: string } {
    const leftover = this.carry;
    this.carry = "";
    if (!leftover) return { reasoning: "", content: "" };
    // A dangling partial tag never completed; emit it where it belongs.
    return this.insideThink ? { reasoning: leftover, content: "" } : { reasoning: "", content: leftover };
  }
}

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

/**
 * Rewrites a single upstream OpenAI chat.completion.chunk so that any `<think>`
 * content found in `choices[0].delta.content` is moved into
 * `choices[0].delta.reasoning_content`, leaving only the visible text in `content`.
 * Chunks without a content delta are forwarded unchanged.
 */
const rewriteChunk = (parsed: any, splitter: ThinkTagSplitter): unknown => {
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
  const delta = choice?.delta;
  if (!delta || typeof delta.content !== "string" || delta.content.length === 0) {
    return parsed;
  }

  const { reasoning, content } = splitter.push(delta.content);
  const nextDelta: Record<string, unknown> = { ...delta };

  if (reasoning.length > 0) nextDelta.reasoning_content = reasoning;
  // When everything was reasoning, content becomes empty string (not the tag text).
  nextDelta.content = content.length > 0 ? content : null;

  return {
    ...parsed,
    choices: [{ ...choice, delta: nextDelta }, ...parsed.choices.slice(1)],
  };
};

export const pipeOpenAiStreamStrippingThink = (
  prepared: ZenPreparedRequest,
  _model: string,
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

  const splitter = new ThinkTagSplitter();
  const started = process.hrtime.bigint();
  const durationMs = () => Number(process.hrtime.bigint() - started) / 1_000_000;
  let buffer = "";
  let markedFailure = false;
  let receivedData = false;
  let firstChunkChecked = false;
  let aborted = false;
  let retryStarted = false;
  let observedTotalTokens: number | null = null;
  let observedUsageTokens = 0;
  let observedUsage = false;
  let observedOutputChars = 0;
  let rateLimitBody = "";

  const retryRateLimited = (): boolean => {
    if (retryAttempt || !retryPrepare || !proxyPool || !prepared.lease?.node?.id || res.headersSent) return false;
    const excluded = new Set<string>();
    if (prepared.lease?.node?.id) excluded.add(prepared.lease.node.id);
    const retryPrepared = retryPrepare(excluded);
    if (retryPrepared.lease?.requiredUnavailable) return false;
    retryStarted = true;
    pipeOpenAiStreamStrippingThink(retryPrepared, _model, res, proxyPool, metrics, retryPrepare, true);
    return true;
  };

  const req = https.request(prepared.options, (zenRes) => {
    zenRes.on("data", (chunk: Buffer) => {
      if (aborted) return;
      if (zenRes.statusCode === 429) {
        rateLimitBody += chunk.toString();
        return;
      }
      receivedData = true;
      buffer += chunk.toString();

      // First-chunk error/rate-limit detection (mirrors pipeZenOpenAIResponse).
      if (!firstChunkChecked) {
        const str = buffer.trim();
        if (zenRes.statusCode === 429 || (str.startsWith("{") && (str.includes("FreeUsageLimitError") || str.includes("rate_limit_error") || str.toLowerCase().includes("rate limit")))) {
          try {
            const parsed = JSON.parse(str);
            if (zenRes.statusCode === 429 || parsed.error || parsed.type === "error") {
              firstChunkChecked = true;
              aborted = true;
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
            // Not a complete JSON error body yet; fall through and keep buffering as SSE.
          }
        }
      }

      const extracted = extractSseBlocks(buffer);
      buffer = extracted.rest;
      if (extracted.blocks.length > 0) firstChunkChecked = true;

      for (const block of extracted.blocks) {
        if (block.data === "[DONE]") {
          sendHeaders(res);
          res.write("data: [DONE]\n\n");
          continue;
        }
        if (!block.data) continue;
        sendHeaders(res);
        try {
          const parsed = JSON.parse(block.data);
          const usage = extractTokenUsage(parsed);
          if (usage.totalTokens !== null) {
            observedUsage = true;
            if (usage.inputTokens > 0 && usage.outputTokens > 0) observedTotalTokens = usage.totalTokens;
            else observedUsageTokens += usage.totalTokens;
          }
          const content = parsed.choices?.[0]?.delta?.content;
          if (typeof content === "string") observedOutputChars += content.length;
          writeSse(res, rewriteChunk(parsed, splitter));
        } catch {
          // Forward unparseable payloads untouched rather than dropping them.
          res.write(`data: ${block.data}\n\n`);
        }
      }
    });

    zenRes.on("end", () => {
      if (retryStarted) return;
      if ((zenRes.statusCode || 502) === 429) {
        if (prepared.lease?.node && proxyPool && !markedFailure) {
          let errMsg = "Upstream returned 429";
          try {
            const parsed = JSON.parse(rateLimitBody);
            errMsg = parsed.error?.message || parsed.message || errMsg;
          } catch {
            // Keep the generic rate-limit message for malformed upstream bodies.
          }
          proxyPool.markFailure(prepared.lease.node.id, errMsg, { statusCode: 429 });
          markedFailure = true;
        }
        if (retryRateLimited()) return;
        if (!res.headersSent) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Upstream returned 429", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
        } else if (!res.writableEnded) {
          res.end();
        }
        metrics?.recordUpstream({ statusCode: 429, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });
        return;
      }
      if (prepared.lease?.node && proxyPool && !markedFailure) {
        proxyPool.markSuccess(prepared.lease.node.id);
        proxyPool.recordTokenUsage(prepared.lease.node.id, observedTotalTokens ?? (observedUsage ? observedUsageTokens : Math.ceil(prepared.body.length / 4) + Math.ceil(observedOutputChars / 4)));
      }
      metrics?.recordUpstream({ statusCode: zenRes.statusCode || 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id });

      if (aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (!receivedData && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Empty response from upstream", type: "upstream_error" } }));
        return;
      }
      // Emit any text held back as a partial tag at stream end.
      const tail = splitter.flush();
      if (tail.reasoning || tail.content) {
        sendHeaders(res);
        writeSse(res, {
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { ...(tail.reasoning ? { reasoning_content: tail.reasoning } : {}), ...(tail.content ? { content: tail.content } : {}) }, finish_reason: null }],
        });
      }
      if (!res.writableEnded) res.end();
    });
  });

  res.on("close", () => {
    if (!req.destroyed) req.destroy();
  });

  req.on("error", (error) => {
    if (retryStarted) return;
    if (prepared.lease?.node && proxyPool && !markedFailure) {
      proxyPool.markFailure(prepared.lease.node.id, error.message);
      markedFailure = true;
    }
    metrics?.recordUpstream({ statusCode: 502, durationMs: durationMs(), proxyId: prepared.lease?.node?.id, error: error.message });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Upstream error: ${error.message}`, type: "upstream_error" } }));
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  req.on("timeout", () => {
    if (retryStarted) return;
    req.destroy();
    if (prepared.lease?.node && proxyPool && !markedFailure) {
      proxyPool.markFailure(prepared.lease.node.id, "Upstream timeout");
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

// Exported for offline unit testing of the cross-chunk state machine.
export { ThinkTagSplitter };
