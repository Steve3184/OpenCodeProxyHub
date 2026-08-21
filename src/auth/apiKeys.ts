import crypto from "node:crypto";
import { JsonFileStore } from "../storage/jsonFile.js";

export type ApiKeyMap = Record<string, string>;

export interface ApiKeyPolicy {
  requestsPerMinute?: number;
  maxConcurrentRequests?: number;
  maxConcurrentStreams?: number;
  allowedModels?: string[];
  allowProxy?: boolean;
}

interface ApiKeyClientUsage {
  id: string;
  userAgent: string;
  firstSeenAt: string;
  lastSeenAt: string;
  requestCount: number;
}

interface ApiKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  description?: string;
  labels?: string[];
  policy?: ApiKeyPolicy;
  requestCount?: number;
  recentClients?: ApiKeyClientUsage[];
  keyPlaintext?: string;
}

interface ApiKeyFile {
  version: 1;
  keys: ApiKeyRecord[];
}

export interface CreatedApiKey {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
}

interface GeneratedApiKey {
  record: ApiKeyRecord;
  created: CreatedApiKey;
}

export interface PublicApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  description?: string;
  labels: string[];
  policy: ApiKeyPolicy;
  requestCount: number;
  recentClients: ApiKeyClientUsage[];
  hasRecoverableKey: boolean;
}

export interface AuthenticatedApiKey {
  id: string;
  name: string;
  policy: ApiKeyPolicy;
}

export interface UpdateApiKeyInput {
  name?: string;
  enabled?: boolean;
  description?: string;
  labels?: string[];
  policy?: ApiKeyPolicy;
}

interface AuthenticateOptions {
  trackUsage?: boolean;
}

export class ApiKeyStore {
  private readonly store: JsonFileStore<ApiKeyFile | ApiKeyMap>;
  private records: ApiKeyRecord[] = [];
  private createdOnLoad: CreatedApiKey[] = [];
  private statsDirty = false;
  private lastStatsPersistAt = 0;

  constructor(keysFile: string, private readonly storePlaintextKeys = false) {
    this.store = new JsonFileStore<ApiKeyFile | ApiKeyMap>(keysFile);
  }

  load(): void {
    const data = this.store.read({ version: 1, keys: [] });
    this.records = this.normalizeFile(data);

    if (this.records.length === 0) {
      const generated = [this.createRecord("admin"), this.createRecord("user-default")];
      this.createdOnLoad = generated.map((item) => item.created);
      this.records = generated.map((item) => item.record);
    }

    this.persist();
  }

  authenticate(headers: Record<string, string | string[] | undefined>, options: AuthenticateOptions = {}): string | null {
    return this.authenticateKey(headers, options)?.name || null;
  }

  authenticateKey(headers: Record<string, string | string[] | undefined>, options: AuthenticateOptions = {}): AuthenticatedApiKey | null {
    const authHeader = this.firstHeader(headers.authorization);
    const apiKeyHeader = this.firstHeader(headers["x-api-key"]);
    const raw = authHeader || apiKeyHeader || "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;

    if (!token) return null;

    const tokenHash = this.hashKey(token);
    for (const record of this.records) {
      if (!record.enabled) continue;
      if (tokenHash !== record.keyHash) continue;
      if (options.trackUsage !== false) {
        record.lastUsedAt = new Date().toISOString();
        record.requestCount = (record.requestCount || 0) + 1;
        this.persistStatsMaybe();
      }
      return { id: record.id, name: record.name, policy: this.normalizePolicy(record.policy) };
    }
    return null;
  }

  list(): PublicApiKey[] {
    return this.records.map((record) => this.toPublic(record));
  }

  create(name: string): CreatedApiKey {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("API key name is required");
    if (this.records.some((record) => record.name === cleanName)) {
      throw new Error(`API key name already exists: ${cleanName}`);
    }

    const generated = this.createRecord(cleanName);
    this.records.push(generated.record);
    this.persist();
    return generated.created;
  }

  getSecret(id: string): string | null {
    return this.findRecord(id)?.keyPlaintext || null;
  }

  update(id: string, input: UpdateApiKeyInput): PublicApiKey {
    const record = this.findRecord(id);
    if (!record) throw new Error("API key not found");

    if (input.name !== undefined) {
      const cleanName = input.name.trim();
      if (!cleanName) throw new Error("API key name is required");
      if (this.records.some((item) => item.id !== id && item.name === cleanName)) {
        throw new Error(`API key name already exists: ${cleanName}`);
      }
      record.name = cleanName;
    }

    if (input.enabled !== undefined) record.enabled = input.enabled;
    if (input.description !== undefined) record.description = input.description.trim() || undefined;
    if (input.labels !== undefined) record.labels = input.labels.map((label) => label.trim()).filter(Boolean).slice(0, 12);
    if (input.policy !== undefined) record.policy = this.normalizePolicy(input.policy);
    this.persist();
    return this.toPublic(record);
  }

  isModelAllowed(id: string, model: string): boolean {
    const record = this.findRecord(id);
    const allowedModels = record?.policy?.allowedModels || [];
    return allowedModels.length === 0 || allowedModels.includes(model);
  }

  recordClientUsage(id: string, headers: Record<string, string | string[] | undefined>): void {
    const record = this.findRecord(id);
    if (!record) return;
    const clientId = this.firstHeader(headers["x-client-id"]) || this.firstHeader(headers["x-device-id"]) || "unknown-client";
    const userAgent = this.firstHeader(headers["user-agent"]) || "unknown-agent";
    const now = new Date().toISOString();
    const recentClients = record.recentClients || [];
    const existing = recentClients.find((client) => client.id === clientId && client.userAgent === userAgent);
    if (existing) {
      existing.lastSeenAt = now;
      existing.requestCount += 1;
    } else {
      recentClients.unshift({ id: clientId, userAgent, firstSeenAt: now, lastSeenAt: now, requestCount: 1 });
    }
    record.recentClients = recentClients
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, 10);
    this.persist();
  }

  delete(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length === before) return false;
    this.persist();
    return true;
  }

  consumeCreatedOnLoad(): CreatedApiKey[] {
    const created = this.createdOnLoad;
    this.createdOnLoad = [];
    return created;
  }

  private firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  private normalizeFile(data: ApiKeyFile | ApiKeyMap): ApiKeyRecord[] {
    if (this.isVersionedFile(data)) return data.keys;

    const now = new Date().toISOString();
    return Object.entries(data).map(([name, key]) => ({
      id: crypto.randomUUID(),
      name,
      keyHash: this.hashKey(key),
      keyPrefix: this.prefixKey(key),
      enabled: true,
      createdAt: now,
      lastUsedAt: null,
      labels: [],
      policy: {},
      requestCount: 0,
      recentClients: [],
      ...(this.storePlaintextKeys ? { keyPlaintext: key } : {}),
    }));
  }

  private findRecord(id: string): ApiKeyRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  private toPublic(record: ApiKeyRecord): PublicApiKey {
    const { id, name, keyPrefix, enabled, createdAt, lastUsedAt } = record;
    return {
      id,
      name,
      keyPrefix,
      enabled,
      createdAt,
      lastUsedAt,
      description: record.description,
      labels: record.labels || [],
      policy: this.normalizePolicy(record.policy),
      requestCount: record.requestCount || 0,
      recentClients: record.recentClients || [],
      hasRecoverableKey: Boolean(record.keyPlaintext),
    };
  }

  private isVersionedFile(data: ApiKeyFile | ApiKeyMap): data is ApiKeyFile {
    return typeof data === "object" && data !== null && "version" in data && Array.isArray((data as ApiKeyFile).keys);
  }

  private createRecord(name: string): GeneratedApiKey {
    const key = `oc-${crypto.randomBytes(20).toString("hex")}`;
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      name,
      keyHash: this.hashKey(key),
      keyPrefix: this.prefixKey(key),
      enabled: true,
      createdAt: now,
      lastUsedAt: null,
      labels: [],
      policy: {},
      requestCount: 0,
      recentClients: [],
      ...(this.storePlaintextKeys ? { keyPlaintext: key } : {}),
    };
    return {
      record,
      created: {
        id: record.id,
        name: record.name,
        key,
        keyPrefix: record.keyPrefix,
      },
    };
  }

  private persist(): void {
    this.store.write({ version: 1, keys: this.records });
    this.statsDirty = false;
    this.lastStatsPersistAt = Date.now();
  }

  private persistStatsMaybe(): void {
    this.statsDirty = true;
    const now = Date.now();
    if (now - this.lastStatsPersistAt < 5000) return;
    this.persist();
  }

  private hashKey(key: string): string {
    return crypto.createHash("sha256").update(key).digest("hex");
  }

  private prefixKey(key: string): string {
    return key.length <= 10 ? "***" : `${key.slice(0, 7)}...${key.slice(-4)}`;
  }

  private normalizePolicy(policy: ApiKeyPolicy | undefined): ApiKeyPolicy {
    if (!policy) return { allowProxy: true };
    return {
      ...(policy.requestsPerMinute !== undefined ? { requestsPerMinute: Math.max(0, Math.trunc(policy.requestsPerMinute)) } : {}),
      ...(policy.maxConcurrentRequests !== undefined ? { maxConcurrentRequests: Math.max(0, Math.trunc(policy.maxConcurrentRequests)) } : {}),
      ...(policy.maxConcurrentStreams !== undefined ? { maxConcurrentStreams: Math.max(0, Math.trunc(policy.maxConcurrentStreams)) } : {}),
      ...(policy.allowedModels !== undefined ? { allowedModels: policy.allowedModels.map((model) => model.trim()).filter(Boolean) } : {}),
      // Proxy usage is enabled by default. Only an explicit false disables it.
      allowProxy: policy.allowProxy !== false,
    };
  }
}
