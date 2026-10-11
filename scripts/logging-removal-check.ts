import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { SettingsStore } from "../src/settings/settingsStore.js";

const temp = await mkdtemp(path.join(os.tmpdir(), "oph-logging-"));
const settingsFile = path.join(temp, "settings.json");
const logsDir = path.join(temp, "logs");
let app: Awaited<ReturnType<typeof buildApp>>["app"] | undefined;
const assertRemoved = (settings: object) => {
  for (const key of ["logAudit", "logApiRequests", "logPrompts", "logMaxBodyChars"]) assert.ok(!(key in settings), `${key} must not survive migration/update`);
};
try {
  await writeFile(settingsFile, JSON.stringify({ version: 1, settings: {
    logEnabled: true, logRetentionDays: 9, logAudit: true, logApiRequests: true,
    logPrompts: true, logMaxBodyChars: 500, autoRetryCount: 3,
  } }));
  const store = new SettingsStore(settingsFile);
  store.load();
  assertRemoved(store.get());
  assertRemoved(JSON.parse(await readFile(settingsFile, "utf8")).settings);
  assert.equal(store.get().logEnabled, true);
  assert.equal(store.get().logRetentionDays, 9);
  assert.equal(store.get().autoRetryCount, 3);
  const built = await buildApp({
    ...loadConfig(), host: "127.0.0.1", port: 0, settingsFile, logsDir,
    keysFile: path.join(temp, "keys.json"), modelsFile: path.join(temp, "models.json"),
    modelAliasesFile: path.join(temp, "aliases.json"), proxiesFile: path.join(temp, "proxies.json"),
    adminPassword: "logging-check", redisUrl: "", proxyMode: "direct", outboundPreProxyEnabled: false,
    proxyRecoveryIntervalMs: 3_600_000, shutdownDrainTimeoutMs: 1000,
  });
  app = built.app;
  const login = await app.inject({ method: "POST", url: "/admin/login", payload: { password: "logging-check" } });
  assert.equal(login.statusCode, 200);
  const headers = { authorization: `Bearer ${login.json().data.token}` };
  const update = await app.inject({ method: "PATCH", url: "/admin/settings", headers, payload: { logAudit: true, logApiRequests: true } });
  assert.equal(update.statusCode, 200);
  assertRemoved(update.json().data);
  assertRemoved((await app.inject({ url: "/admin/settings", headers })).json().data);
  assertRemoved(JSON.parse(await readFile(settingsFile, "utf8")).settings);
  const created = await app.inject({ method: "POST", url: "/admin/api-keys", headers, payload: { name: "logging-check" } });
  assert.equal(created.statusCode, 201);
  // A parser error still reaches the retained error logger, without request bodies.
  const error = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload: "{" });
  assert.equal(error.statusCode, 400);
  let files: string[] = [];
  for (let i = 0; i < 100; i++) {
    files = await readdir(logsDir).catch(() => []);
    if (files.some((file) => file.startsWith("errors-"))) break;
    await setTimeout(10);
  }
  assert.ok(files.some((file) => file.startsWith("errors-")), "error file logging remains available");
  assert.ok(files.every((file) => file.startsWith("errors-")), "admin operations must not create audit/request files");
  console.log("[pass] legacy log settings removed from disk/API, old clients cannot restore them, admin audit removed and error logging retained");
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
