import fs from "node:fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { loadConfig } from "../dist/config/env.js";
import { DEFAULT_MODELS, SYSTEMONE_ONLY_MODELS, isResponsesOnlyModel } from "../dist/models/catalog.js";
import { responsesToOpenAIChatResponse } from "../dist/converters/openAiResponses.js";
import { prepareZenRequest, requestZenFull } from "../dist/providers/zenClient.js";
import { createToolNameMapper } from "../dist/converters/toolMapping.js";
import { ocSessionId } from "../dist/utils/ids.js";

// Share production headers, identifiers, tool declarations and SSE aggregation.
const config = loadConfig();
const ZEN_HOST = config.zenHost;
const ZEN_PATH = config.zenPath;
const requestedModels = process.argv.slice(2);
const MODELS = requestedModels.length ? requestedModels : [...DEFAULT_MODELS];
const proxyUrl = process.env.PROXY_URL_FILE
  ? fs.readFileSync(process.env.PROXY_URL_FILE, "utf8").split(String.fromCharCode(10)).map(line => line.trim()).find(Boolean)
  : process.env.PROXY_URL;
if (process.env.PROXY_URL_FILE && !proxyUrl) throw new Error("PROXY_URL_FILE contains no proxy URL");
if (!proxyUrl && config.proxyMode === "required") throw new Error("Set PROXY_URL_FILE or PROXY_URL when PROXY_MODE=required");
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { timeout: config.upstreamTimeoutMs }) : undefined;

const testModel = async (model) => {
  const started = Date.now();
  const systemone = SYSTEMONE_ONLY_MODELS.has(model);
  const responses = isResponsesOnlyModel(model);
  const protocol = systemone ? "systemone" : responses ? "responses" : "chat_completions";
  const prepared = prepareZenRequest(config, {
    model, sessionId: ocSessionId(), toolMapper: createToolNameMapper([]),
    protocol,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    parameters: { max_tokens: 512 },
    ...(systemone ? { responseBody: {
      state: "Reply with exactly: OK",
      questions: { answer: { type: "choice", instructions: "What is the answer?", criteria: { ok: "The answer is OK" } } },
    } } : responses ? { responseBody: { input: "Reply with exactly: OK", max_output_tokens: 512 } } : {}),
  });
  if (agent) prepared.options.agent = agent;
  try {
    const response = await requestZenFull(prepared, undefined, undefined, undefined, 0, protocol);
    if (responses && response.status === 200 && !response.data?.error && response.data?.type !== "error") {
      response.data = responsesToOpenAIChatResponse(response.data, model);
    }
    return { model, ...response, durationMs: Date.now() - started };
  } catch {
    // Transport exception text can contain a proxy credential.
    return { model, status: 0, durationMs: Date.now() - started, data: { error: { message: "Upstream transport failed (connection or timeout)" } }, raw: "Transport failure" };
  }
};

const formatDuration = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const padRight = (str, len) => str.padEnd(len);
const padLeft = (str, len) => str.padStart(len);

const isAvailable = (result) => result.status === 200
  && !result.data?.error && result.data?.type !== "error"
  && (SYSTEMONE_ONLY_MODELS.has(result.model)
    ? result.data?.answers && typeof result.data.answers === "object"
    : result.data?.choices?.some(choice => typeof choice.message?.content === "string" && choice.message.content.trim()));

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

  if (isAvailable(result) && result.data?.choices?.[0]?.message?.content) {
    const content = result.data.choices[0].message.content.slice(0, 50);
    console.log(`✅ ${result.status} | ${formatDuration(result.durationMs)} | reply: "${content}"`);
  } else if (isAvailable(result)) {
    console.log(`✅ ${result.status} | ${formatDuration(result.durationMs)} | (response received)`);
  } else {
    const errMsg = result.data?.error?.message || result.data?.type || "No usable response output";
    console.log(`❌ ${result.status} | ${formatDuration(result.durationMs)} | ${errMsg}`);
  }
}

const totalDuration = Date.now() - startTime;

console.log("");
console.log("=".repeat(80));
console.log("SUMMARY");
console.log("=".repeat(80));
console.log("");

const available = results.filter(isAvailable);
const failed = results.filter(r => !isAvailable(r));

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

agent?.destroy();
