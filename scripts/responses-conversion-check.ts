import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/env.js";
import { prepareZenRequest } from "../src/providers/zenClient.js";
import {
  createOpenAIToResponsesStreamTransformer,
  createResponsesToAnthropicStreamTransformer,
  createResponsesToOpenAIStreamTransformer,
  openAIChatResponseToResponses,
  openAIChatToResponsesRequest,
  normalizeResponsesRequest,
  responsesToOpenAIChatRequest,
  responsesToOpenAIChatResponse,
} from "../src/converters/openAiResponses.js";

const asRecord = (value: unknown): Record<string, any> => value as Record<string, any>;

const chatRequest = {
  model: "responses-model",
  messages: [
    { role: "system", content: "Be concise." },
    { role: "user", content: [{ type: "text", text: "Weather in Ulaanbaatar" }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_weather", type: "function", function: { name: "weather", arguments: "{\"city\":\"Ulaanbaatar\"}" } }] },
    { role: "tool", tool_call_id: "call_weather", content: "Sunny" },
  ],
  tools: [{ type: "function", function: { name: "weather", description: "Get weather", parameters: { type: "object" } } }],
  tool_choice: { type: "function", function: { name: "weather" } },
  max_tokens: 64,
  response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" }, strict: true } },
} as const;

const responsesRequest = openAIChatToResponsesRequest(chatRequest);
assert.equal(responsesRequest.max_output_tokens, 64);
assert.deepEqual(responsesRequest.tool_choice, { type: "function", name: "weather" });
assert.equal(asRecord(responsesRequest.text).format.type, "json_schema");
assert.equal(asRecord(responsesRequest.input).filter((item: any) => item.type === "function_call").length, 1);
assert.equal(asRecord(responsesRequest.input).filter((item: any) => item.type === "function_call_output").length, 1);

const duplicateToolRequest = openAIChatToResponsesRequest({
  model: "responses-model",
  messages: [
    { role: "assistant", content: null, tool_calls: [{ id: "chatcmpl-tool-1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "chatcmpl-tool-1", content: "first" },
    { role: "tool", tool_call_id: "chatcmpl-tool-1", content: "duplicate" },
    { role: "assistant", content: null, tool_calls: [{ id: "chatcmpl-tool-1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
  ],
  max_tokens: 1,
  user: "legacy-user",
} as any);
assert.equal(duplicateToolRequest.max_output_tokens, 16);
assert.equal("user" in duplicateToolRequest, false);
assert.equal(asRecord(duplicateToolRequest.input).filter((item: any) => item.type === "function_call").length, 1);
assert.equal(asRecord(duplicateToolRequest.input).filter((item: any) => item.type === "function_call_output").length, 1);

const normalizedResponses = normalizeResponsesRequest({
  model: "responses-model",
  input: [
    { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
    { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "found" },
    { type: "function_call_output", call_id: "call-1", output: "duplicate" },
  ],
  max_output_tokens: 15.9,
  temperature: null,
  top_p: "0.5",
  user: "legacy-user",
  stop: ["DONE"],
  max_tokens: 8,
} as any);
assert.equal(normalizedResponses.max_output_tokens, 16);
assert.equal("temperature" in normalizedResponses, false);
assert.equal("top_p" in normalizedResponses, false);
assert.equal("user" in normalizedResponses, false);
assert.equal("stop" in normalizedResponses, false);
assert.equal("max_tokens" in normalizedResponses, false);
assert.equal((normalizedResponses.input as unknown[]).length, 2);

const chatFromResponses = responsesToOpenAIChatRequest({
  model: "chat-model",
  instructions: "Follow the policy.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Call the tool" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"test\"}" },
    { type: "function_call_output", call_id: "call_1", output: "found" },
  ],
  tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
  tool_choice: { type: "function", name: "lookup" },
  max_output_tokens: 32,
});
assert.equal(chatFromResponses.messages[0]?.role, "system");
assert.equal(chatFromResponses.messages[2]?.role, "assistant");
assert.equal(chatFromResponses.messages[3]?.role, "tool");
assert.deepEqual(chatFromResponses.tool_choice, { type: "function", function: { name: "lookup" } });
assert.equal(chatFromResponses.max_tokens, 32);

const chatFromDuplicateResponses = responsesToOpenAIChatRequest({
  model: "chat-model",
  input: [
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "found" },
    { type: "function_call_output", call_id: "call_1", output: "duplicate" },
  ],
});
assert.equal(chatFromDuplicateResponses.messages.filter((message: any) => message.role === "tool").length, 1);

const responseFromChat = openAIChatResponseToResponses({
  id: "chatcmpl_1",
  created: 10,
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "Use a tool", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }],
}, "downstream-model");
assert.equal(responseFromChat.object, "response");
assert.equal(asRecord(responseFromChat.usage).total_tokens, 7);
assert.equal(asRecord(responseFromChat.output).filter((item: any) => item.type === "function_call").length, 1);

const chatFromResponse = responsesToOpenAIChatResponse({
  id: "resp_1",
  created_at: 10,
  status: "completed",
  usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
  output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Use a tool" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
  ],
}, "downstream-model");
assert.equal(asRecord(chatFromResponse.choices)[0].finish_reason, "tool_calls");
assert.equal(asRecord(asRecord(chatFromResponse.choices)[0].message).tool_calls[0].function.name, "lookup");

const responseToChatStream = createResponsesToOpenAIStreamTransformer("downstream-model");
const responseToChatOutput = Buffer.concat([
  responseToChatStream.write(Buffer.from("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"created_at\":10,\"status\":\"in_progress\"}}\n\n")),
  responseToChatStream.write(Buffer.from("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"Hel")),
  responseToChatStream.write(Buffer.from("lo\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1,\"total_tokens\":3}}}\n\n")),
  responseToChatStream.flush(),
]).toString();
assert.match(responseToChatOutput, /"content":"Hello"/);
assert.match(responseToChatOutput, /data: \[DONE\]/);
assert.match(responseToChatOutput, /"total_tokens":3/);
assert.match(responseToChatOutput, /"prompt_tokens":2/);

const chatToResponseStream = createOpenAIToResponsesStreamTransformer("downstream-model");
const chatToResponseOutput = Buffer.concat([
  chatToResponseStream.write(Buffer.from("data: {\"id\":\"chatcmpl_1\",\"created\":10,\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n")),
  chatToResponseStream.write(Buffer.from("data: {\"id\":\"chatcmpl_1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\ndata: [DONE]\n\n")),
  chatToResponseStream.flush(),
]).toString();
assert.match(chatToResponseOutput, /event: response.output_text.delta/);
assert.match(chatToResponseOutput, /"delta":"Hi"/);
assert.match(chatToResponseOutput, /event: response.completed/);

const chatToolToResponseStream = createOpenAIToResponsesStreamTransformer("downstream-model");
const chatToolToResponseOutput = Buffer.concat([
  chatToolToResponseStream.write(Buffer.from("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n")),
  chatToolToResponseStream.write(Buffer.from("data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")),
  chatToolToResponseStream.flush(),
]).toString();
assert.match(chatToolToResponseOutput, /event: response.output_item.done/);
assert.doesNotMatch(chatToolToResponseOutput, /response\.function_call_arguments/);

const responseToAnthropicStream = createResponsesToAnthropicStreamTransformer("downstream-model", 2);
const responseToAnthropicOutput = Buffer.concat([
  responseToAnthropicStream.write(Buffer.from("event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"tool_1\",\"name\":\"lookup\"}}\n\n")),
  responseToAnthropicStream.write(Buffer.from("event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"{}\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n")),
  responseToAnthropicStream.flush(),
]).toString();
assert.match(responseToAnthropicOutput, /event: message_start/);
assert.match(responseToAnthropicOutput, /"tool_use"/);
assert.match(responseToAnthropicOutput, /event: message_stop/);

const tempDir = await mkdtemp(path.join(os.tmpdir(), "oph-responses-check-"));
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
    zenPath: "/v1/chat/completions",
    zenResponsesPath: "/v1/responses",
    upstreamTimeoutMs: 1_000,
    globalRequestsPerMinute: 10,
    apiKeyRequestsPerMinute: 10,
    apiKeyMaxConcurrentRequests: 2,
    apiKeyMaxConcurrentStreams: 1,
    redisUrl: "",
    redisKeyPrefix: "responses-check",
    shutdownDrainTimeoutMs: 1_000,
    storePlaintextApiKeys: false,
    proxyMode: "direct",
    outboundPreProxyEnabled: false,
    outboundPreProxyUrl: "",
    proxyHealthCheckModel: "big-pickle",
    proxyHealthCheckTimeoutMs: 1_000,
    proxyRecoveryIntervalMs: 60_000,
  };
  const preparedResponses = prepareZenRequest(config, {
    model: "big-pickle",
    protocol: "responses",
    responseBody: { input: "ping", max_output_tokens: 1, user: "legacy-user" },
    sessionId: "responses-check",
  });
  assert.equal(preparedResponses.options.path, "/v1/responses");
  assert.equal(JSON.parse(preparedResponses.body).model, "big-pickle");
  assert.equal(JSON.parse(preparedResponses.body).max_output_tokens, 16);
  assert.equal("user" in JSON.parse(preparedResponses.body), false);
  const { app } = await buildApp(config);
  const login = await app.inject({ method: "POST", url: "/admin/login", payload: { password: "admin" } });
  assert.equal(login.statusCode, 200);
  const token = JSON.parse(login.body).data.token as string;
  const modelUpdate = await app.inject({
    method: "PUT",
    url: "/admin/models/big-pickle",
    headers: { authorization: `Bearer ${token}` },
    payload: { useResponses: true },
  });
  assert.equal(modelUpdate.statusCode, 200);
  assert.equal(JSON.parse(modelUpdate.body).data.useResponses, true);
  const injected = await app.inject({
    method: "POST",
    url: "/v1/responses",
    payload: { model: "big-pickle", input: "ping" },
  });
  assert.equal(injected.statusCode, 401);
  assert.match(injected.body, /Invalid API key/);
  await app.close();
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("[pass] responses conversion and route checks passed");
