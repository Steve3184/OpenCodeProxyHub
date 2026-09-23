/**
 * The upstream gate requires `stream: true`, so every response arrives as SSE.
 * Downstream callers that asked for a non-streaming reply still need a complete
 * JSON body, so these aggregators fold an upstream SSE stream back into the
 * shape the corresponding protocol would have returned non-streamed.
 */

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined => (
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined
);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const isErrorPayload = (record: JsonObject): boolean => Boolean(record.error) || record.type === "error";

const ocId = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

export interface SseAggregator {
  observe(payload: unknown): void;
  /** The complete response, or null when nothing usable was observed. */
  result(): JsonObject | null;
}

/** Splits an SSE body into its JSON payloads, ignoring events and comments. */
export const parseSsePayloads = (raw: string): unknown[] => {
  const payloads: unknown[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length === 0) return;
    const joined = data.join("\n").trim();
    data = [];
    if (!joined || joined === "[DONE]") return;
    try {
      payloads.push(JSON.parse(joined));
    } catch {
      // Ignore malformed payloads rather than failing the whole response.
    }
  };
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (line === "") flush();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  flush();
  return payloads;
};

/** Folds OpenAI Chat Completions SSE chunks into one chat.completion object. */
export const createChatCompletionAggregator = (): SseAggregator => {
  let sawAny = false;
  let id: string | undefined;
  let created: number | undefined;
  let model: string | undefined;
  let role = "assistant";
  let content = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let usage: unknown;
  const toolCalls = new Map<number, { id?: string; name: string; args: string }>();

  return {
    observe(payload: unknown): void {
      const record = asObject(payload);
      if (!record || isErrorPayload(record)) return;
      if (typeof record.id === "string") id = record.id;
      if (typeof record.created === "number") created = record.created;
      if (typeof record.model === "string") model = record.model;
      if (record.usage !== undefined && record.usage !== null) usage = record.usage;
      const choice = asObject(asArray(record.choices)[0]);
      if (!choice) return;
      sawAny = true;
      const source = asObject(choice.delta) ?? asObject(choice.message);
      if (source) {
        if (typeof source.role === "string") role = source.role;
        if (typeof source.content === "string") content += source.content;
        if (typeof source.reasoning_content === "string") reasoning += source.reasoning_content;
        for (const call of asArray(source.tool_calls)) {
          const callRecord = asObject(call);
          if (!callRecord) continue;
          const index = typeof callRecord.index === "number" ? callRecord.index : toolCalls.size;
          const state = toolCalls.get(index) ?? { name: "", args: "" };
          if (typeof callRecord.id === "string" && callRecord.id) state.id = callRecord.id;
          const fn = asObject(callRecord.function);
          if (typeof fn?.name === "string" && fn.name) state.name = fn.name;
          if (typeof fn?.arguments === "string") state.args += fn.arguments;
          toolCalls.set(index, state);
        }
      }
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    },
    result(): JsonObject | null {
      if (!sawAny) return null;
      const message: JsonObject = { role, content: content.length ? content : null };
      if (reasoning) message.reasoning_content = reasoning;
      if (toolCalls.size > 0) {
        message.tool_calls = [...toolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, state]) => ({
            id: state.id || ocId("call"),
            type: "function",
            function: { name: state.name, arguments: state.args || "{}" },
          }));
      }
      return {
        id: id || ocId("chatcmpl"),
        object: "chat.completion",
        created: created ?? Math.floor(Date.now() / 1000),
        ...(model ? { model } : {}),
        choices: [{
          index: 0,
          message,
          finish_reason: finishReason ?? (toolCalls.size > 0 ? "tool_calls" : "stop"),
        }],
        ...(usage !== undefined ? { usage } : {}),
      };
    },
  };
};

/** Folds Responses SSE events into one Responses `response` object. */
export const createResponsesAggregator = (): SseAggregator => {
  let sawAny = false;
  let id: string | undefined;
  let created: number | undefined;
  let model: string | undefined;
  let status: string | undefined;
  let usage: unknown;
  let final: JsonObject | null = null;
  const items = new Map<number, JsonObject>();
  const text = new Map<number, string>();
  const args = new Map<number, string>();

  const absorbResponse = (response: JsonObject, complete: boolean): void => {
    sawAny = true;
    if (typeof response.id === "string") id = response.id;
    if (typeof response.created_at === "number") created = response.created_at;
    if (typeof response.model === "string") model = response.model;
    if (typeof response.status === "string") status = response.status;
    if (response.usage !== undefined && response.usage !== null) usage = response.usage;
    for (const entry of asArray(response.output)) {
      const item = asObject(entry);
      if (item) items.set(items.size, item);
    }
    if (complete) final = response;
  };

  return {
    observe(payload: unknown): void {
      const record = asObject(payload);
      if (!record || isErrorPayload(record)) return;
      const event = typeof record.type === "string" ? record.type : "";
      const response = asObject(record.response);
      if (response) absorbResponse(response, event === "response.completed" || event === "response.incomplete");
      const outputIndex = typeof record.output_index === "number" ? record.output_index : 0;
      if (event === "response.output_item.added" || event === "response.output_item.done") {
        const item = asObject(record.item);
        if (item) {
          sawAny = true;
          items.set(outputIndex, { ...items.get(outputIndex), ...item });
        }
        return;
      }
      if (event === "response.output_text.delta" && typeof record.delta === "string") {
        sawAny = true;
        text.set(outputIndex, (text.get(outputIndex) ?? "") + record.delta);
        return;
      }
      if (event === "response.function_call_arguments.delta" && typeof record.delta === "string") {
        sawAny = true;
        args.set(outputIndex, (args.get(outputIndex) ?? "") + record.delta);
      }
    },
    result(): JsonObject | null {
      if (!sawAny) return null;
      if (final) {
        const complete: JsonObject = { ...final };
        if (model) complete.model = model;
        if (usage !== undefined && complete.usage === undefined) complete.usage = usage;
        return complete;
      }
      const output = [...items.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, item]) => {
          if (item.type === "message") {
            const accumulated = text.get(index);
            if (accumulated === undefined) return item;
            return { ...item, status: "completed", content: [{ type: "output_text", text: accumulated, annotations: [] }] };
          }
          if (item.type === "function_call") {
            const accumulated = args.get(index);
            if (accumulated === undefined) return item;
            return { ...item, status: "completed", arguments: accumulated };
          }
          return item;
        });
      return {
        id: id || ocId("resp"),
        object: "response",
        created_at: created ?? Math.floor(Date.now() / 1000),
        status: status ?? "completed",
        ...(model ? { model } : {}),
        output,
        ...(usage !== undefined ? { usage } : {}),
      };
    },
  };
};

export type UpstreamProtocol = "chat_completions" | "responses" | "systemone";

const createSystemoneAggregator = (): SseAggregator => {
  let latest: JsonObject | null = null;
  return {
    observe(payload: unknown): void {
      const record = asObject(payload);
      if (record) latest = record;
    },
    result(): JsonObject | null {
      return latest;
    },
  };
};

/**
 * Turns a complete upstream body into the non-streamed response shape for the
 * given protocol. Accepts either an SSE stream or a plain JSON body (error
 * bodies, or an upstream that ignored `stream: true`).
 */
export const aggregateUpstreamBody = (raw: string, protocol: UpstreamProtocol): JsonObject | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const record = asObject(parsed);
      // A plain JSON body is either an error or an upstream that ignored streaming.
      if (record) return record;
    } catch {
      // Not a complete JSON body: fall through and parse it as SSE.
    }
  }
  const aggregator = protocol === "responses"
    ? createResponsesAggregator()
    : protocol === "systemone" ? createSystemoneAggregator() : createChatCompletionAggregator();
  for (const payload of parseSsePayloads(trimmed)) aggregator.observe(payload);
  return aggregator.result();
};
