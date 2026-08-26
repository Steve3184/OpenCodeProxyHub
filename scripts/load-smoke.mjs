const baseUrl = process.env.BASE_URL || "http://127.0.0.1:6446";
const total = Number.parseInt(process.env.LOAD_TOTAL || "80", 10);
const concurrency = Number.parseInt(process.env.LOAD_CONCURRENCY || "16", 10);

const requestBodies = [
  {
    name: "openai-invalid-auth",
    path: "/v1/chat/completions",
    body: { model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "ping" }], max_tokens: 4 },
  },
  {
    name: "anthropic-invalid-auth",
    path: "/v1/messages",
    body: { model: "deepseek-v4-flash-free", max_tokens: 4, messages: [{ role: "user", content: "ping" }] },
  },
  {
    name: "responses-invalid-auth",
    path: "/v1/responses",
    body: { model: "deepseek-v4-flash-free", input: "ping", max_output_tokens: 4 },
  },
];

let next = 0;
let passed = 0;
let failed = 0;
const started = Date.now();

const runOne = async (index) => {
  const item = requestBodies[index % requestBodies.length];
  const response = await fetch(`${baseUrl}${item.path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer invalid-load-${index}`,
      "Content-Type": "application/json",
      "x-client-id": `load-client-${index % concurrency}`,
      "x-session-id": `load-session-${index}`,
    },
    body: JSON.stringify(item.body),
  });
  if (response.status === 401) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`[fail] ${item.name} index=${index} status=${response.status}`);
};

const worker = async () => {
  while (next < total) {
    const index = next;
    next += 1;
    try {
      await runOne(index);
    } catch (error) {
      failed += 1;
      console.error(`[fail] request index=${index} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
const durationMs = Date.now() - started;
console.log(JSON.stringify({ total, concurrency, passed, failed, durationMs, requestsPerSecond: Number((total / (durationMs / 1000)).toFixed(2)) }, null, 2));
if (failed > 0) process.exit(1);
