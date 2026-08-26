const baseUrl = process.env.BASE_URL || "http://127.0.0.1:6446";
const apiKey = process.env.API_KEY || "invalid-smoke-key";

const checks = [
  {
    name: "OpenAI invalid auth shape",
    path: "/v1/chat/completions",
    body: {
      model: "deepseek-v4-flash-free",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 8,
      stop: ["stop"],
      response_format: { type: "text" },
    },
    expectStatus: 401,
    expectJson: (data) => Boolean(data?.error?.message),
  },
  {
    name: "Anthropic invalid auth shape",
    path: "/v1/messages",
    body: {
      model: "deepseek-v4-flash-free",
      max_tokens: 8,
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ["stop"],
      messages: [{ role: "user", content: "ping" }],
    },
    expectStatus: 401,
    expectJson: (data) => data?.type === "error" && Boolean(data?.error?.message),
  },
  {
    name: "Responses invalid auth shape",
    path: "/v1/responses",
    body: {
      model: "deepseek-v4-flash-free",
      input: "ping",
      max_output_tokens: 8,
    },
    expectStatus: 401,
    expectJson: (data) => Boolean(data?.error?.message),
  },
];

let failed = 0;
for (const check of checks) {
  const response = await fetch(`${baseUrl}${check.path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "x-client-id": "protocol-smoke",
      "x-session-id": "protocol-smoke-session",
    },
    body: JSON.stringify(check.body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  const ok = response.status === check.expectStatus && check.expectJson(data);
  if (!ok) {
    failed += 1;
    console.error(`[fail] ${check.name}: status=${response.status} body=${JSON.stringify(data)}`);
  } else {
    console.log(`[pass] ${check.name}`);
  }
}

if (failed > 0) process.exit(1);
