import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  proxyRecoveryIntervalMs: 3_600_000, proxyCooldownMs: 0, shutdownDrainTimeoutMs: 1000,
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
  const fresh = new ModelConfigStore(path.join(tempDir, "fresh-models.json"));
  fresh.load();
  assert.equal(fresh.list().some((model) => model.id === "mimo-v2.5-free"), false);
  assert.ok(fresh.list().filter((model) => model.id.startsWith("muse-")).every((model) => model.useResponses && model.responsesOnly));
  const muse = "muse-spark-1.3-contributor-free";
  const newMuse = "muse-future-free";
  await writeFile(config.modelsFile, JSON.stringify({ version: 1, models: [
    { id: "mimo-v2.5-free", enabled: true, ownedBy: "saved-owner", created: 1, displayName: "Saved MiMo" },
    { id: muse, enabled: true, ownedBy: "saved-owner", created: 2, useResponses: false },
    { id: "muse-spark-1.2-contributor-free", enabled: false, ownedBy: "saved-owner", created: 3 },
  ] }));
  const built = await buildApp(config);
  app = built.app;
  const migrated = (JSON.parse(await readFile(config.modelsFile, "utf8")) as { models: ModelConfig[] }).models;
  assert.equal(migrated.find((model) => model.id === "mimo-v2.5-free")?.enabled, false);
  assert.match(migrated.find((model) => model.id === "mimo-v2.5-free")?.displayName || "", /^Saved MiMo \(retired:/);
  assert.equal(migrated.find((model) => model.id === muse)?.useResponses, true);
  assert.equal(migrated.find((model) => model.id === "muse-spark-1.2-contributor-free")?.enabled, false);
  assert.equal(migrated.find((model) => model.id === "muse-spark-1.2-contributor-free")?.useResponses, true);
  assert.ok(migrated.every((model) => model.responsesOnly === undefined));
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
  const refused = await app.inject({ method: "PUT", url: `/admin/models/${muse}`, headers: admin, payload: { enabled: false, useResponses: false } });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error.message, /only supports the Responses/);
  const afterRefused = ((await app.inject({ url: "/admin/models", headers: admin })).json().data as ModelConfig[]).find((model) => model.id === muse);
  assert.equal(afterRefused?.enabled, true, "Rejected protocol edits must not partially change the model");
  assert.equal(afterRefused?.useResponses, true);
  console.log("[pass] fresh defaults omit retired MiMo; saved models migrate without changing Muse enabled states; Chat overrides are refused atomically");
  await setModel("big-pickle", { enabled: false, useResponses: true, displayName: "My disabled model" });
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
    return Response.json({ data: ["big-pickle", "mimo-v2.5-free", "custom-free", "discovered-free", muse, newMuse, "deepseek-v4-flash-free", "paid-model"].map((id) => ({ id, owned_by: "updated-owner", created: 1234567890 })) });
  };
  for (let i = 0; i < 2; i++) {
    const sync = await app.inject({ method: "POST", url: "/admin/models/sync-free", headers: admin });
    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().data.synced, 5);
    assert.equal(sync.json().data.models.includes("mimo-v2.5-free"), false);
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
  assert.equal(catalog.some((m) => m.id === "deepseek-v4-flash-free"), false);
  for (const id of [muse, newMuse]) {
    const model = catalog.find((m) => m.id === id);
    assert.equal(model?.enabled, true);
    assert.equal(model?.useResponses, true);
    assert.equal(model?.responsesOnly, true);
  }
  const settings = (await app.inject({ url: "/admin/settings", headers: admin })).json().data;
  assert.deepEqual(settings.openAiStreamTransformModels, ["big-pickle"]);
  assert.deepEqual(settings.reasoningTagModels, ["mimo-v2.5-free"]);
  const reloaded = new ModelConfigStore(config.modelsFile);
  reloaded.load();
  assert.equal(reloaded.isEnabled("big-pickle"), false);
  assert.equal(reloaded.isEnabled("mimo-v2.5-free"), false);
  assert.equal(reloaded.usesResponses("big-pickle"), true);
  assert.equal(reloaded.usesResponses(muse), true);
  assert.equal(reloaded.usesResponses(newMuse), true);
  assert.deepEqual(reloaded.list(), catalog, "Repeated startup preserves migration results");
  const publicModels = await app.inject({ url: "/v1/models" });
  assertHeaders(publicModels.headers);
  assert.equal(publicModels.json().data.some((m: ModelConfig) => m.id === "big-pickle"), false);
  assert.equal(publicModels.json().data.some((m: ModelConfig) => m.id === "mimo-v2.5-free"), false);
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
  let upstreamError: string | undefined;
  let splitError = false;
  const capturedRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const chatBody = 'data: {"id":"test","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const anthropicBody = 'event: message_start\ndata: {"type":"message_start","message":{"id":"test","usage":{"input_tokens":1}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const responsesBody = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}]}}\n\n';
  https.request = ((options: https.RequestOptions, callback: (response: EventEmitter) => void) => {
    assert.equal((options.headers as Record<string, string>)["Accept-Encoding"], "identity");
    let requestBody = "";
    const request = new EventEmitter() as EventEmitter & { write: (chunk: string | Buffer) => void; end: () => void; destroy: () => void };
    request.write = (chunk) => { requestBody += chunk.toString(); };
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      capturedRequests.push({ path: String(options.path), body: JSON.parse(requestBody) });
      const response = Object.assign(new EventEmitter(), { statusCode: upstreamStatus, resume: () => {} });
      callback(response);
      const body = upstreamError ?? (upstreamStatus !== 200 ? '{"error":{"message":"test upstream error"}}' : wire === "anthropic" ? anthropicBody : wire === "responses" ? responsesBody : wire === "systemone" ? '{"answer":"Hello"}' : chatBody);
      if (splitError) {
        const middle = Math.floor(body.length / 2);
        response.emit("data", Buffer.from(body.slice(0, middle)));
        response.emit("data", Buffer.from(body.slice(middle)));
      } else response.emit("data", Buffer.from(body));
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
  built.modelAliasStore.update({ aliases: [{ downstreamModelId: "friendly-muse", upstreamModelId: muse }] });
  wire = "responses";
  for (const model of [muse, newMuse, "friendly-muse"]) {
    for (const url of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
      for (const stream of [false, true]) {
        const before = capturedRequests.length;
        const result = await app.inject({ method: "POST", url, headers: client, payload: { ...payloadFor(url, stream), model } });
        assert.equal(result.statusCode, 200, `${model} ${url}: ${result.body}`);
        assert.equal(capturedRequests.length, before + 1);
        const upstream = capturedRequests.at(-1)!;
        assert.equal(upstream.path, config.zenResponsesPath);
        assert.equal(upstream.body.model, model === "friendly-muse" ? muse : model);
        assert.ok(upstream.body.input);
        assert.equal(upstream.body.messages, undefined);
        assert.equal(upstream.body.stream, true);
        assert.ok(result.body.includes("Hello"));
        if (stream) {
          assert.match(String(result.headers["content-type"]), /text\/event-stream/);
          assert.ok(result.body.includes(url === "/v1/chat/completions" ? "[DONE]" : url === "/v1/responses" ? "response.completed" : "message_stop"));
        } else {
          const body = result.json();
          const text = url === "/v1/chat/completions" ? body.choices[0].message.content : url === "/v1/responses" ? body.output[0].content[0].text : body.content[0].text;
          assert.equal(text, "Hello");
        }
      }
    }
  }
  console.log("[pass] saved, newly synced and aliased Muse models use Responses upstream across all three downstream protocols, streaming and JSON");
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

  // Exercise real pool accounting through every public protocol and converter.
  await setSettings({ proxyMode: "required" });
  for (const port of [9001, 9002]) {
    const created = await app.inject({ method: "POST", url: "/admin/proxies", headers: admin,
      payload: { name: `test-${port}`, type: "http", url: `http://127.0.0.1:${port}`, maxConcurrency: 10, dailyRequestLimit: 0 } });
    assert.equal(created.statusCode, 201);
  }
  const getProxies = async () => (await app!.inject({ url: "/admin/proxies", headers: admin })).json().data.items;
  const checkProviderError = async (url: string, stream: boolean, message: string, status: number) => {
    const result = await app!.inject({ method: "POST", url, headers: client, payload: payloadFor(url, stream) });
    assert.equal(result.statusCode, status, `${url}: ${result.body}`);
    assert.equal(result.json().error.message, message, `${url}: preserve the provider message without a suffix`);
    for (const node of await getProxies()) {
      assert.equal(node.enabled, true);
      assert.equal(node.autoDisabledBy429, false);
      assert.equal(node.consecutiveRateLimitCount, 0);
      assert.equal(node.failCount, 0);
      assert.equal(node.successCount, 0);
      assert.equal(node.cooldownUntil, null);
      assert.equal(node.currentConcurrency, 0, "Console errors must release leases");
    }
  };
  for (const status of [429, 503, 200]) {
    upstreamStatus = status;
    splitError = status !== 200;
    const message = `Error from provider (Console): ${status === 503 ? "Service unavailable." : "Rate limit exceeded. Please try again later."}`;
    upstreamError = JSON.stringify({ error: { message } });
    const expectedStatus = status === 200 ? 429 : status;
    for (const useResponses of [false, true]) {
      await setModel("big-pickle", { useResponses });
      for (const url of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
        for (const stream of [false, true]) await checkProviderError(url, stream, message, expectedStatus);
      }
    }
    await setModel("big-pickle", { useResponses: false });
    for (const setting of ["reasoningTagModels", "openAiStreamTransformModels"]) {
      await setSettings({ openAiStreamTransformModels: [], reasoningTagModels: [], [setting]: ["big-pickle"] });
      await checkProviderError("/v1/chat/completions", true, message, expectedStatus);
    }
    await setSettings({ openAiStreamTransformModels: [], reasoningTagModels: [] });
    for (const url of ["/v1/systemone", "/zen/v1/systemone"]) await checkProviderError(url, false, message, expectedStatus);
  }
  console.log("[pass] Console errors preserve messages and never penalize proxies across protocols, stream converters, retries and split error bodies");

  // Ordinary limits still trip the five-429 rule for this model after cooldowns.
  upstreamStatus = 429;
  const message = "Rate limit exceeded. Please try again later.";
  upstreamError = JSON.stringify({ error: { type: "FreeUsageLimitError", message } });
  for (let i = 0; i < 5; i++) {
    const result = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: client,
      payload: payloadFor("/v1/chat/completions", true) });
    assert.equal(result.statusCode, 429);
    assert.equal(result.json().error.message, message);
  }
  for (const node of await getProxies()) {
    assert.equal(node.enabled, true);
    assert.equal(node.rateLimitStates?.["big-pickle"]?.autoDisabledBy429, true);
    assert.equal(node.rateLimitStates?.["big-pickle"]?.consecutiveRateLimitCount, 5);
    assert.equal(node.currentConcurrency, 0);
  }
  console.log("[pass] ordinary anonymous 429s still isolate the affected model after five failures without appending a message suffix");
} finally {
  globalThis.fetch = originalFetch;
  https.request = originalRequest;
  await app?.close();
  await rm(tempDir, { recursive: true, force: true });
}
