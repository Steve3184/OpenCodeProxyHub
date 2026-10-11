import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const distribution = process.argv[2];
if (!distribution) throw new Error("Usage: node scripts/binary-smoke.mjs <distribution directory>");
const temp = await mkdtemp(path.join(os.tmpdir(), "oph-binary-"));
let child;
try {
  // Run an isolated copy with no node_modules or source tree available.
  await cp(path.resolve(distribution), temp, { recursive: true });
  child = spawn(path.join(temp, "opencode-proxy-hub"), [], {
    cwd: temp,
    env: {
      PATH: "/usr/bin:/bin", NODE_ENV: "production", PROXY_HOST: "127.0.0.1", PROXY_PORT: "0",
      ADMIN_PASSWORD: "binary-smoke-only", PROXY_MODE: "direct", REDIS_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Binary did not listen within 20 seconds")), 20_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Binary exited during startup: ${code}`)); });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
      const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.stderr.on("data", (data) => process.stderr.write(data));
  });
  const request = (url, options) => fetch(`${base}${url}`, { ...options, signal: AbortSignal.timeout(5000) });
  const health = await request("/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  const ui = await request("/app/");
  assert.equal(ui.status, 200);
  const html = await ui.text();
  const asset = html.match(/src="([^\"]+\.js)"/)?.[1];
  assert.ok(asset, "packaged UI includes its JavaScript entry");
  const js = await request(asset);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  const bundle = await js.text();
  assert.ok(!bundle.includes("记录管理审计") && !bundle.includes("记录 AI 请求摘要"));
  const login = await request("/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "binary-smoke-only" }) });
  assert.equal(login.status, 200);
  const { data: { token } } = await login.json();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const settings = await request("/admin/settings", { headers });
  assert.equal(settings.status, 200);
  const { data } = await settings.json();
  assert.ok(!("logAudit" in data) && !("logApiRequests" in data));
  const key = await request("/admin/api-keys", { method: "POST", headers, body: JSON.stringify({ name: "binary-check" }) });
  assert.equal(key.status, 201, "key generation and bundled crypto work");
  const models = await request("/v1/models");
  assert.equal(models.status, 200);
  assert.ok(Array.isArray((await models.json()).data));
  console.log("[pass] standalone binary: health, packaged UI/assets, admin authentication/settings, key creation and model list");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(killTimer);
  }
  await rm(temp, { recursive: true, force: true });
}
