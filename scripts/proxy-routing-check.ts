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
  const pool = new ProxyPoolStore(path.join(tempDir, "proxies.json"), settings, { cooldownMs: 0 });
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

  // Console errors must not consume the fifth strike or release another request's lease.
  for (let i = 0; i < 4; i++) {
    const lease = pool.acquire(new Set(), "mimo-v2.5-free");
    assert.equal(lease.node?.id, cyber.id);
    pool.markFailure(cyber.id, "Rate limit exceeded", { statusCode: 429, leaseId: lease.leaseId });
  }
  const held = pool.acquire(new Set(), "mimo-v2.5-free");
  const consoleLease = pool.acquire(new Set(), "mimo-v2.5-free");
  const consoleError = "Error from provider (Console): Rate limit exceeded. Please try again later.";
  const options = { statusCode: 429, leaseId: consoleLease.leaseId, upstreamBody: JSON.stringify({ error: { message: consoleError } }) };
  pool.markFailure(cyber.id, "Upstream returned 429", options);
  pool.markFailure(cyber.id, "Upstream returned 429", options);
  const node = pool.list().find((item) => item.id === cyber.id)!;
  assert.equal(node.enabled, true);
  assert.equal(node.rateLimitStates?.["mimo-v2.5-free"]?.consecutiveRateLimitCount, 4);
  assert.equal(node.failCount, 4);
  assert.equal(node.currentConcurrency, 1);
  assert.equal(node.cooldownUntil, null);
  pool.release(cyber.id, held.leaseId);
  await pool.flush();
  const reloaded = new ProxyPoolStore(path.join(tempDir, "proxies.json"), settings, { cooldownMs: 0 });
  reloaded.load();
  assert.equal(reloaded.list().find((item) => item.id === cyber.id)?.rateLimitStates?.["mimo-v2.5-free"]?.consecutiveRateLimitCount, 4);
  console.log("[pass] Console errors preserve prior strikes and settle only their own lease, including duplicate settlement and reload");
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

const checkLargePoolRouting = async (): Promise<void> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oph-large-pool-routing-"));
  const settings = new SettingsStore(path.join(dir, "settings.json"), { proxyMode: "required" });
  settings.load();
  const pool = new ProxyPoolStore(path.join(dir, "proxies.json"), settings, { cooldownMs: 0 });
  pool.load();
  try {
    const model = "routing-check-free";
    const limited = Array.from({ length: 24 }, (_, index) => pool.create({ name: `limited-${index}`, url: `http://127.0.0.1:${9200 + index}`, maxConcurrency: 1 }));
    const healthy = pool.create({ name: "healthy at the end", url: "http://127.0.0.1:9300", maxConcurrency: 1 });
    const nodes = [...limited, healthy];
    const only = (id: string) => new Set(nodes.filter((node) => node.id !== id).map((node) => node.id));
    for (const node of limited) {
      const lease = pool.acquire(only(node.id), model);
      pool.markFailure(node.id, "Upstream returned HTTP 429", { statusCode: 429, leaseId: lease.leaseId });
    }

    const attempted: string[] = [];
    const successBody = 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const failedProbeBody = 'event: response.created\ndata: {"type":"response.created","response":{"object":"response","output":[]}}\n\nevent: response.failed\ndata: {"type":"response.failed","response":{"object":"response","error":{"message":"Upstream returned HTTP 429","code":"rate_limit_exceeded"}}}\n\n';
    let healthBody = successBody;
    https.request = ((options: https.RequestOptions, callback: (response: EventEmitter) => void) => {
      const id = String((options.headers as Record<string, string>)["x-test-proxy-id"] || "");
      if (id) attempted.push(id);
      const ok = !id || id === healthy.id;
      const request = Object.assign(new EventEmitter(), { write: () => {}, destroy: () => {}, end: () => queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { statusCode: ok ? 200 : 429, resume: () => {} });
        callback(response);
        response.emit("data", Buffer.from(!id ? healthBody : ok
          ? successBody
          : '{"error":{"message":"Upstream returned HTTP 429","type":"rate_limit_error","code":"rate_limit_exceeded"}}'));
        response.emit("end");
      }) });
      return request;
    }) as typeof https.request;
    const prepare = (excluded: ReadonlySet<string>): ZenPreparedRequest => {
      const lease = pool.acquire(excluded, model);
      return { body: JSON.stringify({ model }), options: { agent: lease.agent, headers: { "x-test-proxy-id": lease.node?.id || "" } }, lease };
    };
    const warmup = await requestZenFull(prepare(only(healthy.id)), pool);
    assert.equal(warmup.status, 200);
    attempted.length = 0;
    const response = await requestZenFull(prepare(new Set()), pool, undefined, prepare, 0, "chat_completions", 10);
    assert.equal(response.status, 200, "24 expired 429 cooldowns must not exhaust ten retries before reaching the known healthy node");
    assert.deepEqual(attempted, [healthy.id], "the model's healthy node must be reached immediately even at the end of the pool");

    await pool.flush();
    const restored = new ProxyPoolStore(path.join(dir, "proxies.json"), settings, { cooldownMs: 0 });
    restored.load();
    const lease = restored.acquire(new Set(), model);
    assert.equal(lease.node?.id, healthy.id, "model health preference must survive restart");
    restored.release(healthy.id, lease.leaseId);

    const untested = restored.create({ name: "untested fallback", url: "http://127.0.0.1:9301", maxConcurrency: 1 });
    const held = restored.acquire(new Set(), model);
    assert.equal(held.node?.id, healthy.id);
    const overflow = restored.acquire(new Set(), model);
    assert.equal(overflow.node?.id, untested.id, "a full healthy node falls back to untested nodes before expired failures");
    restored.release(untested.id, overflow.leaseId);
    restored.release(healthy.id, held.leaseId);
    const excluded = restored.acquire(new Set([healthy.id]), model);
    assert.equal(excluded.node?.id, untested.id, "successful nodes must still respect retry exclusions");
    restored.release(untested.id, excluded.leaseId);

    const otherModel = restored.acquire(new Set(), "another-model");
    assert.equal(otherModel.node?.id, limited[0]!.id, "successes and failures on one model must not reorder another model's pool");
    restored.release(otherModel.node!.id, otherModel.leaseId);
    const generic = restored.acquire();
    assert.equal(generic.node?.id, limited[0]!.id, "model-independent acquisition keeps its existing priority order");
    restored.release(generic.node!.id, generic.leaseId);

    const higherWeight = restored.create({ name: "explicit priority", url: "http://127.0.0.1:9302", weight: 2 });
    const priorityLease = restored.acquire(new Set(), model);
    assert.equal(priorityLease.node?.id, higherWeight.id, "an explicit higher weight remains the primary priority");
    restored.markFailure(higherWeight.id, "rate limited", { statusCode: 429, cooldownMs: 10000, leaseId: priorityLease.leaseId });
    const whileCooling = restored.acquire(new Set(), model);
    assert.equal(whileCooling.node?.id, healthy.id, "health preference must not bypass cooldowns");
    restored.markFailure(healthy.id, "rate limited again", { statusCode: 429, leaseId: whileCooling.leaseId });
    const afterFailure = restored.acquire(new Set(), model);
    assert.equal(afterFailure.node?.id, untested.id, "a later failure must revoke a previously successful node's preference");
    restored.release(untested.id, afterFailure.leaseId);
    healthBody = failedProbeBody;
    await assert.rejects(restored.test(healthy.id, { hostname: "example.test", path: "/", model, timeoutMs: 1000, protocol: "responses" }), /Upstream returned HTTP 429/, "a Responses error after response.created must not be mistaken for a successful health probe");
    healthBody = successBody;
    await restored.test(healthy.id, { hostname: "example.test", path: "/", model, timeoutMs: 1000 });
    const afterTest = restored.acquire(new Set(), model);
    assert.equal(afterTest.node?.id, healthy.id, "a successful model probe must restore preference");
    restored.release(healthy.id, afterTest.leaseId);

    const recoveryModel = "recovery-check-free";
    for (let i = 0; i < 5; i++) {
      const lease = restored.acquire(new Set(restored.list().filter((node) => node.id !== healthy.id).map((node) => node.id)), recoveryModel);
      restored.markFailure(healthy.id, "rate limited", { statusCode: 429, leaseId: lease.leaseId });
    }
    const recoveryOptions = { hostname: "example.test", path: "/", model: recoveryModel, timeoutMs: 1000, protocol: "responses" as const, recoveryIntervalMs: 0 };
    healthBody = failedProbeBody;
    const notRecovered = await restored.recoverRateLimitedProxies(recoveryOptions);
    assert.deepEqual(notRecovered, { tested: 1, recovered: 0 });
    assert.equal(restored.list().find((node) => node.id === healthy.id)!.rateLimitStates?.[recoveryModel]?.autoDisabledBy429, true, "a wrapped 429 must not release model isolation during recovery");
    healthBody = 'event: response.completed\ndata: {"type":"response.completed","response":{"object":"response","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}}\n\n';
    const recovered = await restored.recoverRateLimitedProxies(recoveryOptions);
    assert.deepEqual(recovered, { tested: 1, recovered: 1 });
    const afterRecovery = restored.acquire(new Set([higherWeight.id]), recoveryModel);
    assert.equal(afterRecovery.node?.id, healthy.id, "automatic recovery must establish health only for the successfully probed model");
    restored.release(healthy.id, afterRecovery.leaseId);

    restored.update(healthy.id, { url: "http://127.0.0.1:9303" });
    const afterEndpointChange = restored.acquire(new Set(), model);
    assert.equal(afterEndpointChange.node?.id, healthy.id, "an edited endpoint is untested and still precedes expired failures");
    restored.release(healthy.id, afterEndpointChange.leaseId);
    const editedState = restored.list().find((node) => node.id === healthy.id)!.rateLimitStates!;
    assert.ok(Object.values(editedState).every((state) => state.lastSuccessAt === null), "endpoint edits must discard success evidence for the old endpoint");
    restored.update(healthy.id, { enabled: false });
    const afterDisable = restored.acquire(new Set(), model);
    assert.equal(afterDisable.node?.id, untested.id, "manual disables must override model health");
    restored.release(untested.id, afterDisable.leaseId);
    await restored.flush();
    console.log("[pass] a healthy node behind 24 expired 429 nodes is used before exhausting retries, including after restart");
    console.log("[pass] model health preference respects concurrency, exclusions, weights, cooldowns, failures, probes, endpoint changes and manual disables");
  } finally {
    await pool.flush();
    await rm(dir, { recursive: true, force: true });
  }
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

  await checkLargePoolRouting();
} finally {
  (https as typeof https & { request: typeof https.request }).request = originalRequest;
}
