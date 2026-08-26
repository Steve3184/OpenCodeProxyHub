import { ocId } from "../utils/ids.js";
import type { ChatMessage, OpenAIChatRequest, OpenAIResponsesRequest } from "../types/api.js";
import type { ZenStreamTransform } from "../providers/zenClient.js";

type JsonObject = Record<string, unknown>;

export type StreamChunkTransformer = ZenStreamTransform;

interface SseBlock {
  event?: string;
  data: string;
}

const asObject = (value: unknown): JsonObject | undefined => (
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined
);

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const numberValue = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) ? value : undefined
);

const stringValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

const safeJson = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
};

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const record = asObject(part);
    if (!record) return typeof part === "string" ? [part] : [];
    const type = stringValue(record.type);
    if ((type === "text" || type === "input_text" || type === "output_text" || type === "refusal") && typeof record.text === "string") return [record.text];
    return [];
  }).join("");
};

const chatContentToResponses = (content: unknown, role: string): JsonObject[] => {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return [];

  return content.flatMap((part): JsonObject[] => {
    const record = asObject(part);
    if (!record) return typeof part === "string" ? [{ type: textType, text: part }] : [];
    const type = stringValue(record.type);
    if ((type === "text" || type === "input_text" || type === "output_text") && typeof record.text === "string") {
      return [{ type: textType, text: record.text }];
    }
    if (type === "image_url") {
      const imageUrl = asObject(record.image_url);
      const url = stringValue(imageUrl?.url);
      if (!url) return [];
      return [{ type: "input_image", image_url: url, ...(typeof imageUrl?.detail === "string" ? { detail: imageUrl.detail } : {}) }];
    }
    if (type === "input_image" && typeof record.image_url === "string") return [{ ...record }];
    return [{ type: textType, text: safeJson(record) }];
  });
};

const mapChatToolsToResponses = (tools: unknown[] | undefined): unknown[] | undefined => {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    const record = asObject(tool);
    const fn = asObject(record?.function);
    if (record?.type !== "function" || !fn) return tool;
    return {
      type: "function",
      name: stringValue(fn.name) || "",
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
      ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
    };
  });
};

const mapChatToolChoiceToResponses = (toolChoice: unknown): unknown => {
  const record = asObject(toolChoice);
  const fn = asObject(record?.function);
  if (record?.type === "function" && typeof fn?.name === "string") return { type: "function", name: fn.name };
  return toolChoice;
};

const mapChatResponseFormatToResponses = (responseFormat: unknown): JsonObject | undefined => {
  const format = asObject(responseFormat);
  if (!format || typeof format.type !== "string") return undefined;
  if (format.type !== "json_schema") return { type: format.type };
  const schema = asObject(format.json_schema);
  if (!schema) return { type: "json_schema" };
  return {
    type: "json_schema",
    ...(typeof schema.name === "string" ? { name: schema.name } : {}),
    ...(schema.schema !== undefined ? { schema: schema.schema } : {}),
    ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
  };
};

/** Convert an OpenAI Chat Completions request into a Responses request. */
export const openAIChatToResponsesRequest = (body: OpenAIChatRequest): OpenAIResponsesRequest => {
  const input: JsonObject[] = [];
  for (const message of body.messages || []) {
    const role = typeof message.role === "string" ? message.role : "user";
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id || ocId("call"),
        output: typeof message.content === "string" ? message.content : chatContentToResponses(message.content, "user"),
      });
      continue;
    }

    const content = chatContentToResponses(message.content, role);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (content.length > 0 || toolCalls.length === 0) {
      input.push({ type: "message", role, content });
    }
    for (const call of toolCalls) {
      const record = asObject(call);
      const fn = asObject(record?.function);
      if (!record || !fn) continue;
      input.push({
        type: "function_call",
        id: stringValue(record.id) || ocId("fc"),
        call_id: stringValue(record.id) || ocId("call"),
        name: stringValue(fn.name) || "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : safeJson(fn.arguments ?? {}),
      });
    }
  }

  const request: OpenAIResponsesRequest = {
    model: body.model,
    input,
    stream: Boolean(body.stream),
  };
  const tools = mapChatToolsToResponses(body.tools);
  if (tools) request.tools = tools;
  const toolChoice = mapChatToolChoiceToResponses(body.tool_choice);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;
  if (body.temperature !== undefined) request.temperature = body.temperature;
  if (body.top_p !== undefined) request.top_p = body.top_p;
  if (body.max_tokens !== undefined) request.max_output_tokens = body.max_tokens;
  if (body.user !== undefined) request.user = body.user;
  const responseFormat = mapChatResponseFormatToResponses(body.response_format);
  if (responseFormat) request.text = { format: responseFormat };
  return request;
};

const responseContentToChat = (content: unknown): unknown => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content.flatMap((part): JsonObject[] => {
    const record = asObject(part);
    if (!record) return typeof part === "string" ? [{ type: "text", text: part }] : [];
    const type = stringValue(record.type);
    if ((type === "text" || type === "input_text" || type === "output_text" || type === "refusal") && typeof record.text === "string") {
      return [{ type: "text", text: record.text }];
    }
    if (type === "input_image" && typeof record.image_url === "string") {
      return [{ type: "image_url", image_url: { url: record.image_url, ...(typeof record.detail === "string" ? { detail: record.detail } : {}) } }];
    }
    return [{ type: "text", text: safeJson(record) }];
  });
  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) return parts.map((part) => String(part.text || "")).join("");
  return parts;
};

const appendToolCall = (messages: JsonObject[], item: JsonObject): void => {
  const name = stringValue(item.name) || "";
  const callId = stringValue(item.call_id) || stringValue(item.id) || ocId("call");
  const toolCall = {
    id: callId,
    type: "function",
    function: { name, arguments: typeof item.arguments === "string" ? item.arguments : safeJson(item.arguments ?? {}) },
  };
  const previous = messages[messages.length - 1];
  if (previous?.role === "assistant" && Array.isArray(previous.tool_calls)) {
    previous.tool_calls.push(toolCall);
    return;
  }
  messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
};

const mapResponsesToolsToChat = (tools: unknown): unknown[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => {
    const record = asObject(tool);
    if (record?.type !== "function" || typeof record.name !== "string") return tool;
    return {
      type: "function",
      function: {
        name: record.name,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        ...(record.parameters !== undefined ? { parameters: record.parameters } : {}),
        ...(typeof record.strict === "boolean" ? { strict: record.strict } : {}),
      },
    };
  });
};

const mapResponsesToolChoiceToChat = (toolChoice: unknown): unknown => {
  const record = asObject(toolChoice);
  if (record?.type === "function" && typeof record.name === "string") return { type: "function", function: { name: record.name } };
  return toolChoice;
};

const mapResponsesTextFormatToChat = (text: unknown): JsonObject | undefined => {
  const textRecord = asObject(text);
  const format = asObject(textRecord?.format);
  if (!format || typeof format.type !== "string") return undefined;
  if (format.type !== "json_schema") return { type: format.type };
  return {
    type: "json_schema",
    json_schema: {
      ...(typeof format.name === "string" ? { name: format.name } : {}),
      ...(format.schema !== undefined ? { schema: format.schema } : {}),
      ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
    },
  };
};

/** Convert a Responses request into the OpenAI Chat Completions request shape. */
export const responsesToOpenAIChatRequest = (body: OpenAIResponsesRequest): OpenAIChatRequest => {
  const messages: JsonObject[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = Array.isArray(body.input) ? body.input : body.input === undefined ? [] : [body.input];
  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    const record = asObject(item);
    if (!record) {
      messages.push({ role: "user", content: safeJson(item) });
      continue;
    }
    const type = stringValue(record.type);
    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: stringValue(record.call_id) || stringValue(record.id) || ocId("call"),
        content: responseContentToChat(record.output ?? record.content),
      });
      continue;
    }
    if (type === "function_call") {
      appendToolCall(messages, record);
      continue;
    }
    if (type === "reasoning") continue;
    if (type === "input_text" || type === "output_text" || type === "input_image") {
      messages.push({
        role: type === "output_text" ? "assistant" : "user",
        content: responseContentToChat([record]),
      });
      continue;
    }
    const role = typeof record.role === "string" ? record.role : "user";
    messages.push({ role, content: responseContentToChat(record.content ?? record.input ?? record.text ?? "") });
  }

  const request: OpenAIChatRequest = {
    model: body.model,
    messages: messages as unknown as ChatMessage[],
    stream: Boolean(body.stream),
  };
  const tools = mapResponsesToolsToChat(body.tools);
  if (tools) request.tools = tools;
  const toolChoice = mapResponsesToolChoiceToChat(body.tool_choice);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;
  if (body.temperature !== undefined) request.temperature = body.temperature as number;
  if (body.top_p !== undefined) request.top_p = body.top_p as number;
  if (body.max_output_tokens !== undefined) request.max_tokens = body.max_output_tokens as number;
  if (body.user !== undefined) request.user = body.user as string;
  const responseFormat = mapResponsesTextFormatToChat(body.text);
  if (responseFormat) request.response_format = responseFormat;
  return request;
};

const responseUsage = (usage: unknown): JsonObject | undefined => {
  const record = asObject(usage);
  if (!record) return undefined;
  const input = numberValue(record.input_tokens) ?? numberValue(record.prompt_tokens) ?? 0;
  const output = numberValue(record.output_tokens) ?? numberValue(record.completion_tokens) ?? 0;
  const total = numberValue(record.total_tokens) ?? input + output;
  return { input_tokens: input, output_tokens: output, total_tokens: total };
};

const chatUsage = (usage: unknown): JsonObject | undefined => {
  const record = asObject(usage);
  if (!record) return undefined;
  const input = numberValue(record.prompt_tokens) ?? numberValue(record.input_tokens) ?? 0;
  const output = numberValue(record.completion_tokens) ?? numberValue(record.output_tokens) ?? 0;
  const total = numberValue(record.total_tokens) ?? input + output;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
};

/** Convert a complete Chat Completions response to a Responses response. */
export const openAIChatResponseToResponses = (chatResponse: unknown, model: string): JsonObject => {
  const response = asObject(chatResponse) || {};
  const choice = asObject(asArray(response.choices)[0]) || {};
  const message = asObject(choice.message) || {};
  const output: JsonObject[] = [];
  const text = textFromContent(message.content);
  if (text) {
    output.push({
      id: ocId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const toolCall of asArray(message.tool_calls)) {
    const record = asObject(toolCall);
    const fn = asObject(record?.function);
    if (!record || !fn) continue;
    output.push({
      id: ocId("fc"),
      type: "function_call",
      status: "completed",
      call_id: stringValue(record.id) || ocId("call"),
      name: stringValue(fn.name) || "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : safeJson(fn.arguments ?? {}),
    });
  }
  if (output.length === 0) {
    output.push({ id: ocId("msg"), type: "message", status: "completed", role: "assistant", content: [] });
  }
  const incomplete = choice.finish_reason === "length";
  return {
    id: typeof response.id === "string" && response.id.startsWith("resp_") ? response.id : ocId("resp"),
    object: "response",
    created_at: numberValue(response.created) ?? Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : { incomplete_details: null }),
    model,
    output,
    ...(responseUsage(response.usage) ? { usage: responseUsage(response.usage) } : {}),
  };
};

const responseOutputText = (item: JsonObject): string => {
  if (typeof item.text === "string") return item.text;
  return textFromContent(item.content);
};

/** Convert a complete Responses response to a Chat Completions response. */
export const responsesToOpenAIChatResponse = (responsesResponse: unknown, model: string): JsonObject => {
  const response = asObject(responsesResponse) || {};
  const output = asArray(response.output);
  const content: string[] = [];
  const toolCalls: JsonObject[] = [];
  for (const item of output) {
    const record = asObject(item);
    if (!record) continue;
    if (record.type === "function_call") {
      toolCalls.push({
        id: stringValue(record.call_id) || stringValue(record.id) || ocId("call"),
        type: "function",
        function: {
          name: stringValue(record.name) || "",
          arguments: typeof record.arguments === "string" ? record.arguments : safeJson(record.arguments ?? {}),
        },
      });
      continue;
    }
    if (record.type === "message") {
      const text = responseOutputText(record);
      if (text) content.push(text);
    }
  }
  const incomplete = response.status === "incomplete";
  const message: JsonObject = { role: "assistant", content: content.join("") || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: typeof response.id === "string" ? response.id : ocId("chatcmpl"),
    object: "chat.completion",
    created: numberValue(response.created_at) ?? Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? "tool_calls" : incomplete ? "length" : "stop",
    }],
    ...(chatUsage(response.usage) ? { usage: chatUsage(response.usage) } : {}),
  };
};

const parseSseBlock = (raw: string): SseBlock | null => {
  const dataLines: string[] = [];
  let event: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!event && dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
};

const extractSseBlocks = (buffer: string): { blocks: SseBlock[]; rest: string } => {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() || "";
  return { blocks: parts.map(parseSseBlock).filter((block): block is SseBlock => Boolean(block)), rest };
};

const sse = (event: string, payload: unknown): string => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

const chatSse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const outputUsage = (payload: JsonObject): JsonObject | undefined => (
  responseUsage(payload.usage) || responseUsage(asObject(payload.response)?.usage)
);

/** Transform a Responses SSE stream into OpenAI Chat Completions SSE. */
export const createResponsesToOpenAIStreamTransformer = (model: string): StreamChunkTransformer => {
  let buffer = "";
  const id = ocId("chatcmpl");
  let created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  let done = false;
  let sawToolCall = false;
  let nextToolIndex = 0;
  let finishReason: "stop" | "tool_calls" | "length" = "stop";
  let usage: JsonObject | undefined;
  const tools = new Map<number, { index: number; id: string; name: string; argumentDeltaSent: boolean }>();
  const textOutputIndices = new Set<number>();

  const chunk = (delta: JsonObject, final: "stop" | "tool_calls" | "length" | null = null): JsonObject => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: final }],
    ...(usage && final ? { usage: chatUsage(usage) || usage } : {}),
  });

  const ensureRole = (out: string[]): void => {
    if (roleSent) return;
    out.push(chatSse(chunk({ role: "assistant" })));
    roleSent = true;
  };

  const ensureTool = (outputIndex: number, item?: JsonObject, out?: string[]): { index: number; id: string; name: string; argumentDeltaSent: boolean } => {
    const existing = tools.get(outputIndex);
    if (existing) return existing;
    const state = {
      index: nextToolIndex,
      id: stringValue(item?.call_id) || stringValue(item?.id) || ocId("call"),
      name: stringValue(item?.name) || "",
      argumentDeltaSent: false,
    };
    nextToolIndex += 1;
    tools.set(outputIndex, state);
    sawToolCall = true;
    if (out) {
      ensureRole(out);
      out.push(chatSse(chunk({ tool_calls: [{ index: state.index, id: state.id, type: "function", function: { name: state.name, arguments: "" } }] })));
    }
    return state;
  };

  const finish = (out: string[]): void => {
    if (done) return;
    done = true;
    if (sawToolCall && finishReason === "stop") finishReason = "tool_calls";
    ensureRole(out);
    out.push(chatSse(chunk({}, finishReason)));
    out.push("data: [DONE]\n\n");
  };

  const handle = (block: SseBlock, out: string[]): void => {
    if (done || !block.data) return;
    if (block.data === "[DONE]") {
      finish(out);
      return;
    }
    let payload: JsonObject;
    try {
      payload = JSON.parse(block.data) as JsonObject;
    } catch {
      return;
    }
    if (Array.isArray(payload.choices)) {
      out.push(chatSse({ ...payload, model }));
      return;
    }
    const event = block.event || stringValue(payload.type) || "";
    const response = asObject(payload.response);
    if (response) {
      created = numberValue(response.created_at) ?? created;
      usage = responseUsage(response.usage) || usage;
      if (response.status === "incomplete") finishReason = "length";
    }
    usage = outputUsage(payload) || usage;
    const outputIndex = numberValue(payload.output_index) ?? 0;
    const item = asObject(payload.item);

    if (event === "response.output_item.added" && item?.type === "function_call") {
      ensureTool(outputIndex, item, out);
      return;
    }
    if (event === "response.output_text.delta" || event === "response.refusal.delta") {
      const delta = stringValue(payload.delta);
      if (!delta) return;
      ensureRole(out);
      textOutputIndices.add(outputIndex);
      out.push(chatSse(chunk({ content: delta })));
      return;
    }
    if (event === "response.function_call_arguments.delta") {
      const delta = stringValue(payload.delta);
      if (delta === undefined) return;
      const tool = ensureTool(outputIndex, item, out);
      tool.argumentDeltaSent = true;
      out.push(chatSse(chunk({ tool_calls: [{ index: tool.index, function: { arguments: delta } }] })));
      return;
    }
    if (event === "response.output_item.done" && item) {
      if (item.type === "function_call") {
        const tool = ensureTool(outputIndex, item, out);
        if (!tool.argumentDeltaSent && typeof item.arguments === "string") {
          out.push(chatSse(chunk({ tool_calls: [{ index: tool.index, function: { arguments: item.arguments } }] })));
        }
        return;
      }
      if (item.type === "message" && !textOutputIndices.has(outputIndex)) {
        const text = responseOutputText(item);
        if (text) {
          ensureRole(out);
          out.push(chatSse(chunk({ content: text })));
        }
      }
      return;
    }
    if (event === "response.completed" || event === "response.incomplete") {
      if (event === "response.incomplete") finishReason = "length";
      finish(out);
    }
  };

  const consume = (input: string, final = false): Buffer => {
    buffer += input;
    const extracted = extractSseBlocks(buffer);
    buffer = extracted.rest;
    const out: string[] = [];
    for (const block of extracted.blocks) handle(block, out);
    if (final && buffer.trim()) {
      const block = parseSseBlock(buffer);
      if (block) handle(block, out);
      buffer = "";
    }
    if (final) finish(out);
    return Buffer.from(out.join(""));
  };

  return { write: (chunkValue) => consume(chunkValue.toString()), flush: () => consume("", true) };
};

/** Transform a Chat Completions SSE stream into Responses SSE. */
export const createOpenAIToResponsesStreamTransformer = (model: string): StreamChunkTransformer => {
  let buffer = "";
  const id = ocId("resp");
  let created = Math.floor(Date.now() / 1000);
  let responseStarted = false;
  let done = false;
  let nextOutputIndex = 0;
  let message: { id: string; outputIndex: number; text: string; textStarted: boolean } | undefined;
  let usage: JsonObject | undefined;
  const tools = new Map<number, { id: string; callId: string; name: string; outputIndex: number; arguments: string }>();

  const outputItems = (): JsonObject[] => {
    const items: JsonObject[] = [];
    if (message) {
      items.push({
        id: message.id,
        type: "message",
        status: "completed",
        role: "assistant",
        content: message.text ? [{ type: "output_text", text: message.text, annotations: [] }] : [],
      });
    }
    for (const tool of tools.values()) {
      items.push({ id: tool.id, type: "function_call", status: "completed", call_id: tool.callId, name: tool.name, arguments: tool.arguments });
    }
    return items;
  };

  const response = (status: "in_progress" | "completed" = "in_progress"): JsonObject => ({
    id,
    object: "response",
    created_at: created,
    status,
    model,
    output: status === "completed" ? outputItems() : [],
    ...(usage ? { usage: responseUsage(usage) || usage } : {}),
  });

  const ensureResponse = (out: string[]): void => {
    if (responseStarted) return;
    responseStarted = true;
    out.push(sse("response.created", { type: "response.created", response: response() }));
    out.push(sse("response.in_progress", { type: "response.in_progress", response: response() }));
  };

  const ensureMessage = (out: string[]): NonNullable<typeof message> => {
    ensureResponse(out);
    if (message) return message;
    message = { id: ocId("msg"), outputIndex: nextOutputIndex, text: "", textStarted: false };
    nextOutputIndex += 1;
    out.push(sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: message.outputIndex,
      item: { id: message.id, type: "message", status: "in_progress", role: "assistant", content: [] },
    }));
    return message;
  };

  const ensureText = (out: string[]): NonNullable<typeof message> => {
    const state = ensureMessage(out);
    if (!state.textStarted) {
      state.textStarted = true;
      out.push(sse("response.content_part.added", {
        type: "response.content_part.added",
        item_id: state.id,
        output_index: state.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }));
    }
    return state;
  };

  const ensureTool = (index: number, delta: JsonObject, out: string[]) => {
    const existing = tools.get(index);
    if (existing) return existing;
    ensureResponse(out);
    const fn = asObject(delta.function);
    const state = {
      id: ocId("fc"),
      callId: stringValue(delta.id) || ocId("call"),
      name: stringValue(fn?.name) || "",
      outputIndex: nextOutputIndex,
      arguments: "",
    };
    nextOutputIndex += 1;
    tools.set(index, state);
    out.push(sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.outputIndex,
      item: { id: state.id, type: "function_call", status: "in_progress", call_id: state.callId, name: state.name, arguments: "" },
    }));
    return state;
  };

  const finish = (out: string[]): void => {
    if (done) return;
    done = true;
    ensureResponse(out);
    if (message) {
      if (message.textStarted) {
        out.push(sse("response.output_text.done", {
          type: "response.output_text.done",
          item_id: message.id,
          output_index: message.outputIndex,
          content_index: 0,
          text: message.text,
        }));
        out.push(sse("response.content_part.done", {
          type: "response.content_part.done",
          item_id: message.id,
          output_index: message.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: message.text, annotations: [] },
        }));
      }
      out.push(sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: message.outputIndex,
        item: { id: message.id, type: "message", status: "completed", role: "assistant", content: message.text ? [{ type: "output_text", text: message.text, annotations: [] }] : [] },
      }));
    }
    for (const tool of tools.values()) {
      out.push(sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: tool.outputIndex,
        item: { id: tool.id, type: "function_call", status: "completed", call_id: tool.callId, name: tool.name, arguments: tool.arguments },
      }));
    }
    out.push(sse("response.completed", { type: "response.completed", response: response("completed") }));
  };

  const handle = (block: SseBlock, out: string[]): void => {
    if (done || !block.data) return;
    if (block.data === "[DONE]") {
      finish(out);
      return;
    }
    let payload: JsonObject;
    try {
      payload = JSON.parse(block.data) as JsonObject;
    } catch {
      return;
    }
    created = numberValue(payload.created) ?? created;
    usage = chatUsage(payload.usage) || usage;
    const choice = asObject(asArray(payload.choices)[0]);
    if (!choice) return;
    const delta = asObject(choice.delta) || {};
    ensureResponse(out);
    if (delta.role === "assistant") ensureMessage(out);
    if (typeof delta.content === "string" && delta.content) {
      const state = ensureText(out);
      state.text += delta.content;
      out.push(sse("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: state.id,
        output_index: state.outputIndex,
        content_index: 0,
        delta: delta.content,
      }));
    }
    for (const entry of asArray(delta.tool_calls)) {
      const toolDelta = asObject(entry);
      if (!toolDelta) continue;
      const index = numberValue(toolDelta.index) ?? 0;
      const tool = ensureTool(index, toolDelta, out);
      const fn = asObject(toolDelta.function);
      if (typeof fn?.name === "string" && !tool.name) tool.name = fn.name;
      if (typeof fn?.arguments === "string") {
        tool.arguments += fn.arguments;
      }
    }
    if (choice.finish_reason) finish(out);
  };

  const consume = (input: string, final = false): Buffer => {
    buffer += input;
    const extracted = extractSseBlocks(buffer);
    buffer = extracted.rest;
    const out: string[] = [];
    for (const block of extracted.blocks) handle(block, out);
    if (final && buffer.trim()) {
      const block = parseSseBlock(buffer);
      if (block) handle(block, out);
      buffer = "";
    }
    if (final) finish(out);
    return Buffer.from(out.join(""));
  };

  return { write: (chunkValue) => consume(chunkValue.toString()), flush: () => consume("", true) };
};

/** Transform a Responses SSE stream directly into Anthropic Messages SSE. */
export const createResponsesToAnthropicStreamTransformer = (model: string, inputTokens: number): StreamChunkTransformer => {
  let buffer = "";
  const id = ocId("msg");
  let started = false;
  let done = false;
  let nextBlockIndex = 0;
  let outputTokens = 0;
  let usage: JsonObject | undefined;
  let textBlock: { index: number; started: boolean; text: string } | undefined;
  const toolBlocks = new Map<number, { index: number; id: string; name: string; input: string }>();

  const ensureMessage = (out: string[]): void => {
    if (started) return;
    started = true;
    out.push(sse("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }));
  };

  const ensureText = (out: string[]) => {
    ensureMessage(out);
    if (textBlock) return textBlock;
    textBlock = { index: nextBlockIndex, started: true, text: "" };
    nextBlockIndex += 1;
    out.push(sse("content_block_start", { type: "content_block_start", index: textBlock.index, content_block: { type: "text", text: "" } }));
    return textBlock;
  };

  const ensureTool = (outputIndex: number, item: JsonObject | undefined, out: string[]) => {
    const existing = toolBlocks.get(outputIndex);
    if (existing) return existing;
    ensureMessage(out);
    const state = {
      index: nextBlockIndex,
      id: stringValue(item?.call_id) || stringValue(item?.id) || ocId("toolu"),
      name: stringValue(item?.name) || "",
      input: "",
    };
    nextBlockIndex += 1;
    toolBlocks.set(outputIndex, state);
    out.push(sse("content_block_start", {
      type: "content_block_start",
      index: state.index,
      content_block: { type: "tool_use", id: state.id, name: state.name, input: {} },
    }));
    return state;
  };

  const finish = (out: string[], incomplete = false): void => {
    if (done) return;
    done = true;
    ensureMessage(out);
    if (textBlock) out.push(sse("content_block_stop", { type: "content_block_stop", index: textBlock.index }));
    for (const tool of toolBlocks.values()) {
      out.push(sse("content_block_stop", { type: "content_block_stop", index: tool.index }));
    }
    const stopReason = toolBlocks.size ? "tool_use" : incomplete ? "max_tokens" : "end_turn";
    const finalUsage = responseUsage(usage) || {};
    out.push(sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: numberValue(finalUsage.output_tokens) ?? outputTokens },
    }));
    out.push(sse("message_stop", { type: "message_stop" }));
  };

  const handle = (block: SseBlock, out: string[]): void => {
    if (done || !block.data) return;
    if (block.data === "[DONE]") {
      finish(out);
      return;
    }
    let payload: JsonObject;
    try {
      payload = JSON.parse(block.data) as JsonObject;
    } catch {
      return;
    }
    usage = outputUsage(payload) || usage;
    const event = block.event || stringValue(payload.type) || "";
    const outputIndex = numberValue(payload.output_index) ?? 0;
    const item = asObject(payload.item);
    if (event === "response.output_item.added" && item?.type === "function_call") {
      ensureTool(outputIndex, item, out);
      return;
    }
    if (event === "response.output_text.delta" || event === "response.refusal.delta") {
      const delta = stringValue(payload.delta);
      if (!delta) return;
      const state = ensureText(out);
      state.text += delta;
      outputTokens += Math.ceil(delta.length / 4);
      out.push(sse("content_block_delta", { type: "content_block_delta", index: state.index, delta: { type: "text_delta", text: delta } }));
      return;
    }
    if (event === "response.function_call_arguments.delta") {
      const delta = stringValue(payload.delta);
      if (delta === undefined) return;
      const tool = ensureTool(outputIndex, item, out);
      tool.input += delta;
      outputTokens += Math.ceil(delta.length / 4);
      out.push(sse("content_block_delta", { type: "content_block_delta", index: tool.index, delta: { type: "input_json_delta", partial_json: delta } }));
      return;
    }
    if (event === "response.output_item.done" && item) {
      if (item.type === "function_call") {
        const tool = ensureTool(outputIndex, item, out);
        if (!tool.input && typeof item.arguments === "string") {
          tool.input = item.arguments;
          out.push(sse("content_block_delta", { type: "content_block_delta", index: tool.index, delta: { type: "input_json_delta", partial_json: item.arguments } }));
        }
        return;
      }
      if (item.type === "message" && !textBlock) {
        const text = responseOutputText(item);
        if (text) {
          const state = ensureText(out);
          state.text += text;
          outputTokens += Math.ceil(text.length / 4);
          out.push(sse("content_block_delta", { type: "content_block_delta", index: state.index, delta: { type: "text_delta", text } }));
        }
      }
      return;
    }
    if (event === "response.completed" || event === "response.incomplete") finish(out, event === "response.incomplete");
  };

  const consume = (input: string, final = false): Buffer => {
    buffer += input;
    const extracted = extractSseBlocks(buffer);
    buffer = extracted.rest;
    const out: string[] = [];
    for (const block of extracted.blocks) handle(block, out);
    if (final && buffer.trim()) {
      const block = parseSseBlock(buffer);
      if (block) handle(block, out);
      buffer = "";
    }
    if (final) finish(out);
    return Buffer.from(out.join(""));
  };

  return {
    write: (chunkValue) => consume(chunkValue.toString()),
    flush: () => consume("", true),
    errorBody: (message, rateLimited) => ({ type: "error", error: { type: rateLimited ? "rate_limit_error" : "upstream_error", message } }),
  };
};
