import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/env.js";

// Regression check: systemone-only models (jev) must be refused on the
// chat-shaped downstreams with a message pointing at /v1/systemone, instead
// of being forwarded to an upstream that can only answer with an opaque
// 500 (convert_request_failed).

const tempDir = await mkdtemp(path.join(os.tmpdir(), "oph-systemone-check-"));
try {
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    keysFile: path.join(tempDir, "keys.json"),
    modelsFile: path.join(tempDir, "models.json"),
    modelAliasesFile: path.join(tempDir, "aliases.json"),
    settingsFile: path.join(tempDir, "settings.json"),
    proxiesFile: path.join(tempDir, "proxies.json"),
    logsDir: path.join(tempDir, "logs"),
    adminPassword: "admin",
    zenHost: "example.invalid",
    zenPath: "/zen/v1/chat/completions",
    zenResponsesPath: "/zen/v1/responses",
    zenSystemonePath: "/zen/v1/systemone",
    upstreamTimeoutMs: 2_000,
    globalRequestsPerMinute: 1000,
    apiKeyRequestsPerMinute: 1000,
    apiKeyMaxConcurrentRequests: 10,
    apiKeyMaxConcurrentStreams: 10,
    redisUrl: "",
    redisKeyPrefix: "systemone-check",
    shutdownDrainTimeoutMs: 1_000,
    storePlaintextApiKeys: true,
    proxyMode: "direct",
    outboundPreProxyEnabled: false,
    outboundPreProxyUrl: "",
    proxyHealthCheckModel: "big-pickle",
    proxyHealthCheckTimeoutMs: 1_000,
    proxyRecoveryIntervalMs: 60_000,
  };
  const { app, keyStore, modelAliasStore } = await buildApp(config);
  const created = keyStore.create("systemone-check");
  const headers = { authorization: `Bearer ${created.key}` };
  const rejected = (body: Record<string, unknown>, label: string): void => {
    assert.equal(body && typeof body === "object" && "error" in body, true, `${label}: expected an error body`);
    const message = (body as { error: { message?: string } }).error?.message || "";
    assert.ok(message.includes("System One") && message.includes("/v1/systemone"), `${label}: expected systemone hint, got ${message}`);
  };

  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
    payload: { model: "jev-1.13-free", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(chat.statusCode, 400, `chat jev should be refused locally, got ${chat.statusCode}: ${chat.body}`);
  rejected(JSON.parse(chat.body), "chat");
  console.log("[pass] chat completions refuses systemone-only model with /v1/systemone hint");

  const responses = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers,
    payload: { model: "jev-1.13-free", input: "hi" },
  });
  assert.equal(responses.statusCode, 400, `responses jev should be refused locally, got ${responses.statusCode}: ${responses.body}`);
  rejected(JSON.parse(responses.body), "responses");
  console.log("[pass] responses refuses systemone-only model with /v1/systemone hint");

  const messages = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers,
    payload: { model: "jev-1.13-free", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(messages.statusCode, 400, `anthropic jev should be refused locally, got ${messages.statusCode}: ${messages.body}`);
  const anthropicBody = JSON.parse(messages.body) as { type?: string; error?: { message?: string } };
  assert.equal(anthropicBody.type, "error", "anthropic error keeps its envelope");
  assert.ok(
    typeof anthropicBody.error?.message === "string" && anthropicBody.error.message.includes("/v1/systemone"),
    `anthropic error should hint /v1/systemone, got ${messages.body}`,
  );
  console.log("[pass] anthropic refuses systemone-only model in the anthropic envelope");

  // Aliases that resolve to jev are refused too, and the message names the downstream id.
  modelAliasStore.update({ aliases: [{ downstreamModelId: "cc-jev", upstreamModelId: "jev-1.13-free" }] });
  const aliased = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
    payload: { model: "cc-jev", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(aliased.statusCode, 400);
  assert.ok(
    (JSON.parse(aliased.body) as { error: { message: string } }).error.message.includes("cc-jev"),
    `alias error should name the downstream id, got ${aliased.body}`,
  );
  console.log("[pass] aliases resolving to jev are refused with the downstream name");

  // A regular model still passes the gate (it will fail on the dead upstream,
  // but must never be rejected as systemone-only).
  const regular = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
    payload: { model: "big-pickle", messages: [{ role: "user", content: "hi" }] },
  });
  assert.notEqual(regular.statusCode, 400);
  assert.ok(!regular.body.includes("/v1/systemone"), `regular model must not hit the gate: ${regular.body.slice(0, 200)}`);
  console.log(`[pass] regular models are not gated (got ${regular.statusCode}, not a local 400)`);

  // NewAPI's TypeSafe channel forwards to /zen/v1/systemone, so that path must
  // be a real route sharing the same handler (not a 404, not a redirect).
  const systemonePayload = {
    model: "jev-1.13-free",
    state: "hi",
    questions: { q: { type: "noul", instructions: "Is this a greeting?" } },
  };
  const canonical = await app.inject({ method: "POST", url: "/v1/systemone", headers, payload: systemonePayload });
  const alias = await app.inject({ method: "POST", url: "/zen/v1/systemone", headers, payload: systemonePayload });
  assert.notEqual(alias.statusCode, 404, `/zen/v1/systemone must not be a 404 (got ${alias.statusCode}: ${alias.body})`);
  assert.equal(alias.statusCode, canonical.statusCode, `/zen/v1/systemone must share the handler with /v1/systemone (alias ${alias.statusCode} vs canonical ${canonical.statusCode})`);
  console.log(`[pass] /zen/v1/systemone alias routes to the same handler (got ${alias.statusCode})`);

  await app.close();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("\nall systemone routing checks passed");
