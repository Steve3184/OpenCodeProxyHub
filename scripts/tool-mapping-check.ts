import assert from "node:assert/strict";
import { prepareZenRequest } from "../src/providers/zenClient.ts";
import { createToolNameMapper, toUpstreamTools } from "../src/converters/toolMapping.ts";
import { aggregateUpstreamBody } from "../src/converters/streamAggregator.ts";
import { createResponsesToOpenAIStreamTransformer, createOpenAIToResponsesStreamTransformer, openAIChatResponseToResponses, responsesToOpenAIChatResponse, openAIChatToResponsesRequest, responsesToOpenAIChatRequest } from "../src/converters/openAiResponses.ts";
import { openAIToAnthropic } from "../src/converters/anthropic.ts";

const config = { zenHost: "example.invalid", zenPath: "/zen/v1/chat/completions", zenResponsesPath: "/zen/v1/responses", upstreamTimeoutMs: 1000 };

const bodyOf = (prepared) => JSON.parse(prepared.body);

// --- 1. upstream body always streams and always carries read + bash ---------
{
  const mapper = createToolNameMapper([
    { type: "function", function: { name: "Read", description: "read a file", parameters: {} } },
    { type: "function", function: { name: "Bash", description: "run a command", parameters: {} } },
    { type: "function", function: { name: "Grep", description: "search", parameters: {} } },
  ]);
  const prepared = prepareZenRequest(config, {
    model: "m", stream: false, sessionId: "ses_x", toolMapper: mapper,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "Read", description: "read a file", parameters: {} } }],
  });
  const body = bodyOf(prepared);
  assert.equal(body.stream, true, "stream must be forced true");
  const names = body.tools.map((t) => t.function.name);
  assert.deepEqual(names, ["read", "bash"], `expected read+bash, got ${names}`);
  assert.equal(body.tools[1].function.description.includes("Placeholder"), true, "bash is a marked placeholder");
  assert.equal(body.tools[0].function.description, "read a file", "declared Read keeps its description");
  console.log("[pass] chat body: stream=true, Read->read, placeholder bash injected");
}

// --- 2. Bash -> bash (case-insensitive, only these two) --------------------
{
  const mapper = createToolNameMapper([{ type: "function", function: { name: "Bash", parameters: {} } }, { type: "function", function: { name: "ReadFile", parameters: {} } }]);
  assert.equal(mapper.toUpstream("Bash"), "bash");
  assert.equal(mapper.toUpstream("bash"), "bash");
  assert.equal(mapper.toUpstream("BASH"), "bash");
  assert.equal(mapper.toUpstream("Read"), "read");
  assert.equal(mapper.toUpstream("ReadFile"), "ReadFile", "other tools untouched");
  assert.equal(mapper.toUpstream("Grep"), "Grep");
  assert.equal(mapper.toDownstream("bash"), "Bash", "restores the client's spelling");
  assert.equal(mapper.toDownstream("read"), undefined, "Read was never declared -> placeholder");
  assert.equal(mapper.toDownstream("Grep"), "Grep");
  console.log("[pass] case mapping only affects read/bash");
}

// --- 3. responses upstream body --------------------------------------------
{
  const mapper = createToolNameMapper([{ type: "function", name: "Read", parameters: {} }]);
  const prepared = prepareZenRequest(config, {
    model: "m", stream: false, sessionId: "ses_x", toolMapper: mapper, protocol: "responses",
    responseBody: { model: "m", stream: false, input: [{ type: "function_call", call_id: "c1", name: "Read", arguments: "{}" }], tools: [{ type: "function", name: "Read", parameters: {} }] },
  });
  const body = bodyOf(prepared);
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools.map((t) => t.name), ["read", "bash"]);
  assert.equal(body.input[0].name, "read", "history function_call renamed");
  console.log("[pass] responses body: stream=true, input history renamed, placeholders added");
}

// --- 4. responses -> openai chat: reverse mapping + drop --------------------
{
  const declared = createToolNameMapper([{ type: "function", function: { name: "Read", parameters: {} } }]);
  const chat = responsesToOpenAIChatResponse({
    id: "resp_1", status: "completed", output: [
      { type: "function_call", call_id: "c1", name: "read", arguments: "{\"p\":1}" },
      { type: "function_call", call_id: "c2", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
    ],
  }, "alias", declared);
  assert.equal(chat.choices[0].message.tool_calls.length, 1, "placeholder bash call dropped");
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, "Read", "read -> client spelling");
  assert.equal(chat.choices[0].finish_reason, "tool_calls");
  console.log("[pass] responses->chat: read->Read, undeclared bash dropped");
}

// --- 5. chat -> responses: reverse mapping + drop + finish_reason ----------
{
  const declared = createToolNameMapper([{ type: "function", function: { name: "Bash", parameters: {} } }]);
  const response = openAIChatResponseToResponses({
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }, { id: "c2", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
  }, "alias", declared);
  const calls = response.output.filter((i) => i.type === "function_call");
  assert.equal(calls.length, 1, "undeclared read call dropped");
  assert.equal(calls[0].name, "Bash");
  console.log("[pass] chat->responses: bash->Bash, undeclared read dropped");
}

// --- 6. aggregator folds upstream SSE into a complete response -------------
{
  const chatSse = [
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"he"}}]}',
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"llo"}}]}',
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"p\\""}}]}}]}',
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":7}}',
    "data: [DONE]",
    "",
  ].join("\n\n");
  const aggregated = aggregateUpstreamBody(chatSse, "chat_completions");
  assert.equal(aggregated.choices[0].message.content, "hello");
  assert.equal(aggregated.choices[0].message.tool_calls[0].function.name, "read");
  assert.equal(aggregated.choices[0].message.tool_calls[0].function.arguments, '{"p":1}');
  assert.equal(aggregated.choices[0].finish_reason, "tool_calls");
  assert.equal(aggregated.usage.total_tokens, 7);

  const respSse = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_9","object":"response","status":"in_progress","model":"m","output":[]}}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"hi"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_9","object":"response","status":"completed","model":"m","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"total_tokens":3}}}',
    "",
  ].join("\n\n");
  const aggregatedResp = aggregateUpstreamBody(respSse, "responses");
  assert.equal(aggregatedResp.id, "resp_9");
  assert.equal(aggregatedResp.output[0].content[0].text, "hi");
  console.log("[pass] aggregator folds chat + responses SSE");
}

// --- 7. responses->chat stream transformer reverse mapping ----------------
{
  const declared = createToolNameMapper([{ type: "function", function: { name: "Read", parameters: {} } }]);
  const transformer = createResponsesToOpenAIStreamTransformer("alias", declared);
  const input = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"c1","name":"read","arguments":""}}',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"c2","name":"bash","arguments":""}}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"cmd\\":\\"ls\\"}"}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"p\\":1}"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}',
    "",
  ].join("\n\n");
  const out = transformer.write(Buffer.from(input)).toString();
  assert.ok(out.includes('"name":"Read"'), `expected Read in ${out}`);
  assert.ok(!out.includes('"name":"bash"'), "placeholder bash call not emitted");
  assert.ok(!out.includes('{\\"cmd\\":\\"ls\\"}'), "dropped call's arguments not emitted");
  assert.ok(out.includes('{\\"p\\":1}'), "kept call's arguments emitted");
  assert.ok(out.includes('"finish_reason":"tool_calls"'), "finish_reason kept");
  console.log("[pass] responses->chat stream: reverse mapped, placeholder dropped");
}

// --- 8. chat->responses stream transformer --------------------------------
{
  const declared = createToolNameMapper([{ type: "function", function: { name: "Bash", parameters: {} } }]);
  const transformer = createOpenAIToResponsesStreamTransformer("alias", declared);
  const input = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"bash","arguments":"{\\"c\\":1}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"c2","type":"function","function":{"name":"read","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    "data: [DONE]",
    "",
  ].join("\n\n");
  const out = transformer.write(Buffer.from(input)).toString();
  assert.ok(out.includes('"name":"Bash"'), `expected Bash in ${out}`);
  assert.ok(!out.includes('"name":"read"'), "placeholder read dropped");
  assert.ok(!out.includes('"call_id":"c2"'), "dropped item not in output");
  console.log("[pass] chat->responses stream: bash->Bash, placeholder dropped");
}

// --- 9. anthropic non-stream reverse mapping + drop ------------------------
{
  const declared = createToolNameMapper([{ type: "function", function: { name: "Read", parameters: {} } }]);
  const result = openAIToAnthropic({
    choices: [{ message: { content: "ok", tool_calls: [{ id: "t1", function: { name: "read", arguments: "{}" } }, { id: "t2", function: { name: "bash", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
  }, "alias", 3, declared);
  const uses = result.content.filter((b) => b.type === "tool_use");
  assert.equal(uses.length, 1);
  assert.equal(uses[0].name, "Read");
  assert.equal(result.stop_reason, "tool_use");
  console.log("[pass] anthropic non-stream: read->Read, placeholder bash dropped");
}

// --- 10. tools without read/bash get both placeholders --------------------
{
  const mapper = createToolNameMapper([{ type: "function", function: { name: "Grep", parameters: {} } }]);
  const tools = toUpstreamTools([{ type: "function", function: { name: "Grep", parameters: {} } }], mapper, "chat");
  assert.deepEqual(tools.map((t) => t.function.name), ["Grep", "read", "bash"]);
  for (const tool of tools.slice(1)) {
    assert.ok(tool.function.description.includes("must never be called"), "placeholder is marked uncallable");
  }
  console.log("[pass] placeholder tools are marked as uncallable");
}

console.log("\nall tool-mapping checks passed");
