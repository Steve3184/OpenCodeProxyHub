import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { ModelConfigStore, type ModelConfig } from "../src/models/catalog.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "oph-models-transport-"));
const originalFetch = globalThis.fetch;
const originalRequest = https.request;
const config = {
  ...loadConfig(), host: "127.0.0.1", port: 0,
  keysFile: path.join(tempDir, "keys.json"), modelsFile: path.join(tempDir, "models.json"),
  modelAliasesFile: path.join(tempDir, "aliases.json"), settingsFile: path.join(tempDir, "settings.json"),
  proxiesFile: path.join(tempDir, "proxies.json"), logsDir: path.join(tempDir, "logs"),
  adminPassword: "test-only", redisUrl: "", proxyMode: "direct" as const,
  outboundPreProxyEnabled: false, zenHost: "example.invalid",
  globalRequestsPerMinute: 1000, apiKeyRequestsPerMinute: 1000,
  proxyRecoveryIntervalMs: 3_600_000, shutdownDrainTimeoutMs: 1000,
};
let app: Awaited<ReturnType<typeof buildApp>>["app"] | undefined;
const assertHeaders = (headers: Record<string, unknown>) => {
  assert.match(String(headers["cache-control"]), /\bno-store\b/);
  assert.match(String(headers["cache-control"]), /\bno-transform\b/);
  assert.equal(headers["cdn-cache-control"], "no-store");
  assert.equal(headers["cloudflare-cdn-cache-control"], "no-store");
  assert.equal(headers["content-encoding"], undefined);
};
try {
  const built = await buildApp(config);
  app = built.app;
  const login = await app.inject({ method: "POST", url: "/admin/login", payload: { password: "test-only" } });
  assert.equal(login.statusCode, 200);
  assertHeaders(login.headers);
  const admin = { authorization: `Bearer ${login.json().data.token}` };
  const key = built.keyStore.create("transport-test");
  const client = { authorization: `Bearer ${key.key}`, "accept-encoding": "gzip, br" };
  const setModel = async (id: string, payload: Record<string, unknown>) => {
    const reply = await app!.inject({ method: "PUT", url: `/admin/models/${id}`, headers: admin, payload });
    assert.equal(reply.statusCode, 200);
  };
  const setSettings = async (payload: Record<string, unknown>) => {
    const reply = await app!.inject({ method: "PATCH", url: "/admin/settings", headers: admin, payload });
    assert.equal(reply.statusCode, 200);
  };
  await setModel("big-pickle", { enabled: false, useResponses: true, displayName: "My disabled model" });
  await setModel("mimo-v2.5-free", { enabled: false });
  await setModel("custom-free", { enabled: true });
  await setSettings({ openAiStreamTransformModels: ["big-pickle"], reasoningTagModels: ["mimo-v2.5-free"] });
  let upstreamFails = false;
  let syncRequests = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://opencode.ai/zen/v1/models");
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("accept-encoding"), "identity");
    syncRequests++;
    if (upstreamFails) return new Response("Unavailable", { status: 503 });
    return Response.json({ data: ["big-pickle", "mimo-v2.5-free", "custom-free", "discovered-free", "paid-model"].map((id) => ({ id, owned_by: "updated-owner", created: 1234567890 })) });
  };
  for (let i = 0; i < 2; i++) {
    const sync = await app.inject({ method: "POST", url: "/admin/models/sync-free", headers: admin });
    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().data.synced, 4);
    assertHeaders(sync.headers);
  }
  const catalog = (await app.inject({ url: "/admin/models", headers: admin })).json().data as ModelConfig[];
  assert.equal(catalog.find((m) => m.id === "big-pickle")?.enabled, false);
  assert.equal(catalog.find((m) => m.id === "mimo-v2.5-free")?.enabled, false);
  assert.equal(catalog.find((m) => m.id === "big-pickle")?.useResponses, true);
  assert.equal(catalog.find((m) => m.id === "big-pickle")?.displayName, "My disabled model");
  assert.equal(catalog.find((m) => m.id === "big-pickle")?.ownedBy, "updated-owner");
  assert.equal(catalog.find((m) => m.id === "big-pickle")?.created, 1234567890);
  assert.equal(catalog.find((m) => m.id === "custom-free")?.enabled, true);
  assert.equal(catalog.find((m) => m.id === "discovered-free")?.enabled, true);
  assert.equal(catalog.some((m) => m.id === "paid-model"), false);
  const settings = (await app.inject({ url: "/admin/settings", headers: admin })).json().data;
  assert.deepEqual(settings.openAiStreamTransformModels, ["big-pickle"]);
  assert.deepEqual(settings.reasoningTagModels, ["mimo-v2.5-free"]);
  const reloaded = new ModelConfigStore(config.modelsFile);
  reloaded.load();
  assert.equal(reloaded.isEnabled("big-pickle"), false);
  assert.equal(reloaded.isEnabled("mimo-v2.5-free"), false);
  assert.equal(reloaded.usesResponses("big-pickle"), true);
  const publicModels = await app.inject({ url: "/v1/models" });
  assertHeaders(publicModels.headers);
  assert.equal(publicModels.json().data.some((m: ModelConfig) => m.id === "big-pickle"), false);
  upstreamFails = true;
  const failed = await app.inject({ method: "POST", url: "/admin/models/sync-free", headers: admin });
  assert.equal(failed.statusCode, 500);
  assertHeaders(failed.headers);
  assert.deepEqual((await app.inject({ url: "/admin/models", headers: admin })).json().data, catalog);
  assert.equal(syncRequests, 3);
  console.log("[pass] repeated model sync preserves disabled states, settings and persistence; new models default enabled; failed sync leaves catalog intact");

  for (const url of ["/admin/models", "/v1/missing", "/zen/v1/missing", "/health"]) {
    assertHeaders((await app.inject({ url, headers: { "accept-encoding": "gzip, br" } })).headers);
  }
  const malformed = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...client, "content-type": "application/json" }, payload: "{" });
  assert.equal(malformed.statusCode, 400);
  assertHeaders(malformed.headers);
  console.log("[pass] JSON, auth, missing routes and parser errors prevent caching and compression");

  await setModel("big-pickle", { enabled: true, useResponses: false });
  await setSettings({ openAiStreamTransformModels: [], reasoningTagModels: [] });
  let wire = "chat";
  let upstreamStatus = 200;
  const chatBody = 'data: {"id":"test","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const anthropicBody = 'event: message_start\ndata: {"type":"message_start","message":{"id":"test","usage":{"input_tokens":1}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const responsesBody = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}]}}\n\n';
  https.request = ((options: https.RequestOptions, callback: (response: EventEmitter) => void) => {
    assert.equal((options.headers as Record<string, string>)["Accept-Encoding"], "identity");
    const request = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void };
    request.write = () => {};
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: upstreamStatus, resume: () => {} });
      callback(response);
      const body = upstreamStatus !== 200 ? '{"error":{"message":"test upstream error"}}' : wire === "anthropic" ? anthropicBody : wire === "responses" ? responsesBody : wire === "systemone" ? '{"answer":"Hello"}' : chatBody;
      response.emit("data", Buffer.from(body));
      response.emit("end");
    });
    return request;
  }) as typeof https.request;
  const payloadFor = (url: string, stream: boolean) => url.includes("systemone")
    ? { model: "jev-1.13-free", state: "hello", questions: { q: { type: "noul", instructions: "Is this a greeting?" } } }
    : url === "/v1/responses" ? { model: "big-pickle", input: "hello", stream }
    : { model: "big-pickle", messages: [{ role: "user", content: "hello" }], max_tokens: 8, stream };
  const checkResponse = async (url: string, stream: boolean) => {
    const result = await app!.inject({ method: "POST", url, headers: client, payload: payloadFor(url, stream) });
    assert.equal(result.statusCode, 200, `${url}: ${result.body}`);
    assertHeaders(result.headers);
    assert.ok(result.body.includes("Hello"), `${url}: expected response text, got ${result.body}`);
    if (stream) {
      assert.match(String(result.headers["content-type"]), /text\/event-stream/);
      assert.equal(result.headers["x-accel-buffering"], "no");
    } else {
      assert.match(String(result.headers["content-type"]), /application\/json/);
      assert.doesNotThrow(() => JSON.parse(result.body));
    }
  };
  for (const useResponses of [false, true]) {
    await setModel("big-pickle", { useResponses });
    wire = useResponses ? "responses" : "chat";
    for (const url of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
      for (const stream of [false, true]) await checkResponse(url, stream);
    }
  }
  await setModel("big-pickle", { useResponses: false });
  for (const [setting, format] of [["reasoningTagModels", "chat"], ["openAiStreamTransformModels", "anthropic"]]) {
    await setSettings({ openAiStreamTransformModels: [], reasoningTagModels: [], [setting!]: ["big-pickle"] });
    wire = format!;
    await checkResponse("/v1/chat/completions", true);
  }
  wire = "systemone";
  for (const url of ["/v1/systemone", "/zen/v1/systemone"]) await checkResponse(url, false);
  await setSettings({ openAiStreamTransformModels: [], reasoningTagModels: [] });
  upstreamStatus = 502;
  const error = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: client, payload: payloadFor("/v1/chat/completions", true) });
  assert.equal(error.statusCode, 502);
  assertHeaders(error.headers);
  console.log("[pass] Chat/Responses/Anthropic JSON and SSE, both upstream protocols, both optional stream converters, System One aliases and raw upstream errors keep transport headers");
} finally {
  globalThis.fetch = originalFetch;
  https.request = originalRequest;
  await app?.close();
  await rm(tempDir, { recursive: true, force: true });
}
