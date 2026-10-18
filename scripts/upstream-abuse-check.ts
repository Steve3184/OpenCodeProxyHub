import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeZenAsAnthropic } from "../src/converters/anthropic.js";
import { isOpenCodeAbuseError, parseUpstreamErrorPayload, shouldRetryWithAnotherProxy } from "../src/providers/opencodeAccessErrors.js";
import { requestZenFull, type ZenPreparedRequest } from "../src/providers/zenClient.js";
import { ProxyPoolStore } from "../src/proxy/proxyPool.js";
import { SettingsStore } from "../src/settings/settingsStore.js";

const message = "Forbidden, OpenCode Free Model Gateway Detect Abuse Traffic";
const body = JSON.stringify({ type: "error", error: { type: "FreeTierError", message } });
const eventBody = `data: ${body}\n\ndata: [DONE]\n\n`;
for (const status of [200, 403, 429, 503]) {
  const failure = parseUpstreamErrorPayload(status, body)!;
  assert.equal(failure.statusCode, 403);
  assert.equal(failure.message, message);
  assert.equal(failure.rateLimited, false);
  assert.equal(failure.proxyAccessError, false);
  assert.equal(shouldRetryWithAnotherProxy(status, body), false);
}
assert.equal(parseUpstreamErrorPayload(403, message)?.message, message);
assert.equal(isOpenCodeAbuseError(message.toUpperCase()), true);
assert.equal(isOpenCodeAbuseError("ordinary forbidden"), false);
assert.equal(shouldRetryWithAnotherProxy(429, '{"error":{"message":"Rate limit exceeded"}}'), true);
assert.equal(shouldRetryWithAnotherProxy(403, body.replace(message, message + "; rate limit; OpenCode's free tier can only be used from within OpenCode")), false);
console.log("[pass] explicit abuse refusals stay 403 and never become proxy-rotation retries");

const directory = await mkdtemp(path.join(os.tmpdir(), "ocph-abuse-check-"));
const settings = new SettingsStore(path.join(directory, "settings.json"), { proxyMode: "required" });
settings.load();
const file = path.join(directory, "proxies.json");
const pool = new ProxyPoolStore(file, settings, { cooldownMs: 0 });
pool.load();
const node = pool.create({ name: "restricted", url: "http://127.0.0.1:9191", maxConcurrency: 2 });
const model = "glm-5.3-flash-free";
const lease = pool.acquire(new Set(), model);
const held = pool.acquire(new Set(), model);
pool.markFailure(node.id, message, { statusCode: 403, upstreamBody: body, leaseId: lease.leaseId });
pool.markFailure(node.id, message, { statusCode: 403, upstreamBody: body, leaseId: lease.leaseId });
assert.equal(pool.list()[0]!.enabled, false);
assert.equal(pool.list()[0]!.currentConcurrency, 1);
assert.equal(pool.list()[0]!.failCount, 1);
assert.equal(pool.list()[0]!.autoDisabledByConnect, false);
assert.equal(pool.list()[0]!.autoDisabledBy429, false);
pool.markSuccess(node.id, held.leaseId);
assert.equal(pool.list()[0]!.enabled, false, "an already-running successful request cannot undo quarantine");
await pool.flush();
const restored = new ProxyPoolStore(file, settings, { cooldownMs: 0 });
restored.load();
assert.equal(restored.list()[0]!.enabled, false);
const probe = { hostname: "example.invalid", path: "/chat", model, timeoutMs: 1000 };
assert.deepEqual(await restored.recoverRateLimitedProxies(probe), { tested: 0, recovered: 0 });
assert.equal(restored.acquire(new Set(), model).node, null);
restored.update(node.id, { enabled: true });
const resumed = restored.acquire(new Set(), model);
restored.release(node.id, resumed.leaseId);
console.log("[pass] restriction quarantine persists, settles only its lease, and requires explicit enablement");

const originalRequest = https.request;
let responseStatus = 403;
let responseBody = body;
let attempts = 0;
let retries = 0;
(https as any).request = (_options: unknown, callback: (response: any) => void) => {
  attempts += 1;
  const request: any = new EventEmitter();
  request.write = () => true;
  request.destroy = () => request;
  request.end = () => queueMicrotask(() => {
    const response: any = new EventEmitter();
    response.statusCode = responseStatus;
    response.headers = { "content-type": responseStatus === 200 ? "text/event-stream" : "application/json" };
    response.resume = () => response;
    response.destroy = () => response;
    callback(response);
    response.emit("data", Buffer.from(responseBody));
    response.emit("end");
  });
  return request;
};
const prepared: ZenPreparedRequest = { body: JSON.stringify({ model }), options: {} };
const retry = () => { retries += 1; return prepared; };
try {
  for (const status of [403, 200]) {
    responseStatus = status;
    responseBody = status === 200 ? eventBody : body;
    const countBefore = attempts;
    const result = await requestZenFull(prepared, undefined, undefined, retry);
    assert.equal(result.status, 403);
    assert.ok(result.raw.includes(message));
    assert.equal(attempts - countBefore, 1);
    assert.equal(retries, 0);
    const response: any = new EventEmitter();
    response.headersSent = false;
    response.writableEnded = false;
    response.chunks = [];
    response.writeHead = (code: number) => { response.statusCode = code; response.headersSent = true; };
    response.write = (chunk: unknown) => { response.chunks.push(String(chunk)); return true; };
    response.end = (chunk?: unknown) => { if (chunk !== undefined) response.chunks.push(String(chunk)); response.writableEnded = true; response.emit("finish"); };
    const finished = new Promise<void>((resolve) => response.once("finish", resolve));
    pipeZenAsAnthropic(prepared, model, response, 1, undefined, undefined, retry);
    await finished;
    assert.equal(response.statusCode, 403);
    assert.ok(response.chunks.join("").includes(message));
    assert.equal(retries, 0);
  }
  console.log("[pass] buffered and Claude streaming requests preserve JSON/SSE abuse errors without retries");
  for (const status of [403, 200]) {
    responseStatus = status;
    responseBody = status === 200 ? eventBody : body;
    restored.update(node.id, { enabled: true });
    await assert.rejects(restored.test(node.id, probe), /Detect Abuse Traffic/);
    assert.equal(restored.list()[0]!.enabled, false);
    assert.equal(restored.list()[0]!.autoDisabledByConnect, false);
  }
  restored.update(node.id, { enabled: true });
  const failed = restored.acquire(new Set(), model);
  restored.markFailure(node.id, "temporary model failure", { statusCode: 503, leaseId: failed.leaseId });
  responseStatus = 403;
  responseBody = body;
  assert.deepEqual(await restored.recoverRateLimitedProxies(probe), { tested: 1, recovered: 0 });
  assert.equal(restored.list()[0]!.enabled, false);
  assert.deepEqual(await restored.recoverRateLimitedProxies(probe), { tested: 0, recovered: 0 });
  console.log("[pass] explicit and background health probes retain the refusal reason and stop automatic recovery");
} finally {
  https.request = originalRequest;
  await pool.flush();
  await restored.flush();
  await rm(directory, { recursive: true, force: true });
}
