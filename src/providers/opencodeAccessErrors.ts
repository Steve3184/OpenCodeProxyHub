const OPENCODE_PROXY_ACCESS_MESSAGES = [
  "opencode's free tier can only be used from within opencode",
  "your access has been restricted due to repeated policy violations",
] as const;

export interface UpstreamErrorPayload {
  message: string;
  statusCode: number;
  rateLimited: boolean;
  proxyAccessError: boolean;
  body: string;
}

/** Parse an error payload from either a plain JSON reply or one SSE data event. */
export const parseUpstreamErrorPayload = (statusCode: number, body: string): UpstreamErrorPayload | null => {
  let parsed: { error?: unknown; type?: unknown; message?: unknown; response?: { error?: unknown } } | null = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // HTTP failures may have a non-JSON body.
  }
  const hasError = parsed && typeof parsed === "object"
    && (parsed.error || parsed.type === "error" || (parsed.type === "response.failed" && parsed.response?.error));
  if (statusCode < 400 && !hasError) return null;
  const error = parsed?.error ?? (parsed?.type === "response.failed" ? parsed.response?.error : undefined);
  const errorMessage = typeof error === "string"
    ? error
    : error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : undefined;
  const message = errorMessage || (typeof parsed?.message === "string" ? parsed.message : statusCode >= 400 ? `Upstream returned HTTP ${statusCode}` : "Upstream error");
  const rateLimited = isUpstreamRateLimitError(statusCode, body);
  const proxyAccessError = isOpenCodeProxyAccessError(statusCode, body);
  return {
    message,
    statusCode: rateLimited ? 429 : proxyAccessError ? 403 : statusCode >= 400 ? statusCode : 502,
    rateLimited,
    proxyAccessError,
    body,
  };
};

/** Zen labels errors returned by the Console provider; these are not proxy failures. */
export const isConsoleProviderError = (body: string): boolean => {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message ?? parsed?.message
      ?? (parsed?.type === "response.failed" ? parsed?.response?.error?.message : undefined) ?? body;
  } catch {
    // Callers may already have extracted the upstream message.
  }
  return typeof message === "string" && /^\s*Error from provider\s*\(Console\):/i.test(message);
};

export const isOpenCodeProxyAccessError = (statusCode: number, body: string): boolean => {
  if (statusCode !== 403 && !body.includes("status_code=403")) return false;
  const normalized = body.toLowerCase();
  return OPENCODE_PROXY_ACCESS_MESSAGES.some((message) => normalized.includes(message));
};

export const isUpstreamRateLimitError = (statusCode: number, body: string): boolean => {
  const normalized = body.toLowerCase();
  return statusCode === 429
    || body.includes("FreeUsageLimitError")
    || body.includes("rate_limit_error")
    || body.includes("rate_limit_exceeded")
    || normalized.includes("upstream returned http 429")
    || normalized.includes("rate limit");
};

export const shouldRetryWithAnotherProxy = (statusCode: number, body: string): boolean => (
  isUpstreamRateLimitError(statusCode, body) || isOpenCodeProxyAccessError(statusCode, body)
);
