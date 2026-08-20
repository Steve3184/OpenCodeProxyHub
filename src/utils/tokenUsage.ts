export interface TokenUsage {
  totalTokens: number | null;
  inputTokens: number;
  outputTokens: number;
}

const nonNegativeInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
};

export const extractTokenUsage = (payload: unknown): TokenUsage => {
  if (!payload || typeof payload !== "object") return { totalTokens: null, inputTokens: 0, outputTokens: 0 };
  const record = payload as Record<string, unknown>;
  const usageCandidates = [record.usage, (record.message as Record<string, unknown> | undefined)?.usage];
  for (const candidate of usageCandidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const usage = candidate as Record<string, unknown>;
    const total = nonNegativeInteger(usage.total_tokens);
    const input = nonNegativeInteger(usage.prompt_tokens) ?? nonNegativeInteger(usage.input_tokens) ?? 0;
    const output = nonNegativeInteger(usage.completion_tokens) ?? nonNegativeInteger(usage.output_tokens) ?? 0;
    if (total !== null) return { totalTokens: total, inputTokens: input, outputTokens: output };
    if (input > 0 || output > 0) return { totalTokens: input + output, inputTokens: input, outputTokens: output };
  }
  return { totalTokens: null, inputTokens: 0, outputTokens: 0 };
};

export const estimateTokens = (value: unknown): number => {
  const text = typeof value === "string" ? value : JSON.stringify(value) || "";
  return Math.max(0, Math.ceil(text.length / 4));
};
