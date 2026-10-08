import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {
  EXO_FREE_CLAUDE_MAX_BACKEND_RETRIES,
  ExoStreamGate,
  classifyExoBackendFromAggregated,
  classifyExoBackendFromSseText,
  isExoClaudeGateApplicable,
} from "../src/providers/exoClaudeGate.ts";
import { pipeZenOpenAIResponse } from "../src/providers/zenClient.ts";
import { DEFAULT_MODEL_ALIASES, ModelAliasStore } from "../src/models/aliases.ts";
import { ModelConfigStore } from "../src/models/catalog.ts";

// --- 1. id classification ---------------------------------------------------
{
  const claudeChunk = 'data: {"id":"msg_abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n';
  const gptChunk = 'data: {"id":"resp_xyz","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n';
  assert.equal(classifyExoBackendFromSseText(claudeChunk), "claude");
  assert.equal(classifyExoBackendFromSseText(gptChunk), "gpt");
  // Nested response id (Responses-shaped payload).
  assert.equal(classifyExoBackendFromSseText('data: {"type":"response.created","response":{"id":"resp_nested"}}\n\n'), "gpt");
  assert.equal(classifyExoBackendFromSseText('data: {"type":"response.created","response":{"id":"msg_nested"}}\n\n'), "claude");
  // Error bodies must never look like a GPT backend.
  assert.equal(classifyExoBackendFromSseText('{"error":{"message":"rate limit"}}'), "claude");
  // No id yet / partial JSON -> unknown.
  assert.equal(classifyExoBackendFromSseText('data: {"choices":[]}\n\n'), "unknown");
  assert.equal(classifyExoBackendFromSseText('data: {"id":"msg_'), "unknown");
  assert.equal(classifyExoBackendFromAggregated({ id: "resp_done" }), "gpt");
  console.log("[pass] msg_/resp_ classification, nested ids, error bodies and partial chunks");
}

// --- 2. applicability -------------------------------------------------------
{
  assert.equal(isExoClaudeGateApplicable(JSON.stringify({ model: "exo-free", messages: [] })), true);
  assert.equal(isExoClaudeGateApplicable(JSON.stringify({ model: "big-pickle", messages: [] })), false);
  assert.equal(isExoClaudeGateApplicable(JSON.stringify({ model: "exo-free", input: "hi" })), false);
  assert.equal(isExoClaudeGateApplicable(JSON.stringify({ model: "exo-free", input: "hi" }), true), false);
  console.log("[pass] gate applies only to chat-shaped exo-free bodies");
}

// --- 3. incremental stream gate --------------------------------------------
{
  const gate = new ExoStreamGate();
  assert.equal(gate.push(Buffer.from('data: {"id":"msg_')), "pending", "partial id stays pending");
  assert.equal(gate.push(Buffer.from('1","choices":[]}\n\n')), "claude", "completed id decides Claude");
  assert.equal(gate.decided, true);
  assert.equal(Buffer.concat(gate.drain()).toString(), 'data: {"id":"msg_1","choices":[]}\n\n', "buffered chunks replay in order");

  const gptGate = new ExoStreamGate();
  assert.equal(gptGate.push(Buffer.from('data: {"id":"resp_1","choices":[]}\n\n')), "gpt");
  console.log("[pass] ExoStreamGate buffers until the first classifiable id");
}

// --- 4. streaming pipe retries GPT then streams Claude ----------------------
const runPipe = async (responses: string[]): Promise<{ output: string; requestIds: string[] }> => {
  const originalRequest = https.request;
  const requestIds: string[] = [];
  let call = 0;
  (https as any).request = function (options: any, cb: any) {
    requestIds.push(String(options.headers?.["x-opencode-request"] || ""));
    const req = new EventEmitter() as any;
    req.write = () => true;
    req.destroy = () => {};
    req.end = () => {
      const sse = responses[Math.min(call, responses.length - 1)];
      call += 1;
      const upstream: any = new EventEmitter();
      upstream.statusCode = 200;
      upstream.resume = () => {};
      setTimeout(() => {
        cb(upstream);
        upstream.emit("data", Buffer.from(sse));
        upstream.emit("end");
      }, 0);
    };
    return req;
  };
  const written: string[] = [];
  const res: any = new EventEmitter();
  res.setMaxListeners(EXO_FREE_CLAUDE_MAX_BACKEND_RETRIES + 5);
  res.writeHead = () => { res.headersSent = true; };
  res.headersSent = false;
  res.write = (value: string) => { written.push(value.toString()); return true; };
  res.end = (value?: string) => { if (value) written.push(value.toString()); };
  const prepared: any = {
    body: JSON.stringify({ model: "exo-free", messages: [{ role: "user", content: "hi" }], stream: true }),
    options: { headers: { "x-opencode-request": "req-0" } },
  };
  const retryPrepare = (): any => ({
    body: prepared.body,
    options: { headers: { "x-opencode-request": `req-${call}` } },
  });
  try {
    pipeZenOpenAIResponse(prepared, true, res, undefined, undefined, retryPrepare as any, 0, undefined, undefined, undefined, false, 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    (https as any).request = originalRequest;
  }
  return { output: written.join(""), requestIds };
};

{
  const gpt = 'data: {"id":"resp_gpt","choices":[{"index":0,"delta":{"content":"nope"}}]}\n\n';
  const claude = 'data: {"id":"msg_ok","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
  const { output, requestIds } = await runPipe([gpt, gpt, claude]);
  assert.equal(requestIds.length, 3, `expected 3 upstream attempts, got ${requestIds.length}`);
  assert.equal(new Set(requestIds).size, requestIds.length, "each retry uses a fresh x-opencode-request");
  assert.equal(output.includes("hello"), true, "Claude stream is forwarded");
  assert.equal(output.includes("nope"), false, "GPT content is never forwarded");
  console.log("[pass] streaming pipe retries GPT with fresh request ids and forwards Claude");
}

// --- 5. retry budget exhaustion --------------------------------------------
{
  const gpt = 'data: {"id":"resp_gpt","choices":[{"index":0,"delta":{"content":"nope"}}]}\n\n';
  const { output, requestIds } = await runPipe([gpt]);
  assert.equal(requestIds.length, EXO_FREE_CLAUDE_MAX_BACKEND_RETRIES + 1, `expected ${EXO_FREE_CLAUDE_MAX_BACKEND_RETRIES + 1} attempts`);
  assert.equal(output.includes("resp_") || output.includes("GPT"), true, "exhaustion surfaces a clear error");
  console.log(`[pass] gives up after ${EXO_FREE_CLAUDE_MAX_BACKEND_RETRIES} backend retries`);
}

// --- 6. default alias + catalog --------------------------------------------
{
  assert.deepEqual(
    DEFAULT_MODEL_ALIASES.find((alias) => alias.downstreamModelId === "claude-opus-5.5"),
    { downstreamModelId: "claude-opus-5.5", upstreamModelId: "exo-free" },
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oph-exo-"));
  try {
    const aliases = new ModelAliasStore(path.join(dir, "model-aliases.json"));
    aliases.load();
    assert.equal(aliases.resolveUpstream("claude-opus-5.5"), "exo-free");
    assert.equal(aliases.isAllowed("claude-opus-5.5"), true);
    aliases.update({ aliases: [{ downstreamModelId: "custom", upstreamModelId: "big-pickle" }] });
    assert.equal(aliases.resolveUpstream("claude-opus-5.5"), "exo-free", "default alias survives admin updates");
    assert.equal(aliases.resolveUpstream("custom"), "big-pickle");

    const models = new ModelConfigStore(path.join(dir, "models.json"));
    models.load();
    assert.equal(models.isEnabled("exo-free"), true, "exo-free enabled by default");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("[pass] exo-free enabled; claude-opus-5.5 -> exo-free alias present and persistent");
}
