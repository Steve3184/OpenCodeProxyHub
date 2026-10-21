import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { ModelConfigStore, RETIRED_MODELS, type ModelConfig } from "../src/models/catalog.js";

const newlyRetiredIds = [
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "step-5-preview-free",
  "space-bunny-free",
  "ll-alpha-free",
];

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
  globalRequestsPerMinute: 10000, apiKeyRequestsPerMinute: 10000,
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
  for (const id of newlyRetiredIds) {
    assert.ok(RETIRED_MODELS.some((model) => model.id === id), `${id} must be retired`);
    assert.equal(fresh.list().some((model) => model.id === id), false, `${id} must not be a fresh default`);
  }
  assert.equal(new Set(RETIRED_MODELS.map((model) => model.id)).size, RETIRED_MODELS.length);
  assert.ok(fresh.list().filter((model) => model.id.startsWith("muse-")).every((model) => model.useResponses && model.responsesOnly));
  const muse = "muse-current-free";
  const newMuse = "muse-future-free";
  await writeFile(config.modelsFile, JSON.stringify({ version: 1, models: [
    ...newlyRetiredIds.map((id) => ({
      id, enabled: id !== "muse-spark-1.2-contributor-free", ownedBy: "saved-owner", created: 1,
      displayName: id === "mimo-v2.5-free" ? "Saved MiMo" : undefined,
    })),
    { id: muse, enabled: true, ownedBy: "saved-owner", created: 2, useResponses: false },
  ] }));
  const built = await buildApp(config);
  app = built.app;
  const migrated = (JSON.parse(await readFile(config.modelsFile, "utf8")) as { models: ModelConfig[] }).models;
  for (const id of newlyRetiredIds) {
    const model = migrated.find((model) => model.id === id);
    assert.equal(model?.enabled, false, `${id} must be disabled on startup`);
    if (id !== "muse-spark-1.2-contributor-free") assert.match(model?.displayName || "", /\(retired:/);
  }
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
  assert.equal(migrated.find((model) => model.id === "muse-spark-1.2-contributor-free")?.displayName, undefined);
  console.log("[pass] fresh defaults omit all seven retired models; startup disables saved retired models and preserves manual choices; Muse Chat overrides are refused atomically");
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
    return Response.json({ data: ["big-pickle", ...RETIRED_MODELS.map((model) => model.id), "custom-free", "discovered-free", muse, newMuse, "paid-model"].map((id) => ({ id, owned_by: "updated-owner", created: 1234567890 })) });
  };
  for (let i = 0; i < 2; i++) {
    const sync = await app.inject({ method: "POST", url: "/admin/models/sync-free", headers: admin });
    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().data.synced, 5);
    assert.deepEqual(sync.json().data.models, ["big-pickle", "custom-free", "discovered-free", muse, newMuse]);
    assertHeaders(sync.headers);
  }
  const catalog = (await app.inject({ url: "/admin/models", headers: admin })).json().data as ModelConfig[];
  assert.equal(catalog.find((m) => m.id === "big-pickle")?.enabled, false);
  for (const id of newlyRetiredIds) {
    const model = catalog.find((m) => m.id === id);
    assert.equal(model?.enabled, false, `${id} must stay disabled after sync`);
    assert.equal(model?.ownedBy, "saved-owner", `${id} metadata must not be synced`);
    assert.equal(model?.created, 1);
    assert.equal(model?.displayName, migrated.find((m) => m.id === id)?.displayName);
  }
  for (const { id } of RETIRED_MODELS) {
    if (!newlyRetiredIds.includes(id)) assert.equal(catalog.some((m) => m.id === id), false, `${id} must not be imported`);
  }
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
  for (const id of newlyRetiredIds) assert.equal(reloaded.isEnabled(id), false);
  assert.equal(reloaded.usesResponses("big-pickle"), true);
  assert.equal(reloaded.usesResponses(muse), true);
  assert.equal(reloaded.usesResponses(newMuse), true);
  assert.deepEqual(reloaded.list(), catalog, "Repeated startup preserves migration results");
  const publicModels = await app.inject({ url: "/v1/models" });
  assertHeaders(publicModels.headers);
  assert.equal(publicModels.json().data.some((m: ModelConfig) => m.id === "big-pickle"), false);
  for (const id of newlyRetiredIds) {
    assert.equal(publicModels.json().data.some((m: ModelConfig) => m.id === id), false, `${id} must not be listed publicly`);
  }
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
  let chunkSize = 0;
  const upstreamReplies: Array<{ status: number; body: string }> = [];
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
      const queued = upstreamReplies.shift();
      const response = Object.assign(new EventEmitter(), { statusCode: queued?.status ?? upstreamStatus, resume: () => {} });
      callback(response);
      const body = queued?.body ?? upstreamError ?? (upstreamStatus !== 200 ? '{"error":{"message":"test upstream error"}}' : wire === "anthropic" ? anthropicBody : wire === "responses" ? responsesBody : wire === "systemone" ? '{"answer":"Hello"}' : chatBody);
      if (chunkSize) {
        const bytes = Buffer.from(body);
        for (let i = 0; i < bytes.length; i += chunkSize) response.emit("data", bytes.subarray(i, i + chunkSize));
      } else if (splitError) {
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

  const reportedMessage = "Upstream returned HTTP 429";
  const reportedError = JSON.stringify({ error: { message: reportedMessage, type: "rate_limit_error", code: "rate_limit_exceeded" } });
  const errorEvent = `event: error\ndata: ${reportedError}\n\n`;
  const paths = ["/v1/chat/completions", "/v1/responses", "/v1/messages"];
  const routes = paths.flatMap((url) => [false, true].flatMap((useResponses) => [false, true].map((stream) => ({ url, useResponses, stream, setting: "", wire: useResponses ? "responses" : "chat" }))));
  routes.push(...["reasoningTagModels", "openAiStreamTransformModels"].map((setting) => ({ url: paths[0]!, useResponses: false, stream: true, setting, wire: setting === "openAiStreamTransformModels" ? "anthropic" : "chat" })));
  routes.push(...["/v1/systemone", "/zen/v1/systemone"].map((url) => ({ url, useResponses: false, stream: false, setting: "", wire: "systemone" })));
  await setSettings({ autoRetryCount: 1 });
  let caseId = 0;
  const configureRoute = async (route: typeof routes[number], model: string) => {
    await setModel(model, { enabled: true, useResponses: route.useResponses });
    await setSettings({ openAiStreamTransformModels: [], reasoningTagModels: [], ...(route.setting ? { [route.setting]: [model] } : {}) });
    wire = route.wire;
  };
  const injectRoute = (route: typeof routes[number], model: string) => app!.inject({ method: "POST", url: route.url, headers: client, payload: { ...payloadFor(route.url, route.stream), model } });
  for (const format of ["http-json", "http-sse", "json", "sse", "sse-crlf", "sse-eof", "responses-failed", "code-only", "message-only"]) {
    for (const route of routes) {
      const model = `rate-limit-${caseId++}-free`;
      await configureRoute(route, model);
      upstreamStatus = format.startsWith("http-") ? 429 : 200;
      upstreamError = format.endsWith("json") ? reportedError
        : format === "code-only" ? `data: ${JSON.stringify({ error: { message: reportedMessage, code: "rate_limit_exceeded" } })}\n\n`
        : format === "message-only" ? `data: ${JSON.stringify({ error: { message: reportedMessage } })}\n\n`
        : format === "responses-failed" ? `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: JSON.parse(reportedError).error } })}\n\n`
        : format === "sse-crlf" ? `: keepalive\r\n\r\nevent: error\r\ndata:${reportedError}\r\n\r\n`
        : format === "sse-eof" ? errorEvent.trimEnd() : errorEvent;
      // Byte-sized chunks split prefixes, JSON fields, and CRLF event boundaries.
      chunkSize = 1;
      const before = await getProxies();
      for (let attempt = 1; attempt <= 5; attempt++) {
        const requestsBefore = capturedRequests.length;
        const result = await injectRoute(route, model);
        assert.equal(result.statusCode, 429, `${format} ${route.url} ${route.setting}: ${result.body}`);
        assert.equal(result.json().error.message, reportedMessage);
        assert.equal(capturedRequests.length - requestsBefore, 2, "each failed attempt retries once on a different node");
        for (const node of await getProxies()) {
          const previous = before.find((item: any) => item.id === node.id);
          assert.equal(node.failCount - previous.failCount, attempt, "a lease must be penalized exactly once");
          assert.equal(node.successCount, previous.successCount, "errors must never be settled as success");
          assert.equal(node.rateLimitStates?.[model]?.consecutiveRateLimitCount, attempt);
          assert.equal(node.rateLimitStates?.[model]?.autoDisabledBy429, attempt === 5);
          assert.equal(node.currentConcurrency, 0);
          assert.equal(node.enabled, true, "429 isolation is scoped to the affected model");
        }
      }
      const requestsBefore = capturedRequests.length;
      assert.ok((await injectRoute(route, model)).statusCode >= 500);
      assert.equal(capturedRequests.length, requestsBefore, "isolated nodes must not receive a sixth request");
    }
  }
  console.log("[pass] exact reported 429 JSON and HTTP-200 SSE errors (byte splits, CRLF, EOF, Responses failures) isolate each affected model after five failures across every protocol and converter");

  for (const route of routes) {
    const model = `retry-success-${caseId++}-free`;
    await configureRoute(route, model);
    upstreamReplies.push({ status: 200, body: errorEvent }, { status: 200, body: wire === "anthropic" ? anthropicBody : wire === "responses" ? responsesBody : wire === "systemone" ? '{"answer":"Hello"}' : chatBody });
    const before = await getProxies();
    const requestsBefore = capturedRequests.length;
    const result = await injectRoute(route, model);
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(result.body.includes("Hello"));
    assert.equal(capturedRequests.length - requestsBefore, 2);
    const after = await getProxies();
    assert.equal(after.reduce((sum: number, node: any) => sum + node.failCount, 0) - before.reduce((sum: number, node: any) => sum + node.failCount, 0), 1);
    assert.equal(after.reduce((sum: number, node: any) => sum + node.successCount, 0) - before.reduce((sum: number, node: any) => sum + node.successCount, 0), 1);
    assert.ok(after.every((node: any) => node.currentConcurrency === 0));
  }
  console.log("[pass] an initial SSE 429 retries onto a healthy node and settles failure/success leases once across every protocol and converter");

  for (const route of routes.filter((item) => item.stream)) {
    const model = `late-error-${caseId++}-free`;
    await configureRoute(route, model);
    const prefix = wire === "anthropic" ? anthropicBody.split("event: message_stop")[0]
      : wire === "responses" ? responsesBody.split("event: response.completed")[0]
      : chatBody.split('data: {"id":"test","choices"')[0];
    upstreamStatus = 200;
    upstreamError = prefix + errorEvent;
    const before = await getProxies();
    const requestsBefore = capturedRequests.length;
    for (let i = 0; i < 10; i++) {
      const result = await injectRoute(route, model);
      assert.equal(result.statusCode, 200, "an open SSE stream retains its HTTP status");
      assert.ok(result.body.includes(reportedMessage), "the client must receive the late error");
      assert.ok(!result.body.includes("[DONE]") && !result.body.includes("message_stop") && !result.body.includes("response.completed"), "an error must not be followed by a successful completion");
    }
    assert.equal(capturedRequests.length - requestsBefore, 10, "open streams must not retry or duplicate output");
    for (const node of await getProxies()) {
      assert.equal(node.rateLimitStates?.[model]?.autoDisabledBy429, true);
      assert.equal(node.rateLimitStates?.[model]?.consecutiveRateLimitCount, 5);
      assert.equal(node.successCount, before.find((item: any) => item.id === node.id).successCount);
      assert.equal(node.currentConcurrency, 0);
    }
  }
  console.log("[pass] late SSE errors terminate with an error, do not retry or emit success, and still trigger model isolation");

  for (const route of routes) {
    const model = `console-sse-${caseId++}-free`;
    await configureRoute(route, model);
    const message = "Error from provider (Console): Rate limit exceeded. 稍后重试。";
    for (const type of ["error", "response.failed"]) {
      const error = { message, type: "rate_limit_error" };
      const payload = type === "response.failed" ? { type, response: { error } } : { error };
      upstreamError = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const status of [200, 429]) {
        upstreamStatus = status;
        const before = await getProxies();
        const result = await injectRoute(route, model);
        assert.equal(result.statusCode, 429, result.body);
        assert.equal(result.json().error.message, message);
        for (const node of await getProxies()) {
          assert.equal(node.failCount, before.find((item: any) => item.id === node.id).failCount, "Console provider errors must not penalize proxies");
          assert.equal(node.rateLimitStates?.[model]?.consecutiveRateLimitCount ?? 0, 0);
          assert.equal(node.currentConcurrency, 0);
        }
      }
    }
  }
  console.log("[pass] split UTF-8 Console errors retain their message and never penalize proxies when wrapped as SSE");
} finally {
  globalThis.fetch = originalFetch;
  https.request = originalRequest;
  await app?.close();
  await rm(tempDir, { recursive: true, force: true });
}
