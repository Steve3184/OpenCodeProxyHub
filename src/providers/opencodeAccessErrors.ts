const OPENCODE_PROXY_ACCESS_MESSAGES = [
  "opencode's free tier can only be used from within opencode",
  "your access has been restricted due to repeated policy violations",
] as const;

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
    || normalized.includes("rate limit");
};

export const shouldRetryWithAnotherProxy = (statusCode: number, body: string): boolean => (
  isUpstreamRateLimitError(statusCode, body) || isOpenCodeProxyAccessError(statusCode, body)
);
