export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole | string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface OpenAIChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  response_format?: unknown;
  seed?: number;
  user?: string;
}

export interface OpenAIResponsesRequest {
  model: string;
  input?: unknown;
  stream?: boolean;
  instructions?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  user?: string;
  text?: unknown;
  [key: string]: unknown;
}

export interface AnthropicMessageRequest {
  model: string;
  system?: string | Array<{ text?: string }>;
  messages?: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  metadata?: unknown;
}

export interface ZenFullResponse {
  status: number;
  data: any;
  raw: string;
}
