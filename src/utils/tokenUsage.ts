export interface TokenUsage {
  totalTokens: number | null;
  inputTokens: number;
  outputTokens: number;
  /** True when the upstream supplied an explicit total_tokens field. */
  explicitTotal?: boolean;
}

export interface TokenUsageAccumulator {
  observe(payload: unknown): void;
  hasUsage(): boolean;
  totalTokens(): number | null;
}

const nonNegativeInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
};

export const extractTokenUsage = (payload: unknown): TokenUsage => {
  if (!payload || typeof payload !== "object") return { totalTokens: null, inputTokens: 0, outputTokens: 0, explicitTotal: false };
  const record = payload as Record<string, unknown>;
  const usageCandidates = [record.usage, (record.message as Record<string, unknown> | undefined)?.usage];
  for (const candidate of usageCandidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const usage = candidate as Record<string, unknown>;
    const total = nonNegativeInteger(usage.total_tokens);
    const input = nonNegativeInteger(usage.prompt_tokens) ?? nonNegativeInteger(usage.input_tokens) ?? 0;
    const output = nonNegativeInteger(usage.completion_tokens) ?? nonNegativeInteger(usage.output_tokens) ?? 0;
    if (total !== null) return { totalTokens: total, inputTokens: input, outputTokens: output, explicitTotal: true };
    if (input > 0 || output > 0) return { totalTokens: input + output, inputTokens: input, outputTokens: output, explicitTotal: false };
  }
  return { totalTokens: null, inputTokens: 0, outputTokens: 0, explicitTotal: false };
};

export const estimateTokens = (value: unknown): number => {
  const text = typeof value === "string" ? value : JSON.stringify(value) || "";
  return Math.max(0, Math.ceil(text.length / 4));
};

/**
 * Streaming usage fields are commonly cumulative (and may appear in more
 * than one event). Keep the largest observed values instead of summing every
 * event, which would overcount a cumulative completion token field.
 */
export const createTokenUsageAccumulator = (): TokenUsageAccumulator => {
  let seen = false;
  let explicitTotal: number | null = null;
  let input = 0;
  let output = 0;

  return {
    observe(payload: unknown): void {
      const usage = extractTokenUsage(payload);
      if (usage.totalTokens === null && usage.inputTokens === 0 && usage.outputTokens === 0) return;
      seen = true;
      if (usage.explicitTotal && usage.totalTokens !== null) {
        explicitTotal = explicitTotal === null ? usage.totalTokens : Math.max(explicitTotal, usage.totalTokens);
      }
      input = Math.max(input, usage.inputTokens);
      output = Math.max(output, usage.outputTokens);
    },
    hasUsage: () => seen,
    totalTokens: () => {
      if (!seen) return null;
      // Providers can send input and output usage in separate cumulative events.
      // Combining the component maxima avoids returning only the first event's total.
      return Math.max(explicitTotal ?? 0, input + output);
    },
  };
};
