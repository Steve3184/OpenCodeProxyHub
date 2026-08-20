import crypto from "node:crypto";

interface AdminSession {
  expiresAt: number;
}

/** In-memory console sessions keep the configured admin password out of normal requests. */
export class AdminSessionStore {
  private readonly sessions = new Map<string, AdminSession>();

  constructor(private readonly ttlMs = 30 * 60 * 1000) {}

  create(): string {
    this.removeExpired();
    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(token, { expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  validate(token: string): boolean {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revoke(token: string): void {
    if (token) this.sessions.delete(token);
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}
