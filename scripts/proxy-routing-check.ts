import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { requestZenFull, type ZenPreparedRequest } from "../src/providers/zenClient.js";
import { pipeZenAsAnthropic } from "../src/converters/anthropic.js";
import { isOpenCodeProxyAccessError } from "../src/providers/opencodeAccessErrors.js";
import { ProxyPoolStore, isProxyCompatibleWithModel } from "../src/proxy/proxyPool.js";
import { SessionStore } from "../src/sessions/sessionStore.js";
import { SettingsStore } from "../src/settings/settingsStore.js";

assert.equal(isOpenCodeProxyAccessError(403, "OpenCode's free tier can only be used from within OpenCode"), true);
assert.equal(isOpenCodeProxyAccessError(403, "Your access has been restricted due to repeated policy violations."), true);
assert.equal(isOpenCodeProxyAccessError(403, "ordinary forbidden"), false);
assert.equal(isOpenCodeProxyAccessError(400, "OpenCode's free tier can only be used from within OpenCode"), false);
console.log("[pass] only the known OpenCode proxy-access 403s are retryable");

assert.equal(isProxyCompatibleWithModel({ name: "Cyber HK", url: "http://127.0.0.1:9001" }, "muse-spark-1.3-contributor-free"), false);
assert.equal(isProxyCompatibleWithModel({ name: "normal", url: "http://cyber.example:9001" }, "muse-spark-1.2-contributor-free"), false);
assert.equal(isProxyCompatibleWithModel({ name: "Cyber HK", url: "http://127.0.0.1:9001" }, "mimo-v2.5-free"), true);
assert.equal(isProxyCompatibleWithModel({ name: "normal", url: "http://127.0.0.1:9002" }, "muse-spark-1.3-contributor-free"), true);
console.log("[pass] Muse excludes Cyber nodes without changing other model routing");

const sessions = new SessionStore();
const firstSession = sessions.getSession("same-client");
const secondSession = sessions.getSession("same-client");
assert.notEqual(firstSession, secondSession);
console.log("[pass] every upstream attempt receives a fresh session id");

const tempDir = await mkdtemp(path.join(os.tmpdir(), "oph-proxy-routing-"));
try {
  const settings = new SettingsStore(path.join(tempDir, "settings.json"), { proxyMode: "required" });
  settings.load();
  const pool = new ProxyPoolStore(path.join(tempDir, "proxies.json"), settings);
  pool.load();
  const cyber = pool.create({ name: "Cyber primary", type: "http", url: "http://127.0.0.1:9001", weight: 100, maxConcurrency: 10 });
  const safe = pool.create({ name: "Safe fallback", type: "http", url: "http://127.0.0.1:9002", weight: 50, maxConcurrency: 10 });

  const museLease = pool.acquire(new Set(), "muse-spark-1.3-contributor-free");
  assert.equal(museLease.node?.id, safe.id);
  if (museLease.node) pool.release(museLease.node.id, museLease.leaseId);

  const normalLease = pool.acquire(new Set(), "mimo-v2.5-free");
  assert.equal(normalLease.node?.id, cyber.id);
  if (normalLease.node) pool.release(normalLease.node.id, normalLease.leaseId);
  console.log("[pass] the proxy pool applies model compatibility during acquisition");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

type MockResponse = { status: number; body: string };
const originalRequest = https.request;
const runRetryScenario = async (responses: MockResponse[]): Promise<{ attempts: number; failures: number; sessions: string[] }> => {
  let attempts = 0;
  let failures = 0;
  const sessionsSeen: string[] = [];
  (https as typeof https & { request: typeof https.request }).request = ((options: https.RequestOptions, callback: (response: EventEmitter & { statusCode: number; resume: () => void }) => void) => {
    const index = attempts++;
    sessionsSeen.push(String((options.headers as Record<string, unknown> | undefined)?.["x-opencode-session"] || ""));
    const responseSpec = responses[index];
    assert.ok(responseSpec, `unexpected upstream attempt ${index + 1}`);
    const request = new EventEmitter() as EventEmitter & { write: (body: string) => void; end: () => void; destroy: () => void };
    request.write = () => undefined;
    request.destroy = () => undefined;
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
        response.statusCode = responseSpec.status;
        response.resume = () => undefined;
        callback(response);
        response.emit("data", Buffer.from(responseSpec.body));
        response.emit("end");
      });
    };
    return request as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;

  const makePrepared = (proxyId: string, sessionId: string): ZenPreparedRequest => ({
    body: JSON.stringify({ model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }] }),
    options: { headers: { "x-opencode-session": sessionId } },
    lease: { node: { id: proxyId } as any, leaseId: `${proxyId}-lease`, agent: undefined },
  });
  const pool = {
    markFailure: () => { failures += 1; },
    markSuccess: () => undefined,
    recordTokenUsage: () => undefined,
  } as unknown as ProxyPoolStore;
  const prepared = makePrepared("proxy-a", "session-a");
  const retryPrepare = (excluded: ReadonlySet<string>) => {
    assert.equal(excluded.has("proxy-a"), true);
    return makePrepared("proxy-b", "session-b");
  };
  await requestZenFull(prepared, pool, undefined, retryPrepare);
  return { attempts, failures, sessions: sessionsSeen };
};



class MockServerResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  statusCode = 200;
  chunks: string[] = [];
  private readonly finishPromise: Promise<void>;
  private finishResolve!: () => void;

  constructor() {
    super();
    this.finishPromise = new Promise((resolve) => { this.finishResolve = resolve; });
  }

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(chunk.toString());
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.chunks.push(chunk.toString());
    this.writableEnded = true;
    this.emit("finish");
    this.finishResolve();
    return this;
  }

  waitForFinish(): Promise<void> {
    return this.finishPromise;
  }
}

const runAnthropicStreamRetryScenario = async (): Promise<{ attempts: number; sessions: string[]; output: string }> => {
  let attempts = 0;
  const sessionsSeen: string[] = [];
  const responses: MockResponse[] = [
    { status: 403, body: JSON.stringify({ error: { message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode" } }) },
    { status: 200, body: 'data: {"id":"ok","choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"ok","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' },
  ];
  (https as typeof https & { request: typeof https.request }).request = ((options: https.RequestOptions, callback: (response: EventEmitter & { statusCode: number; resume: () => void }) => void) => {
    const index = attempts++;
    sessionsSeen.push(String((options.headers as Record<string, unknown> | undefined)?.["x-opencode-session"] || ""));
    const responseSpec = responses[index];
    assert.ok(responseSpec, `unexpected anthropic upstream attempt ${index + 1}`);
    const request = new EventEmitter() as EventEmitter & { write: (body: string) => void; end: () => void; destroy: () => void };
    request.write = () => undefined;
    request.destroy = () => undefined;
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
      response.statusCode = responseSpec.status;
      response.resume = () => undefined;
      callback(response);
      response.emit("data", Buffer.from(responseSpec.body));
      response.emit("end");
    });
    return request as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;

  const makePrepared = (proxyId: string, sessionId: string): ZenPreparedRequest => ({
    body: JSON.stringify({ model: "muse-spark-1.3-contributor-free", messages: [{ role: "user", content: "hi" }] }),
    options: { headers: { "x-opencode-session": sessionId } },
    lease: { node: { id: proxyId } as any, leaseId: `${proxyId}-lease`, agent: undefined },
  });
  const pool = {
    markFailure: () => undefined,
    markSuccess: () => undefined,
    recordTokenUsage: () => undefined,
    release: () => undefined,
  } as unknown as ProxyPoolStore;
  const res = new MockServerResponse();
  const retryPrepare = (excluded: ReadonlySet<string>) => {
    assert.equal(excluded.has("proxy-a"), true);
    return makePrepared("proxy-b", "session-b");
  };
  pipeZenAsAnthropic(makePrepared("proxy-a", "session-a"), "muse-spark-1.3-contributor", res as any, 1, pool, undefined, retryPrepare);
  await res.waitForFinish();
  return { attempts, sessions: sessionsSeen, output: res.chunks.join("") };
};

try {
  const retried = await runRetryScenario([
    { status: 403, body: JSON.stringify({ error: { message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode" } }) },
    { status: 200, body: 'data: {"id":"ok","choices":[{"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n' },
  ]);
  assert.equal(retried.attempts, 2);
  assert.equal(retried.failures, 1);
  assert.deepEqual(retried.sessions, ["session-a", "session-b"]);
  console.log("[pass] matching 403 retries once on another proxy with another session");

  const notRetried = await runRetryScenario([
    { status: 403, body: JSON.stringify({ error: { message: "ordinary forbidden" } }) },
  ]);
  assert.equal(notRetried.attempts, 1);
  console.log("[pass] unrelated 403 responses are not retried");

  const anthropicRetried = await runAnthropicStreamRetryScenario();
  assert.equal(anthropicRetried.attempts, 2);
  assert.deepEqual(anthropicRetried.sessions, ["session-a", "session-b"]);
  assert.ok(anthropicRetried.output.includes("OK"));
  console.log("[pass] Anthropic streaming retries the matching 403 before sending headers");
} finally {
  (https as typeof https & { request: typeof https.request }).request = originalRequest;
}
