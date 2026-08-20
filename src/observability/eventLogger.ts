import { mkdir, appendFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { SettingsStore } from "../settings/settingsStore.js";

type LogType = "audit" | "requests" | "errors";

interface EventRecord {
  [key: string]: unknown;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export class EventLogger {
  private cleanupDate = "";

  constructor(private readonly settingsStore: SettingsStore, private readonly logsDir: string) {}

  audit(record: EventRecord): void {
    const settings = this.settingsStore.get();
    if (!settings.logEnabled || !settings.logAudit) return;
    this.write("audit", record, settings.logRetentionDays);
  }

  apiRequest(record: EventRecord): void {
    const settings = this.settingsStore.get();
    if (!settings.logEnabled || !settings.logApiRequests) return;
    this.write("requests", record, settings.logRetentionDays);
  }

  error(record: EventRecord): void {
    const settings = this.settingsStore.get();
    if (!settings.logEnabled) return;
    this.write("errors", record, settings.logRetentionDays);
  }

  private write(type: LogType, record: EventRecord, retentionDays: number): void {
    const date = today();
    const file = path.join(this.logsDir, `${type}-${date}.jsonl`);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), type, ...record })}\n`;
    mkdir(this.logsDir, { recursive: true })
      .then(() => appendFile(file, line, "utf8"))
      .then(() => this.cleanup(retentionDays))
      .catch(() => {
        // Logging must never break request handling.
      });
  }

  private async cleanup(retentionDays: number): Promise<void> {
    if (retentionDays <= 0) return;
    const date = today();
    if (this.cleanupDate === date) return;
    this.cleanupDate = date;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const files = await readdir(this.logsDir).catch(() => [] as string[]);
    await Promise.all(files
      .filter((file) => /^(audit|requests|errors)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .map(async (file) => {
        const match = file.match(/(\d{4}-\d{2}-\d{2})/);
        const fileDate = match?.[1];
        if (!fileDate || Date.parse(fileDate) >= cutoff) return;
        await unlink(path.join(this.logsDir, file)).catch(() => undefined);
      }));
  }
}

export const clientIdFromHeaders = (headers: Record<string, string | string[] | undefined>): string => {
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  return first(headers["x-client-id"]) || first(headers["x-device-id"]) || first(headers["x-session-id"]) || "unknown-client";
};
