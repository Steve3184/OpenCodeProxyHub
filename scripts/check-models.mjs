import https from "node:https";
import crypto from "node:crypto";

const ZEN_HOST = "opencode.ai";
const ZEN_PATH = "/zen/v1/chat/completions";
const SYSTEMONE_PATH = "/zen/v1/systemone";
const OC_VERSION = "1.15.0";
const TIMEOUT_MS = 120000;

const MODELS = [
  "big-pickle",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "mimo-v2.6-flash-free",
  "jev-1.13-free",
];

const ocId = (prefix) => {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
};

const testModel = (model) => {
  return new Promise((resolve) => {
    const started = Date.now();
    const systemone = model === "jev-1.13-free";
    const body = JSON.stringify(systemone ? {
      model,
      state: "Reply with exactly: OK",
      questions: { answer: { type: "choice", instructions: "What is the answer?", criteria: { ok: "The answer is OK" } } },
    } : {
      model,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      stream: false,
    });
    const options = {
      hostname: ZEN_HOST,
      port: 443,
      path: systemone ? SYSTEMONE_PATH : ZEN_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: "Bearer public",
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": ocId("msg"),
        "x-opencode-session": ocId("ses"),
      },
      timeout: TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const durationMs = Date.now() - started;
        const raw = Buffer.concat(chunks).toString();
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({
          model,
          status: res.statusCode,
          durationMs,
          data,
          raw: raw.slice(0, 500),
        });
      });
    });

    req.on("error", (error) => {
      resolve({
        model,
        status: 0,
        durationMs: Date.now() - started,
        data: null,
        raw: `ERROR: ${error.message}`,
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        model,
        status: 0,
        durationMs: Date.now() - started,
        data: null,
        raw: "TIMEOUT",
      });
    });

    req.write(body);
    req.end();
  });
};

const formatDuration = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const padRight = (str, len) => str.padEnd(len);
const padLeft = (str, len) => str.padStart(len);

const startTime = Date.now();

console.log("=".repeat(80));
console.log("OpenCode Zen Free Model Availability Test");
console.log(`Host: ${ZEN_HOST}${ZEN_PATH}`);
console.log(`Time: ${new Date().toISOString()}`);
console.log(`Models to test: ${MODELS.length}`);
console.log("=".repeat(80));
console.log("");

const results = [];
for (const model of MODELS) {
  const idx = MODELS.indexOf(model) + 1;
  process.stdout.write(`[${idx}/${MODELS.length}] Testing: ${model} ... `);
  const result = await testModel(model);
  results.push(result);

  if (result.status === 200 && result.data?.choices?.[0]?.message?.content) {
    const content = result.data.choices[0].message.content.slice(0, 50);
    console.log(`✅ ${result.status} | ${formatDuration(result.durationMs)} | reply: "${content}"`);
  } else if (result.status === 200) {
    console.log(`✅ ${result.status} | ${formatDuration(result.durationMs)} | (response received)`);
  } else {
    const errMsg = result.data?.error?.message || result.data?.type || result.raw?.slice(0, 150);
    console.log(`❌ ${result.status} | ${formatDuration(result.durationMs)} | ${errMsg}`);
  }
}

const totalDuration = Date.now() - startTime;

console.log("");
console.log("=".repeat(80));
console.log("SUMMARY");
console.log("=".repeat(80));
console.log("");

const available = results.filter(r => r.status === 200 && (r.model === "jev-1.13-free" ? Boolean(r.data?.answers) : r.data?.choices?.length > 0));
const failed = results.filter(r => !(r.status === 200 && (r.model === "jev-1.13-free" ? Boolean(r.data?.answers) : r.data?.choices?.length > 0)));

console.log(`✅ Available: ${available.length}/${results.length}`);
console.log(`❌ Failed:     ${failed.length}/${results.length}`);
console.log(`⏱️  Total time: ${formatDuration(totalDuration)}`);
console.log("");

if (available.length > 0) {
  console.log("Available models:");
  for (const r of available) {
    console.log(`  ✓ ${padRight(r.model, 30)} ${padLeft(formatDuration(r.durationMs), 8)}`);
  }
  console.log("");
}

if (failed.length > 0) {
  console.log("Failed models:");
  for (const r of failed) {
    const detail = r.data?.error?.message || r.data?.type || `HTTP ${r.status}`;
    console.log(`  ✗ ${padRight(r.model, 30)} ${padLeft(formatDuration(r.durationMs), 8)}  ${detail.slice(0, 60)}`);
  }
  console.log("");
}

if (failed.length === 0) {
  console.log("🎉 All models are available!");
} else {
  console.log("⚠️  Some models are not available.");
  process.exitCode = 1;
}
