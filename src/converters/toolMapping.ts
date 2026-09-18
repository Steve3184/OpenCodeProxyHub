/**
 * Upstream (OpenCode Zen) only accepts requests that declare the `read` and
 * `bash` tools, matched case-sensitively. Downstream clients spell them
 * `Read`/`Bash`, so every outbound request rewrites those two names to the
 * upstream spelling and every inbound response maps them back to the names the
 * client actually declared. Only these two tools are touched; everything else
 * passes through untouched.
 *
 * When the client never declared one of them the request still has to carry the
 * upstream name (the gate demands it), so a placeholder definition is injected
 * and marked as uncallable. If the model calls it anyway the call is dropped
 * from the response.
 */

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined => (
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined
);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const UPSTREAM_READ_TOOL = "read";
export const UPSTREAM_BASH_TOOL = "bash";

export type UpstreamToolKind = "read" | "bash";

const placeholderDescription = (name: string): string =>
  `Placeholder for the "${name}" tool. It is NOT available in this session and must never be called: this declaration only exists to satisfy the upstream API contract. Calling it has no effect and any such call is discarded.`;

const upstreamKind = (name: unknown): UpstreamToolKind | undefined => {
  if (typeof name !== "string") return undefined;
  const lower = name.toLowerCase();
  if (lower === UPSTREAM_READ_TOOL) return UPSTREAM_READ_TOOL;
  if (lower === UPSTREAM_BASH_TOOL) return UPSTREAM_BASH_TOOL;
  return undefined;
};

/** Reads a tool name from either the Chat Completions or the Responses shape. */
export const toolNameOf = (tool: unknown): string | undefined => {
  const record = asObject(tool);
  if (!record) return undefined;
  const fn = asObject(record.function);
  if (typeof fn?.name === "string") return fn.name;
  return typeof record.name === "string" ? record.name : undefined;
};

export interface ToolNameMapper {
  /** Downstream tool name -> the name sent upstream. Non read/bash names are unchanged. */
  toUpstream(name: unknown): string;
  /** Upstream tool name -> the downstream name, or undefined when the client never declared it (drop the call). */
  toDownstream(name: unknown): string | undefined;
}

/**
 * Builds a mapper from the tools the client declared, so the reverse direction
 * can restore the client's own spelling (`Read`, `READ`, ...) instead of a
 * hardcoded one.
 */
export const createToolNameMapper = (tools: unknown): ToolNameMapper => {
  const declared: { read: string | undefined; bash: string | undefined } = { read: undefined, bash: undefined };
  for (const tool of asArray(tools)) {
    const name = toolNameOf(tool);
    const kind = upstreamKind(name);
    if (kind && declared[kind] === undefined && typeof name === "string") declared[kind] = name;
  }
  return {
    toUpstream(name) {
      if (typeof name !== "string") return "";
      return upstreamKind(name) ?? name;
    },
    toDownstream(name) {
      if (typeof name !== "string") return undefined;
      const kind = upstreamKind(name);
      // Not one of ours: leave other tools exactly as the model named them.
      if (!kind) return name;
      // Declared by the client -> its own spelling; otherwise a placeholder call to drop.
      return declared[kind];
    },
  };
};

const placeholderTool = (name: UpstreamToolKind, shape: "chat" | "responses"): JsonObject => {
  const description = placeholderDescription(name);
  const parameters = { type: "object", properties: {} };
  if (shape === "responses") return { type: "function", name, description, parameters };
  return { type: "function", function: { name, description, parameters } };
};

const renameTool = (tool: unknown, mapper: ToolNameMapper): unknown => {
  const record = asObject(tool);
  if (!record) return tool;
  const fn = asObject(record.function);
  if (fn && typeof fn.name === "string") {
    return { ...record, function: { ...fn, name: mapper.toUpstream(fn.name) } };
  }
  if (typeof record.name === "string") {
    return { ...record, name: mapper.toUpstream(record.name) };
  }
  return tool;
};

/**
 * Rewrites the declared tools to the upstream spelling and guarantees that both
 * `read` and `bash` are present, appending a marked placeholder when the client
 * did not declare one.
 */
export const toUpstreamTools = (tools: unknown, mapper: ToolNameMapper, shape: "chat" | "responses"): unknown[] => {
  const renamed = asArray(tools).map((tool) => renameTool(tool, mapper));
  const present = new Set<string>();
  for (const tool of renamed) {
    const name = toolNameOf(tool);
    if (typeof name === "string") present.add(name);
  }
  const result = [...renamed];
  for (const name of [UPSTREAM_READ_TOOL, UPSTREAM_BASH_TOOL] as const) {
    if (!present.has(name)) result.push(placeholderTool(name, shape));
  }
  return result;
};

/** Rewrites a tool_choice that names one of the two mapped tools. */
export const toUpstreamToolChoice = (toolChoice: unknown, mapper: ToolNameMapper): unknown => {
  const record = asObject(toolChoice);
  if (!record) return toolChoice;
  const fn = asObject(record.function);
  if (fn && typeof fn.name === "string") {
    return { ...record, function: { ...fn, name: mapper.toUpstream(fn.name) } };
  }
  if (record.type === "tool" && typeof record.name === "string") {
    return { ...record, name: mapper.toUpstream(record.name) };
  }
  return toolChoice;
};

/** Rewrites tool_call names inside Chat Completions history so it matches the upstream spelling. */
export const toUpstreamMessages = (messages: unknown, mapper: ToolNameMapper): unknown => {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    const record = asObject(message);
    if (!record || !Array.isArray(record.tool_calls)) return message;
    return {
      ...record,
      tool_calls: record.tool_calls.map((call) => {
        const callRecord = asObject(call);
        const fn = asObject(callRecord?.function);
        if (!callRecord || !fn || typeof fn.name !== "string") return call;
        return { ...callRecord, function: { ...fn, name: mapper.toUpstream(fn.name) } };
      }),
    };
  });
};

/** Rewrites `function_call` item names inside Responses input history. */
export const toUpstreamResponsesInput = (input: unknown, mapper: ToolNameMapper): unknown => {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    const record = asObject(item);
    if (!record || record.type !== "function_call" || typeof record.name !== "string") return item;
    return { ...record, name: mapper.toUpstream(record.name) };
  });
};

/**
 * Streams OpenAI-shaped chunks out to a client that may not have declared
 * `read`/`bash`. Keeps one entry per tool-call index so later argument-only
 * chunks for a dropped call are dropped too.
 */
export class DownstreamToolCallFilter {
  private readonly dropped = new Set<number>();
  private kept = 0;

  constructor(private readonly mapper: ToolNameMapper) {}

  /** True when at least one tool call survived filtering. */
  hasToolCalls(): boolean {
    return this.kept > 0;
  }

  /** Rewrites `choices[i].delta.tool_calls` in place. */
  applyDelta(delta: JsonObject | undefined): void {
    if (!delta) return;
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : undefined;
    if (!calls) return;
    const next: unknown[] = [];
    for (const call of calls) {
      const record = asObject(call);
      if (!record) {
        next.push(call);
        continue;
      }
      const index = typeof record.index === "number" ? record.index : undefined;
      const fn = asObject(record.function);
      const upstreamName = typeof fn?.name === "string" ? fn.name : undefined;
      if (upstreamName !== undefined && fn) {
        const mapped = this.mapper.toDownstream(upstreamName);
        if (mapped === undefined) {
          if (index !== undefined) this.dropped.add(index);
          continue;
        }
        this.kept += 1;
        next.push({ ...record, function: { ...fn, name: mapped } });
        continue;
      }
      if (index !== undefined && this.dropped.has(index)) continue;
      next.push(record);
    }
    if (next.length === 0) delete delta.tool_calls;
    else delta.tool_calls = next;
  }

  /** Rewrites `choices[i].delta` of a chat.completion.chunk payload in place. */
  applyChunk(payload: JsonObject): void {
    for (const choice of asArray(payload.choices)) {
      const record = asObject(choice);
      if (!record) continue;
      const delta = asObject(record.delta);
      if (delta) this.applyDelta(delta);
      // Every tool call was a dropped placeholder: the turn ends normally.
      if (record.finish_reason === "tool_calls" && !this.hasToolCalls()) record.finish_reason = "stop";
    }
  }
}

/** Rewrites a complete chat.completion message, dropping placeholder tool calls. */
export const applyToolFilterToChatCompletion = (response: JsonObject, mapper: ToolNameMapper): void => {
  for (const choice of asArray(response.choices)) {
    const record = asObject(choice);
    const message = asObject(record?.message);
    if (!record || !message) continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
    if (!calls) continue;
    const kept = calls.flatMap((call) => {
      const callRecord = asObject(call);
      const fn = asObject(callRecord?.function);
      if (!callRecord || !fn || typeof fn.name !== "string") return [call];
      const mapped = mapper.toDownstream(fn.name);
      return mapped === undefined ? [] : [{ ...callRecord, function: { ...fn, name: mapped } }];
    });
    if (kept.length === 0) {
      delete message.tool_calls;
      if (record.finish_reason === "tool_calls") record.finish_reason = "stop";
    } else {
      message.tool_calls = kept;
    }
  }
};

/** Rewrites `function_call` output items of a Responses response, dropping placeholders. */
export const applyToolFilterToResponsesResponse = (response: JsonObject, mapper: ToolNameMapper): void => {
  const output = Array.isArray(response.output) ? response.output : undefined;
  if (!output) return;
  response.output = output.flatMap((item) => {
    const record = asObject(item);
    if (!record || record.type !== "function_call" || typeof record.name !== "string") return [item];
    const mapped = mapper.toDownstream(record.name);
    return mapped === undefined ? [] : [{ ...record, name: mapped }];
  });
};

/**
 * Same job as {@link DownstreamToolCallFilter}, for a raw Responses SSE stream:
 * drops the events of a placeholder `function_call` the client never declared
 * and renames the surviving ones. Events that survive untouched are returned
 * unchanged so callers can forward the original bytes.
 */
export class ResponsesStreamToolFilter {
  private readonly dropped = new Set<number>();

  constructor(private readonly mapper: ToolNameMapper) {}

  /** Returns the payload to emit, or null when the whole event must be dropped. */
  applyPayload(payload: JsonObject): JsonObject | null {
    const event = typeof payload.type === "string" ? payload.type : "";
    const outputIndex = typeof payload.output_index === "number" ? payload.output_index : 0;
    const item = asObject(payload.item);

    if (item?.type === "function_call" && (event === "response.output_item.added" || event === "response.output_item.done")) {
      const mapped = typeof item.name === "string" ? this.mapper.toDownstream(item.name) : undefined;
      if (mapped === undefined) {
        this.dropped.add(outputIndex);
        return null;
      }
      return { ...payload, item: { ...item, name: mapped } };
    }
    if (event === "response.function_call_arguments.delta" && this.dropped.has(outputIndex)) return null;
    const response = asObject(payload.response);
    if (response && (event === "response.completed" || event === "response.incomplete")) {
      const next = { ...response };
      applyToolFilterToResponsesResponse(next, this.mapper);
      return { ...payload, response: next };
    }
    return payload;
  }
}
