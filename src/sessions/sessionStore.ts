import { ocId } from "../utils/ids.js";

const firstHeader = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;

interface SessionEntry {
  id: string;
  ts: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly ttlMs = 30 * 60 * 1000) {}

  getSession(user: string): string {
    const now = Date.now();
    const existing = this.sessions.get(user);
    if (existing && now - existing.ts <= this.ttlMs) return existing.id;

    const entry = { id: ocId("ses"), ts: now };
    this.sessions.set(user, entry);
    return entry.id;
  }
}

export const sessionScopeFromHeaders = (
  keyId: string,
  protocol: "openai" | "anthropic" | "responses",
  model: string,
  headers: Record<string, string | string[] | undefined>,
): string => {
  const explicitSession = firstHeader(headers["x-session-id"]);
  const clientId = firstHeader(headers["x-client-id"]) || firstHeader(headers["x-device-id"]);
  const clientScope = explicitSession || clientId || ocId("anon");
  return `${keyId}:${protocol}:${model}:${clientScope}`;
};
