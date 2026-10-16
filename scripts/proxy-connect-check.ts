import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http, { type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeZenAsAnthropic } from "../src/converters/anthropic.js";
import { pipeAnthropicSseAsOpenAI } from "../src/converters/anthropicSseToOpenAi.js";
import { pipeOpenAiStreamStrippingThink } from "../src/converters/openAiThinkTagToReasoning.js";
import { pipeZenOpenAIResponse, requestZenFull, type ZenPreparedRequest } from "../src/providers/zenClient.js";
import { ProxyPoolStore, type ProxyModelTestOptions } from "../src/proxy/proxyPool.js";
import { SettingsStore } from "../src/settings/settingsStore.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "oph-proxy-connect-"));
const sockets = new Set<net.Socket>();
const servers: net.Server[] = [];
const pools: ProxyPoolStore[] = [];
const originalRequest = https.request;
const listen = async (server: net.Server): Promise<number> => {
  servers.push(server);
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
};

try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", path.join(tempDir, "key.pem"), "-out", path.join(tempDir, "cert.pem")], { stdio: "ignore" });
  const key = await readFile(path.join(tempDir, "key.pem"));
  const cert = await readFile(path.join(tempDir, "cert.pem"));
  // Trust only this fixture certificate, without disabling TLS verification.
  https.request = ((options: https.RequestOptions, callback: Parameters<typeof https.request>[1]) => originalRequest({ ...options, ca: cert }, callback)) as typeof https.request;
  let upstreamMode: "valid" | "error" | "empty" = "valid";
  let delayProbe: (() => void) | undefined;
  let probeStarted: (() => void) | undefined;
  const upstreamPort = await listen(https.createServer({ key, cert }, (req, res) => {
    req.resume();
    const respond = () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (upstreamMode === "error") return res.end('data: {"error":{"message":"rate limit exceeded","type":"rate_limit_error"}}\n\n');
      if (upstreamMode === "empty") return res.end("data: [DONE]\n\n");
      if (req.url === "/anthropic") {
        res.end('data: {"type":"message_start","message":{"id":"test","model":"model-a","usage":{"input_tokens":1}}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\ndata: {"type":"message_stop"}\n\n');
      } else {
        res.end('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }
    };
    if (probeStarted) {
      delayProbe = respond;
      probeStarted();
      probeStarted = undefined;
    } else respond();
  }));
  let connectStatus = 429;
  let rejectedConnects = 0;
  const badProxy = http.createServer();
  badProxy.on("connect", (_req, socket) => {
    rejectedConnects += 1;
    if (connectStatus === 200) {
      const target = net.connect(upstreamPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(target).pipe(socket);
      });
      target.on("error", () => socket.destroy());
      socket.once("close", () => target.destroy());
    } else {
      const body = connectStatus === 429
        ? "Error 429: Not Enough Bandwidth. You have exceeded your bandwidth limit.\nbandwidth limit reached"
        : "Proxy handshake rejected";
      socket.end(`HTTP/1.1 ${connectStatus} Proxy Failure\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    }
  });
  const badPort = await listen(badProxy);
  const goodProxy = http.createServer();
  goodProxy.on("connect", (req, socket, head) => {
    // Also serves as the pre-proxy in the chained CONNECT regression.
    const targetPort = req.url === `127.0.0.1:${badPort}` ? badPort : upstreamPort;
    const target = net.connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on("error", () => socket.destroy());
    socket.once("close", () => target.destroy());
  });
  const goodPort = await listen(goodProxy);
  const makePool = (badUrl = `http://127.0.0.1:${badPort}`) => {
    const settings = new SettingsStore(path.join(tempDir, `settings-${pools.length}.json`), { proxyMode: "required" });
    settings.load();
    const file = path.join(tempDir, `proxies-${pools.length}.json`);
    const pool = new ProxyPoolStore(file, settings, { cooldownMs: 0 });
    pool.load();
    pools.push(pool);
    const bad = pool.create({ name: "bad", type: badUrl.startsWith("socks5:") ? "socks5" : "http", url: badUrl, weight: 100 });
    const good = pool.create({ name: "good", url: `http://127.0.0.1:${goodPort}`, weight: 1 });
    return { pool, bad, good, file, settings };
  };
  const prepare = (pool: ProxyPoolStore, excluded: ReadonlySet<string> = new Set(), model = "model-a", requestPath = "/chat"): ZenPreparedRequest => {
    const lease = pool.acquire(excluded, model);
    return { body: JSON.stringify({ model, stream: true }), options: { hostname: "localhost", path: requestPath, method: "POST", agent: lease.agent, timeout: 2000 }, lease };
  };
  const healthOptions: ProxyModelTestOptions = { hostname: "localhost", path: "/chat", model: "probe-model", timeoutMs: 2000, recoveryIntervalMs: 0 };

  for (const status of [429, 407, 502]) {
    connectStatus = status;
    const { pool, bad, good, file, settings } = makePool();
    const response = await requestZenFull(prepare(pool), pool, undefined, (excluded) => prepare(pool, excluded));
    assert.equal(response.status, 200);
    assert.equal(response.data.choices[0].message.content, "OK");
    const failed = pool.list().find((node) => node.id === bad.id)!;
    assert.equal(failed.autoDisabledByConnect, true);
    assert.equal(failed.connectFailureCount, 1);
    assert.equal(failed.currentConcurrency, 0);
    assert.equal(failed.failCount, 1);
    assert.equal(failed.rateLimitStates?.["model-a"], undefined, "CONNECT 429 must not count as model rate limiting");
    assert.match(failed.lastConnectError!, new RegExp(`HTTP ${status}`));
    const otherModel = pool.acquire(new Set(), "model-b");
    assert.equal(otherModel.node?.id, good.id, "CONNECT isolation applies to every model");
    pool.release(good.id, otherModel.leaseId);
    assert.equal(pool.summary().enabled, 1);
    await pool.flush();
    const restored = new ProxyPoolStore(file, settings, { cooldownMs: 0 });
    restored.load();
    assert.equal(restored.list().find((node) => node.id === bad.id)?.autoDisabledByConnect, true);
    const restoredLease = restored.acquire(new Set(), "model-c");
    assert.equal(restoredLease.node?.id, good.id);
    restored.release(good.id, restoredLease.leaseId);
    await restored.flush();
  }
  console.log("[pass] real CONNECT 429/407/502 immediately isolate globally, retry a working proxy and persist across restart");

  connectStatus = 429;
  const refused = net.createServer();
  const refusedPort = await listen(refused);
  await new Promise<void>((resolve) => refused.close(() => resolve()));
  for (const url of [`http://127.0.0.1:${refusedPort}`, `socks5://127.0.0.1:${refusedPort}`]) {
    const { pool, bad } = makePool(url);
    const response = await requestZenFull(prepare(pool), pool, undefined, (excluded) => prepare(pool, excluded));
    assert.equal(response.status, 200);
    assert.equal(pool.list()[0]!.autoDisabledByConnect, true);
  }
  console.log("[pass] HTTP and SOCKS connection refusal isolates and retries");

  upstreamMode = "error";
  connectStatus = 200;
  const modelOnly = makePool();
  assert.equal((await requestZenFull(prepare(modelOnly.pool), modelOnly.pool)).status, 429);
  assert.equal(modelOnly.pool.list()[0]!.autoDisabledByConnect, false);
  assert.equal(modelOnly.pool.list()[0]!.rateLimitStates?.["model-a"]?.consecutiveRateLimitCount, 1);
  upstreamMode = "valid";
  connectStatus = 429;
  const fallback = makePool();
  const heldSuccess = fallback.pool.acquire(new Set(), "another-model");
  const failedLease = fallback.pool.acquire(new Set(), "model-a");
  fallback.pool.markFailure(fallback.bad.id, "Upstream returned HTTP 429", { leaseId: failedLease.leaseId, statusCode: 429, upstreamBody: "bandwidth limit reached", cooldownMs: 60000 });
  fallback.pool.markFailure(fallback.bad.id, "duplicate", { leaseId: failedLease.leaseId, statusCode: 429 });
  fallback.pool.markSuccess(fallback.bad.id, heldSuccess.leaseId);
  assert.equal(fallback.pool.list()[0]!.connectFailureCount, 1);
  assert.equal(fallback.pool.list()[0]!.autoDisabledByConnect, true, "a concurrent older success cannot undo CONNECT isolation");
  assert.deepEqual(await fallback.pool.recoverRateLimitedProxies(healthOptions), { tested: 0, recovered: 0 }, "CONNECT cooldown must finish before probing");
  console.log("[pass] upstream model 429 stays model-scoped; bandwidth fallback, cooldown and idempotent concurrent settlement work");

  const pipelines: Array<[string, (prepared: ZenPreparedRequest, res: ServerResponse, pool: ProxyPoolStore, retry: (excluded: ReadonlySet<string>) => ZenPreparedRequest) => void]> = [
    ["/chat", (p, res, pool, retry) => pipeZenOpenAIResponse(p, true, res, pool, undefined, retry)],
    ["/chat", (p, res, pool, retry) => pipeZenOpenAIResponse(p, false, res, pool, undefined, retry)],
    ["/chat", (p, res, pool, retry) => pipeZenAsAnthropic(p, "model-a", res, 1, pool, undefined, retry)],
    ["/chat", (p, res, pool, retry) => pipeOpenAiStreamStrippingThink(p, "model-a", res, pool, undefined, retry)],
    ["/anthropic", (p, res, pool, retry) => pipeAnthropicSseAsOpenAI(p, "model-a", res, pool, undefined, retry)],
  ];
  for (const badUrl of [`http://127.0.0.1:${badPort}`, `http://127.0.0.1:${refusedPort}`]) {
    for (const [requestPath, pipe] of pipelines) {
      const { pool, bad } = makePool(badUrl);
      const gateway = http.createServer((_req, res) => pipe(prepare(pool, new Set(), "model-a", requestPath), res, pool, (excluded) => prepare(pool, excluded, "model-a", requestPath)));
      const port = await listen(gateway);
      const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /OK/);
      assert.equal(pool.list().find((node) => node.id === bad.id)?.autoDisabledByConnect, true);
    }
  }
  console.log("[pass] passthrough, aggregation, Anthropic conversion and think-tag paths retry CONNECT failures before sending headers");

  const { pool, bad, good, settings } = makePool();
  // Preserve an unrelated model's existing rate-limit isolation during recovery.
  for (let i = 0; i < 5; i++) {
    const lease = pool.acquire(new Set(), "limited-model");
    pool.markFailure(bad.id, "rate limited", { statusCode: 429, leaseId: lease.leaseId });
  }
  await requestZenFull(prepare(pool), pool);
  assert.deepEqual(await pool.recoverRateLimitedProxies(healthOptions), { tested: 1, recovered: 0 });
  assert.equal(pool.list()[0]!.autoDisabledByConnect, true);
  assert.ok(pool.list()[0]!.lastConnectRecoveryTestAt);
  assert.deepEqual(await pool.recoverRateLimitedProxies({ ...healthOptions, recoveryIntervalMs: 60000 }), { tested: 0, recovered: 0 });
  connectStatus = 200;
  for (const mode of ["empty", "error"] as const) {
    upstreamMode = mode;
    assert.deepEqual(await pool.recoverRateLimitedProxies(healthOptions), { tested: 1, recovered: 0 });
    assert.equal(pool.list()[0]!.autoDisabledByConnect, true, "CONNECT 200 alone cannot recover a node");
  }
  upstreamMode = "valid";
  assert.deepEqual(await pool.recoverRateLimitedProxies(healthOptions), { tested: 1, recovered: 1 });
  assert.equal(pool.list()[0]!.autoDisabledByConnect, false);
  assert.equal(pool.list()[0]!.connectFailureCount, 0);
  assert.equal(pool.list()[0]!.rateLimitStates?.["limited-model"]?.autoDisabledBy429, true);
  const recoveredLease = pool.acquire(new Set(), "model-a");
  assert.equal(recoveredLease.node?.id, bad.id);
  pool.release(bad.id, recoveredLease.leaseId);
  console.log("[pass] recovery waits between failures and requires valid model output, preserving other model isolation");

  connectStatus = 429;
  await requestZenFull(prepare(pool), pool);
  pool.update(bad.id, { enabled: false });
  connectStatus = 200;
  assert.deepEqual(await pool.recoverRateLimitedProxies(healthOptions), { tested: 0, recovered: 0 });
  await pool.test(bad.id, healthOptions);
  assert.equal(pool.list()[0]!.enabled, false, "manual health checks must not enable manually disabled nodes");
  pool.update(bad.id, { enabled: true, dailyRequestLimit: pool.list()[0]!.dailyRequestCount, autoDisableWhenDailyLimitReached: true });
  assert.deepEqual(await pool.recoverRateLimitedProxies(healthOptions), { tested: 0, recovered: 0 });
  pool.update(bad.id, { dailyRequestLimit: 0 });
  connectStatus = 429;
  await requestZenFull(prepare(pool), pool);
  connectStatus = 200;
  const started = new Promise<void>((resolve) => { probeStarted = resolve; });
  const recovery = pool.recoverRateLimitedProxies(healthOptions);
  await started;
  pool.update(bad.id, { enabled: false });
  delayProbe!();
  assert.deepEqual(await recovery, { tested: 1, recovered: 0 });
  assert.equal(pool.list()[0]!.enabled, false);
  assert.equal(pool.list()[0]!.autoDisabledByConnect, true);
  console.log("[pass] manual disables, daily limits and edits during recovery are respected");

  const chained = makePool();
  chained.settings.update({ outboundPreProxyEnabled: true, outboundPreProxyUrl: `http://127.0.0.1:${goodPort}` });
  connectStatus = 407;
  await assert.rejects(requestZenFull(prepare(chained.pool), chained.pool), /CONNECT failed with HTTP 407/);
  assert.equal(chained.pool.list()[0]!.autoDisabledByConnect, true);
  assert.match(chained.pool.list()[0]!.lastConnectError!, /HTTP 407/);
  assert.ok(rejectedConnects > 0);
  console.log("[pass] chained HTTP CONNECT preserves failure status and isolates the failing node");
} finally {
  https.request = originalRequest;
  for (const socket of sockets) socket.destroy();
  await Promise.all(pools.map((pool) => pool.flush()));
  await Promise.all(servers.filter((server) => server.listening).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await rm(tempDir, { recursive: true, force: true });
}
