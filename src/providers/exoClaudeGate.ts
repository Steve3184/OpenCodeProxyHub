/**
 * exo-free Claude-only gate.
 *
 * Upstream `exo-free` randomly lands on a GPT backend or a Claude backend.
 * Over the Chat Completions streaming protocol both backends speak the same
 * SSE shape, but the first SSE data block carrying an `id` tells them apart:
 *   - `msg_...`  -> Claude backend (keep, stream through)
 *   - `resp_...` -> GPT backend (abort, retry with a fresh x-opencode-request)
 *
 * The gate only inspects; it never rewrites payloads. It applies exclusively
 * to Chat Completions shaped exo-free requests. Anything else (other models,
 * Responses/SystemOne protocol bodies, unclassifiable ids) passes through
 * untouched (fail-open).
 */

export const EXO_FREE_MODEL_ID = "exo-free";

/** Downstream alias that points at the Claude-locked exo-free model. */
export const EXO_CLAUDE_DOWNSTREAM_MODEL_ID = "claude-opus-5.5";

/** Backend retries (not counting the initial attempt). 1 + 10 = 11 upstream tries max. */
export const EXO_FREE_CLAUDE_MAX_BACKEND_RETRIES = 10;

/** Cap for pre-decision buffering while waiting for the first classifiable id. */
export const EXO_GATE_PEEK_BYTES = 64 * 1024;

export type ExoBackend = "claude" | "gpt" | "unknown";

const classifyId = (id: unknown): ExoBackend | null => {
  if (typeof id !== "string" || !id) return null;
  if (id.startsWith("msg_")) return "claude";
  if (id.startsWith("resp_")) return "gpt";
  return null;
};

const isErrorRecord = (record: unknown): boolean => {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const obj = record as Record<string, unknown>;
  return Boolean(obj.error) || obj.type === "error";
};

const backendFromRecord = (record: unknown): ExoBackend | null => {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const obj = record as Record<string, unknown>;
  // Direct id first (chat chunk / chat completion object), then nested response id.
  const direct = classifyId(obj.id);
  if (direct) return direct;
  const response = obj.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const nested = classifyId((response as Record<string, unknown>).id);
    if (nested) return nested;
  }
  return null;
};

const classifyRecord = (record: unknown): ExoBackend | null => {
  // Error bodies are never a backend decision: let the normal error path run.
  if (isErrorRecord(record)) return "claude";
  return backendFromRecord(record);
};

/**
 * Scan SSE text (or a plain JSON body) for the first payload carrying an id
 * and classify it. Returns "unknown" when no classifiable id is present yet
 * (e.g. partial JSON split across chunks, or id-less payloads).
 */
export const classifyExoBackendFromSseText = (text: string): ExoBackend => {
  const normalized = text.replace(/\r\n/g, "\n");
  const trimmed = normalized.trim();
  if (trimmed.startsWith("{")) {
    try {
      return classifyRecord(JSON.parse(trimmed) as unknown) ?? "unknown";
    } catch {
      // Partial JSON split across chunks: fall through to SSE scanning.
    }
  }
  let dataLines: string[] = [];
  const flush = (): ExoBackend | null => {
    if (dataLines.length === 0) return null;
    const joined = dataLines.join("\n").trim();
    dataLines = [];
    if (!joined || joined === "[DONE]") return null;
    try {
      return classifyRecord(JSON.parse(joined) as unknown);
    } catch {
      // Partial JSON split across chunks: keep buffering.
      return null;
    }
  };
  for (const line of normalized.split("\n")) {
    if (line === "") {
      const found = flush();
      if (found) return found;
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return flush() ?? "unknown";
};

/** Classify an already-aggregated (non-stream) upstream body. */
export const classifyExoBackendFromAggregated = (data: unknown): ExoBackend =>
  backendFromRecord(data) ?? "unknown";

const parsedPreparedBody = (body: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

/**
 * True only for Chat Completions shaped exo-free upstream requests: the model
 * is `exo-free` and the body carries a `messages` array. Responses bodies
 * (`input`) and SystemOne bodies always use `resp_`-style ids of their own,
 * so the msg_/resp_ heuristic must not apply to them.
 */
export const isExoClaudeGateApplicable = (body: string, responsesProtocol = false): boolean => {
  if (responsesProtocol) return false;
  const parsed = parsedPreparedBody(body);
  if (!parsed || parsed.model !== EXO_FREE_MODEL_ID) return false;
  return Array.isArray(parsed.messages);
};

export const exoBackendMismatchMessage = (attempts: number): string =>
  `exo-free routed to the GPT backend (resp_) ${attempts} time${attempts === 1 ? "" : "s"}; Claude-only retry budget exhausted`;

/**
 * Incremental pre-decision buffer for streaming pipes. Feed raw upstream
 * chunks; once the first classifiable id arrives the backend is decided.
 * Payloads without a classifiable id buffer up to `cap` bytes and then
 * fail open as "claude" so unknown deployments stream through untouched.
 */
export class ExoStreamGate {
  private chunks: Buffer[] = [];
  private bytes = 0;
  /** Set once a backend has been decided (including fail-open at the cap). */
  decided = false;

  constructor(private readonly cap: number = EXO_GATE_PEEK_BYTES) {}

  get bufferedBytes(): number {
    return this.bytes;
  }

  push(chunk: Buffer): ExoBackend | "pending" {
    if (this.bytes < this.cap) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
    }
    const text = Buffer.concat(this.chunks).toString("utf8");
    const backend = classifyExoBackendFromSseText(text);
    if (backend !== "unknown") {
      this.decided = true;
      return backend;
    }
    if (this.bytes >= this.cap) {
      this.decided = true;
      return "claude";
    }
    return "pending";
  }

  drain(): Buffer[] {
    const buffered = this.chunks;
    this.chunks = [];
    this.bytes = 0;
    return buffered;
  }
}
