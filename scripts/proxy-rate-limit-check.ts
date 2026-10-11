import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProxyPoolStore } from "../src/proxy/proxyPool.js";
import { SettingsStore } from "../src/settings/settingsStore.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "oph-proxy-rate-limit-"));
try {
  const settings = new SettingsStore(path.join(tempDir, "settings.json"), { proxyMode: "required" });
  settings.load();
  const pool = new ProxyPoolStore(path.join(tempDir, "proxies.json"), settings, { cooldownMs: 0 });
  pool.load();
  const first = pool.create({ name: "first", type: "http", url: "http://127.0.0.1:9101", weight: 100 });
  const second = pool.create({ name: "second", type: "http", url: "http://127.0.0.1:9102", weight: 50 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lease = pool.acquire(new Set(), "model-a");
    assert.equal(lease.node?.id, first.id);
    pool.markFailure(first.id, "rate limited", { statusCode: 429, leaseId: lease.leaseId });
  }
  const firstAfterFour = pool.list().find((node) => node.id === first.id)!;
  assert.equal(firstAfterFour.rateLimitStates?.["model-a"]?.consecutiveRateLimitCount, 4);
  assert.equal(firstAfterFour.rateLimitStates?.["model-a"]?.autoDisabledBy429, false);

  const otherModel = pool.acquire(new Set(), "model-b");
  assert.equal(otherModel.node?.id, first.id, "model-b must not inherit model-a's 429 cooldown");
  pool.release(first.id, otherModel.leaseId);

  const fifth = pool.acquire(new Set(), "model-a");
  assert.equal(fifth.node?.id, first.id);
  pool.markFailure(first.id, "rate limited", { statusCode: 429, leaseId: fifth.leaseId });
  const firstAfterFive = pool.list().find((node) => node.id === first.id)!;
  assert.equal(firstAfterFive.enabled, true, "model-scoped 429 circuit break must not disable the node globally");
  assert.equal(firstAfterFive.rateLimitStates?.["model-a"]?.autoDisabledBy429, true);

  const modelAAfterBreak = pool.acquire(new Set(), "model-a");
  assert.equal(modelAAfterBreak.node?.id, second.id);
  pool.release(second.id, modelAAfterBreak.leaseId);
  const modelBAfterBreak = pool.acquire(new Set(), "model-b");
  assert.equal(modelBAfterBreak.node?.id, first.id);
  pool.release(first.id, modelBAfterBreak.leaseId);

  const cooldownLease = pool.acquire(new Set(), "model-c");
  assert.equal(cooldownLease.node?.id, first.id);
  pool.markFailure(first.id, "temporary upstream failure", { statusCode: 502, cooldownMs: 1000, leaseId: cooldownLease.leaseId });
  const cooldownUntil = Date.parse(pool.list().find((node) => node.id === first.id)!.rateLimitStates?.["model-c"]?.cooldownUntil || "");
  assert.ok(cooldownUntil > Date.now() - 100, "configured cooldown must be applied to model state");

  await pool.flush();
  const restored = new ProxyPoolStore(path.join(tempDir, "proxies.json"), settings);
  restored.load();
  assert.equal(restored.list()[0].rateLimitStates?.["model-a"]?.autoDisabledBy429, true);
  console.log("[pass] 429 counters/cooldown are isolated per model and persist across reload");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
