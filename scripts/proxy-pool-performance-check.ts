import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProxyPoolStore } from "../src/proxy/proxyPool.js";
import { SettingsStore } from "../src/settings/settingsStore.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "oph-proxy-pool-"));
try {
  const proxiesFile = path.join(tempDir, "proxies.json");
  const settings = new SettingsStore(path.join(tempDir, "settings.json"), { proxyMode: "required" });
  settings.load();

  const pool = new ProxyPoolStore(proxiesFile, settings, { persistDebounceMs: 60 });
  pool.load();
  const proxy = pool.create({ name: "test", type: "http", url: "http://127.0.0.1:8080" });
  assert.equal(fs.existsSync(`${proxiesFile}.state.log`), false, "high-frequency updates should be debounced");

  const lease = pool.acquire();
  assert.equal(lease.node?.id, proxy.id);
  pool.markSuccess(proxy.id, lease.leaseId, 200);
  pool.recordTokenUsage(proxy.id, 123);
  await pool.flush();

  const config = JSON.parse(fs.readFileSync(proxiesFile, "utf8")) as { version: number; proxies: Record<string, unknown>[] };
  assert.equal(config.version, 2);
  assert.equal("dailyRequestCount" in config.proxies[0], false, "dynamic state must not be written to the static config");
  const journal = fs.readFileSync(`${proxiesFile}.state.log`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { id: string; state?: { successCount: number; totalTokens: number } });
  const savedState = journal.findLast((entry) => entry.id === proxy.id)?.state;
  assert.deepEqual(savedState && { successCount: savedState.successCount, totalTokens: savedState.totalTokens }, { successCount: 1, totalTokens: 123 });

  const reloaded = new ProxyPoolStore(proxiesFile, settings);
  reloaded.load();
  const restored = reloaded.list()[0];
  assert.equal(restored.successCount, 1);
  assert.equal(restored.totalTokens, 123);

  assert.equal(reloaded.delete(proxy.id), true);
  await reloaded.flush();
  const afterDelete = new ProxyPoolStore(proxiesFile, settings);
  afterDelete.load();
  assert.equal(afterDelete.list().length, 0, "deleted proxies must not be resurrected from the state journal");

  fs.writeFileSync(proxiesFile, JSON.stringify({
    version: 2,
    proxies: [{ id: "static-only", name: "static-only", type: "http", url: "http://127.0.0.1:8081", enabled: true, weight: 1, maxConcurrency: 1, dailyRequestLimit: 0, autoDisableWhenDailyLimitReached: false }],
  }));
  const staticOnly = new ProxyPoolStore(proxiesFile, settings);
  staticOnly.load();
  const defaults = staticOnly.list()[0];
  assert.equal(defaults.successCount, 0);
  assert.equal(defaults.currentConcurrency, 0);
  console.log("[pass] proxy config/state separation, debounced persistence, reload and delete recovery");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
