// no-cache alone allows storage; no-store forbids it. no-transform tells
// intermediaries (including Cloudflare) to leave the response uncompressed.
export const API_RESPONSE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, no-transform",
  "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
} as const;

export const SSE_RESPONSE_HEADERS = {
  ...API_RESPONSE_HEADERS,
  "Content-Type": "text/event-stream",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "Transfer-Encoding": "chunked",
} as const;
