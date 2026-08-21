import { JsonFileStore } from "../storage/jsonFile.js";

export interface SystemSettings {
  requestBodyLimitBytes: number;
  upstreamTimeoutMs: number;
  defaultStream: boolean;
  openAiStreamTransformModels: string[];
  reasoningTagModels: string[];
  proxyMode: "direct" | "optional" | "required";
  outboundPreProxyEnabled: boolean;
  outboundPreProxyUrl: string;
  logEnabled: boolean;
  logAudit: boolean;
  logApiRequests: boolean;
  logRetentionDays: number;
  globalRequestsPerMinute: number;
  apiKeyRequestsPerMinute: number;
  apiKeyMaxConcurrentRequests: number;
  apiKeyMaxConcurrentStreams: number;
}

interface SettingsFile {
  version: 1;
  settings: SystemSettings;
}

export type SystemSettingsUpdate = Partial<SystemSettings>;

const DEFAULT_SETTINGS: SystemSettings = {
  requestBodyLimitBytes: 10 * 1024 * 1024,
  upstreamTimeoutMs: 120000,
  defaultStream: false,
  openAiStreamTransformModels: [],
  reasoningTagModels: [],
  proxyMode: "optional",
  outboundPreProxyEnabled: false,
  outboundPreProxyUrl: "",
  logEnabled: false,
  logAudit: true,
  logApiRequests: true,
  logRetentionDays: 7,
  globalRequestsPerMinute: 120,
  apiKeyRequestsPerMinute: 60,
  apiKeyMaxConcurrentRequests: 10,
  apiKeyMaxConcurrentStreams: 5,
};

export class SettingsStore {
  private readonly store: JsonFileStore<SettingsFile>;
  private settings: SystemSettings = { ...DEFAULT_SETTINGS };

  constructor(settingsFile: string, overrides: Partial<SystemSettings> = {}) {
    this.store = new JsonFileStore<SettingsFile>(settingsFile);
    this.settings = { ...DEFAULT_SETTINGS, ...overrides };
  }

  load(): void {
    const data = this.store.read({ version: 1, settings: this.settings });
    const { logPrompts: _legacyLogPrompts, logMaxBodyChars: _legacyLogMaxBodyChars, ...storedSettings } = data.settings as SystemSettings & { logPrompts?: unknown; logMaxBodyChars?: unknown };
    this.settings = { ...DEFAULT_SETTINGS, ...this.settings, ...storedSettings };
    this.persist();
  }

  get(): SystemSettings {
    return { ...this.settings };
  }

  update(input: SystemSettingsUpdate): SystemSettings {
    if (input.requestBodyLimitBytes !== undefined) {
      if (!Number.isFinite(input.requestBodyLimitBytes) || input.requestBodyLimitBytes < 1024) {
        throw new Error("requestBodyLimitBytes must be at least 1024");
      }
      this.settings.requestBodyLimitBytes = Math.trunc(input.requestBodyLimitBytes);
    }

    if (input.upstreamTimeoutMs !== undefined) {
      if (!Number.isFinite(input.upstreamTimeoutMs) || input.upstreamTimeoutMs < 1000) {
        throw new Error("upstreamTimeoutMs must be at least 1000");
      }
      this.settings.upstreamTimeoutMs = Math.trunc(input.upstreamTimeoutMs);
    }

    if (input.defaultStream !== undefined) this.settings.defaultStream = Boolean(input.defaultStream);
    if (input.logEnabled !== undefined) this.settings.logEnabled = Boolean(input.logEnabled);
    if (input.logAudit !== undefined) this.settings.logAudit = Boolean(input.logAudit);
    if (input.logApiRequests !== undefined) this.settings.logApiRequests = Boolean(input.logApiRequests);
    if (input.logRetentionDays !== undefined) {
      if (!Number.isFinite(input.logRetentionDays) || input.logRetentionDays < 0) throw new Error("logRetentionDays must be at least 0");
      this.settings.logRetentionDays = Math.trunc(input.logRetentionDays);
    }

    if (input.globalRequestsPerMinute !== undefined) {
      if (!Number.isFinite(input.globalRequestsPerMinute) || input.globalRequestsPerMinute < 0) {
        throw new Error("globalRequestsPerMinute must be at least 0 (0 = unlimited)");
      }
      this.settings.globalRequestsPerMinute = Math.trunc(input.globalRequestsPerMinute);
    }

    if (input.apiKeyRequestsPerMinute !== undefined) {
      if (!Number.isFinite(input.apiKeyRequestsPerMinute) || input.apiKeyRequestsPerMinute < 0) {
        throw new Error("apiKeyRequestsPerMinute must be at least 0 (0 = unlimited)");
      }
      this.settings.apiKeyRequestsPerMinute = Math.trunc(input.apiKeyRequestsPerMinute);
    }

    if (input.apiKeyMaxConcurrentRequests !== undefined) {
      if (!Number.isFinite(input.apiKeyMaxConcurrentRequests) || input.apiKeyMaxConcurrentRequests < 0) {
        throw new Error("apiKeyMaxConcurrentRequests must be at least 0 (0 = unlimited)");
      }
      this.settings.apiKeyMaxConcurrentRequests = Math.trunc(input.apiKeyMaxConcurrentRequests);
    }

    if (input.apiKeyMaxConcurrentStreams !== undefined) {
      if (!Number.isFinite(input.apiKeyMaxConcurrentStreams) || input.apiKeyMaxConcurrentStreams < 0) {
        throw new Error("apiKeyMaxConcurrentStreams must be at least 0 (0 = unlimited)");
      }
      this.settings.apiKeyMaxConcurrentStreams = Math.trunc(input.apiKeyMaxConcurrentStreams);
    }

    if (input.openAiStreamTransformModels !== undefined) {
      if (!Array.isArray(input.openAiStreamTransformModels)) {
        throw new Error("openAiStreamTransformModels must be an array");
      }
      this.settings.openAiStreamTransformModels = [...new Set(input.openAiStreamTransformModels
        .map((model) => String(model).trim())
        .filter(Boolean))];
    }

    if (input.reasoningTagModels !== undefined) {
      if (!Array.isArray(input.reasoningTagModels)) {
        throw new Error("reasoningTagModels must be an array");
      }
      this.settings.reasoningTagModels = [...new Set(input.reasoningTagModels
        .map((model) => String(model).trim())
        .filter(Boolean))];
    }

    if (input.proxyMode !== undefined) {
      if (!["direct", "optional", "required"].includes(input.proxyMode)) {
        throw new Error("proxyMode must be direct, optional, or required");
      }
      this.settings.proxyMode = input.proxyMode;
    }

    // Pre-proxy: validate the merged (patch + current) state so enabled never coexists with an empty/invalid url.
    if (input.outboundPreProxyEnabled !== undefined || input.outboundPreProxyUrl !== undefined) {
      const nextUrl = (input.outboundPreProxyUrl !== undefined ? input.outboundPreProxyUrl : this.settings.outboundPreProxyUrl).trim();
      const nextEnabled = input.outboundPreProxyEnabled !== undefined ? Boolean(input.outboundPreProxyEnabled) : this.settings.outboundPreProxyEnabled;
      if (nextUrl) {
        let protocol = "";
        try {
          protocol = new URL(nextUrl).protocol;
        } catch {
          throw new Error("outboundPreProxyUrl must be a valid URL");
        }
        if (!["http:", "https:"].includes(protocol)) throw new Error("outboundPreProxyUrl must use http:// or https://");
      }
      if (nextEnabled && !nextUrl) throw new Error("outboundPreProxyUrl is required when outboundPreProxyEnabled is true");
      this.settings.outboundPreProxyUrl = nextUrl;
      this.settings.outboundPreProxyEnabled = nextEnabled;
    }

    this.persist();
    return this.get();
  }

  private persist(): void {
    this.store.write({ version: 1, settings: this.settings });
  }
}
