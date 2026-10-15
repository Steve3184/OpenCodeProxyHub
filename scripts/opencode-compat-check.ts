import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ocId, ocSessionId } from "../src/utils/ids.js";
import { OPENCODE_USER_AGENT } from "../src/providers/opencodeHeaders.js";
import { prepareZenRequest, requestZenFull } from "../src/providers/zenClient.js";
import { createToolNameMapper } from "../src/converters/toolMapping.js";
import { SessionStore } from "../src/sessions/sessionStore.js";
import { ProxyPoolStore } from "../src/proxy/proxyPool.js";
import { SettingsStore } from "../src/settings/settingsStore.js";
import { loadConfig } from "../src/config/env.js";

const mask = (1n << 48n) - 1n;
const timestampPart = (id: string) => BigInt("0x" + id.split("_")[1]!.slice(0, 12));
const originalNow = Date.now;
const fixedNow = 1792077000000;
try {
  Date.now = () => fixedNow;
  const first = ocSessionId();
  const second = ocSessionId();
  const message = ocId("msg");
  assert.match(first, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(timestampPart(first), (~(BigInt(fixedNow) * 4096n + 1n)) & mask);
  assert.equal(timestampPart(second), timestampPart(first) - 1n);
  assert.equal(timestampPart(message), (BigInt(fixedNow) * 4096n + 3n) & mask);
  Date.now = () => fixedNow + 1;
  assert.equal(timestampPart(ocSessionId()), (~(BigInt(fixedNow + 1) * 4096n + 1n)) & mask);
} finally {
  Date.now = originalNow;
}
console.log("[pass] session IDs match official descending encoding; message IDs still ascend");

const assertHeaders = (headers: Record<string, unknown>, body: string, sessionId?: string) => {
  assert.equal(headers["User-Agent"], OPENCODE_USER_AGENT);
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["Accept-Encoding"], "identity");
  assert.equal(headers["Content-Length"], Buffer.byteLength(body));
  assert.equal(headers["x-opencode-session-id"], headers["x-opencode-session"]);
  assert.match(String(headers["x-opencode-session-id"]), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  if (sessionId) assert.equal(headers["x-opencode-session-id"], sessionId);
  const tick = ((~timestampPart(String(headers["x-opencode-session-id"]))) & mask) >> 12n;
  const nowTick = (BigInt(Date.now()) * 4096n & mask) >> 12n;
  assert.ok(nowTick - tick >= 0n && nowTick - tick < 10000n, "session encodes a recent descending timestamp");
};
const sessions = new SessionStore();
const config = { ...loadConfig(), zenHost: "example.invalid" };
for (const protocol of ["chat_completions", "responses", "systemone"] as const) {
  const sessionId = sessions.getSession(protocol);
  const prepared = prepareZenRequest(config, {
    model: "test-model", protocol, sessionId, toolMapper: createToolNameMapper([]),
    messages: [{ role: "user", content: "你好" }],
    responseBody: protocol === "systemone" ? { state: "你好", questions: {} } : { input: "你好" },
  });
  assertHeaders(prepared.options.headers as Record<string, unknown>, prepared.body, sessionId);
}
console.log("[pass] Chat, Responses and System One use canonical headers and UTF-8 content lengths");

const tempDir = await mkdtemp(path.join(os.tmpdir(), "oph-opencode-compat-"));
const originalRequest = https.request;
const captured: Array<Record<string, unknown>> = [];
let failFirst = false;
let pool: ProxyPoolStore | undefined;
try {
  https.request = ((options: https.RequestOptions, callback: (response: any) => void) => {
    let body = "";
    const req = Object.assign(new EventEmitter(), {
      write: (chunk: string | Buffer) => { body += chunk.toString(); return true; },
      destroy: () => {},
      end: () => queueMicrotask(() => {
        const headers = options.headers as Record<string, unknown>;
        assertHeaders(headers, body);
        captured.push(headers);
        const failed = failFirst;
        failFirst = false;
        const res = Object.assign(new EventEmitter(), { statusCode: failed ? 403 : 200, resume: () => {} });
        callback(res);
        const payload = failed
          ? { error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } }
          : String(options.path).endsWith("/systemone") ? { answers: { ok: "ok" } }
          : String(options.path).endsWith("/responses") ? { object: "response", output: [] }
          : { id: "test", choices: [{ index: 0, message: { content: "OK" }, finish_reason: "stop" }] };
        res.emit("data", Buffer.from(JSON.stringify(payload)));
        res.emit("end");
      }),
    });
    return req;
  }) as typeof https.request;
  const settings = new SettingsStore(path.join(tempDir, "settings.json"), { proxyMode: "required" });
  settings.load();
  pool = new ProxyPoolStore(path.join(tempDir, "proxies.json"), settings, { cooldownMs: 0 });
  pool.load();
  const node = pool.create({ name: "mock", type: "http", url: "http://127.0.0.1:1" });
  for (const protocol of ["chat_completions", "responses", "systemone"] as const) {
    await pool.test(node.id, { hostname: "example.invalid", path: "/v1/" + (protocol === "chat_completions" ? "chat/completions" : protocol), model: "test-model", protocol, timeoutMs: 1000 });
  }
  assert.equal(new Set(captured.map(h => h["x-opencode-session-id"])).size, 3);
  console.log("[pass] health probes share canonical headers and create fresh descending sessions");
  captured.length = 0;
  pool.create({ name: "fallback", type: "http", url: "http://127.0.0.1:2" });
  failFirst = true;
  const prepare = (excluded: ReadonlySet<string> = new Set()) => prepareZenRequest(config, {
    model: "test-model", sessionId: sessions.getSession("retry"), toolMapper: createToolNameMapper([]),
    messages: [{ role: "user", content: "OK" }],
  }, pool, excluded);
  const result = await requestZenFull(prepare(), pool, undefined, prepare);
  assert.equal(result.status, 200);
  assert.equal(result.data.choices[0].message.content, "OK");
  assert.equal(captured.length, 2);
  assert.notEqual(captured[0]!["x-opencode-session-id"], captured[1]!["x-opencode-session-id"]);
  assert.notEqual(captured[0]!["x-opencode-request"], captured[1]!["x-opencode-request"]);
  assert.ok(pool.list().every(node => node.currentConcurrency === 0));
  console.log("[pass] retry refreshes both identities and settles both proxy leases");
} finally {
  https.request = originalRequest;
  await pool?.flush();
  await rm(tempDir, { recursive: true, force: true });
}
