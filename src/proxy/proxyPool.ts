import crypto from "node:crypto";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { JsonFileStore } from "../storage/jsonFile.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import { HttpPreProxyToHttpAgent, HttpPreProxyToSocksAgent } from "./chainedAgent.js";
import { ocId } from "../utils/ids.js";

export type ProxyType = "http" | "https" | "socks5";

export interface ProxyNode {
  id: string;
  name: string;
  type: ProxyType;
  url: string;
  enabled: boolean;
  weight: number;
  maxConcurrency: number;
  currentConcurrency: number;
  dailyRequestLimit: number;
  dailyRequestCount: number;
  dailyCountDate: string;
  autoDisableWhenDailyLimitReached: boolean;
  consecutiveRateLimitCount: number;
  autoDisabledBy429: boolean;
  lastRecoveryTestAt: string | null;
  cooldownUntil: string | null;
  successCount: number;
  failCount: number;
  totalTokens: number;
  dailyTokens: number;
  dailyTokensDate: string;
  recentResults: ProxyRequestResult[];
  lastError: string | null;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
}

export interface ProxyRequestResult {
  at: string;
  ok: boolean;
  statusCode: number;
}

interface ProxyFile {
  version: 1 | 2;
  proxies: ProxyNode[] | ProxyStaticNode[];
}

type ProxyStaticNode = Pick<ProxyNode,
  "id" | "name" | "type" | "url" | "enabled" | "weight" | "maxConcurrency"
  | "dailyRequestLimit" | "autoDisableWhenDailyLimitReached">;

interface ProxyState {
  enabled: boolean;
  dailyRequestCount: number;
  dailyCountDate: string;
  consecutiveRateLimitCount: number;
  autoDisabledBy429: boolean;
  lastRecoveryTestAt: string | null;
  cooldownUntil: string | null;
  successCount: number;
  failCount: number;
  totalTokens: number;
  dailyTokens: number;
  dailyTokensDate: string;
  recentResults: ProxyRequestResult[];
  lastError: string | null;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
}

interface ProxyStateFile {
  version: 1;
  states: Record<string, ProxyState>;
}

interface ProxyStateJournalEntry {
  id: string;
  state?: ProxyState;
  deleted?: boolean;
}

export interface ProxyInput {
  name?: string;
  type?: ProxyType;
  url?: string;
  enabled?: boolean;
  weight?: number;
  maxConcurrency?: number;
  dailyRequestLimit?: number;
  autoDisableWhenDailyLimitReached?: boolean;
}

export interface ProxyLease {
  node: ProxyNode | null;
  /** Unique lease token used to make settlement/release idempotent. */
  leaseId?: string;
  agent?: https.Agent;
  requiredUnavailable?: boolean;
}

export interface ProxyModelTestOptions {
  hostname: string;
  path: string;
  model: string;
  timeoutMs: number;
  recoveryIntervalMs?: number;
  /** System One models (jev) reject OpenAI-shaped bodies, so they probe here with a state/questions request. */
  protocol?: "chat_completions" | "responses" | "systemone";
}

export interface ProxyRecoverySummary {
  tested: number;
  recovered: number;
}

export interface ProxyPoolOptions {
  persistDebounceMs?: number;
  recoveryConcurrency?: number;
  recoveryBatchSize?: number;
}

interface RecoveryProbeState {
  enabled: boolean;
  autoDisabledBy429: boolean;
  currentConcurrency: number;
  lastError: string | null;
  lastCheckedAt: string | null;
  lastRecoveryTestAt: string;
  endpoint: string;
}

const DEFAULT_MODEL_TEST_OPTIONS: ProxyModelTestOptions = {
  hostname: "opencode.ai",
  path: "/zen/v1/chat/completions",
  model: "big-pickle",
  timeoutMs: 10000,
  protocol: "chat_completions",
};

const DEFAULT_PROXY_COOLDOWN_MS = 5 * 60 * 1000;

const isMuseModel = (model: string | undefined): boolean => Boolean(model && model.toLowerCase().replace(/^oc\//, "").startsWith("muse-"));

/** Muse traffic through Cyber nodes is known to trigger upstream account restrictions. */
export const isProxyCompatibleWithModel = (node: Pick<ProxyNode, "name" | "url">, model?: string): boolean => {
  if (!isMuseModel(model)) return true;
  return !/cyber/i.test(`${node.name} ${node.url}`);
};

const today = () => new Date().toISOString().slice(0, 10);

export class ProxyPoolStore {
  private readonly store: JsonFileStore<ProxyFile>;
  private readonly stateStore: JsonFileStore<ProxyStateFile>;
  private readonly stateJournal: JsonFileStore<ProxyStateJournalEntry>;
  private readonly persistDebounceMs: number;
  private readonly recoveryConcurrency: number;
  private readonly recoveryBatchSize: number;
  private proxies: ProxyNode[] = [];
  private readonly proxiesById = new Map<string, ProxyNode>();
  private readonly recoveryTestsInFlight = new Set<string>();
  private readonly activeLeases = new Map<string, string>();
  private recoveryRunInFlight = false;
  private configPersistTimer: NodeJS.Timeout | undefined;
  private statePersistTimer: NodeJS.Timeout | undefined;
  private configDirty = false;
  private stateDirty = false;
  private readonly dirtyStateIds = new Set<string>();
  private readonly deletedStateIds = new Set<string>();
  private configFlushPromise: Promise<void> | undefined;
  private stateFlushPromise: Promise<void> | undefined;
  private writeQueue = Promise.resolve();

  constructor(proxiesFile: string, private readonly settingsStore: SettingsStore, options: ProxyPoolOptions = {}) {
    this.store = new JsonFileStore<ProxyFile>(proxiesFile);
    this.stateStore = new JsonFileStore<ProxyStateFile>(`${proxiesFile}.state`);
    this.stateJournal = new JsonFileStore<ProxyStateJournalEntry>(`${proxiesFile}.state.log`);
    this.persistDebounceMs = Math.max(100, options.persistDebounceMs ?? 1000);
    this.recoveryConcurrency = Math.max(1, Math.min(16, options.recoveryConcurrency ?? 2));
    this.recoveryBatchSize = Math.max(1, Math.min(1000, options.recoveryBatchSize ?? 32));
  }

  load(): number {
    const data = this.store.read({ version: 1, proxies: [] });
    const stateData = this.stateStore.read({ version: 1, states: {} });
    const states: Record<string, ProxyState> = {
      ...(stateData && typeof stateData.states === "object" && stateData.states !== null ? stateData.states : {}),
    };
    for (const entry of this.stateJournal.readLines()) {
      if (entry.deleted) delete states[entry.id];
      else if (entry.state) states[entry.id] = entry.state;
    }
    this.proxies = (data.proxies as ProxyNode[]).map((node) => this.normalizeDaily({ ...node, ...(states[node.id] || {}) }));
    this.proxiesById.clear();
    for (const node of this.proxies) this.proxiesById.set(node.id, node);
    return this.proxies.length;
  }

  list(): ProxyNode[] {
    this.resetDailyIfNeeded();
    return this.proxies.map((proxy) => ({ ...proxy }));
  }

  summary(): { total: number; enabled: number; dailyRequestCount: number; dailyTokens: number } {
    this.resetDailyIfNeeded();
    let enabled = 0;
    let dailyRequestCount = 0;
    let dailyTokens = 0;
    for (const proxy of this.proxies) {
      if (proxy.enabled) enabled += 1;
      dailyRequestCount += proxy.dailyRequestCount;
      dailyTokens += proxy.dailyTokens;
    }
    return { total: this.proxies.length, enabled, dailyRequestCount, dailyTokens };
  }

  listPage(page = 1, pageSize = 200): { items: ProxyNode[]; total: number; page: number; pageSize: number; pageCount: number } {
    this.resetDailyIfNeeded();

    const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 200) : 200;
    const total = this.proxies.length;
    const pageCount = Math.max(1, Math.ceil(total / safePageSize));
    const safePage = Number.isInteger(page) && page > 0 ? Math.min(page, pageCount) : 1;
    const start = (safePage - 1) * safePageSize;

    return {
      items: this.proxies.slice(start, start + safePageSize).map((proxy) => ({ ...proxy })),
      total,
      page: safePage,
      pageSize: safePageSize,
      pageCount,
    };
  }

  create(input: ProxyInput): ProxyNode {
    const node = this.buildNode(input);
    this.validateNode(node);
    this.proxies.push(node);
    this.proxiesById.set(node.id, node);
    this.persistConfig();
    this.persistState(node.id);
    return { ...node };
  }

  update(id: string, input: ProxyInput): ProxyNode {
    const node = this.find(id);
    if (!node) throw new Error("Proxy not found");

    if (input.name !== undefined) node.name = input.name.trim();
    if (input.type !== undefined) node.type = input.type;
    if (input.url !== undefined) node.url = input.url.trim();
    if (input.enabled !== undefined) {
      node.enabled = input.enabled;
      if (input.enabled) {
        node.consecutiveRateLimitCount = 0;
        node.autoDisabledBy429 = false;
        node.lastRecoveryTestAt = null;
        if (node.lastError === "Disabled after 5 consecutive 429 responses") node.lastError = null;
      } else {
        // A manual disable must never be mistaken for a 429 circuit break.
        node.autoDisabledBy429 = false;
        node.lastRecoveryTestAt = null;
      }
    }
    if (input.weight !== undefined) node.weight = Math.max(1, Math.trunc(input.weight));
    if (input.maxConcurrency !== undefined) node.maxConcurrency = Math.max(1, Math.trunc(input.maxConcurrency));
    if (input.dailyRequestLimit !== undefined) node.dailyRequestLimit = Math.max(0, Math.trunc(input.dailyRequestLimit));
    if (input.autoDisableWhenDailyLimitReached !== undefined) node.autoDisableWhenDailyLimitReached = input.autoDisableWhenDailyLimitReached;

    this.validateNode(node);
    this.persistConfig();
    this.persistState(node.id);
    return { ...node };
  }

  delete(id: string): boolean {
    const before = this.proxies.length;
    this.proxies = this.proxies.filter((node) => node.id !== id);
    if (this.proxies.length === before) return false;
    for (const [leaseId, nodeId] of this.activeLeases) {
      if (nodeId === id) this.activeLeases.delete(leaseId);
    }
    this.proxiesById.delete(id);
    this.persistConfig();
    this.persistState(id, true);
    return true;
  }

  acquire(excludeProxyIds: ReadonlySet<string> = new Set(), model?: string): ProxyLease {
    this.resetDailyIfNeeded();
    const now = Date.now();
    // Do not sort the entire pool for every request. With tens of thousands of
    // nodes this changes acquire from O(n log n) to a single O(n) scan.
    let node: ProxyNode | undefined;
    for (const candidate of this.proxies) {
      if (!candidate.enabled || excludeProxyIds.has(candidate.id)) continue;
      if (!isProxyCompatibleWithModel(candidate, model)) continue;
      if (candidate.cooldownUntil && Date.parse(candidate.cooldownUntil) > now) continue;
      if (candidate.dailyRequestLimit !== 0 && candidate.dailyRequestCount >= candidate.dailyRequestLimit) continue;
      if (candidate.currentConcurrency >= candidate.maxConcurrency) continue;
      if (!node || candidate.weight > node.weight) node = candidate;
    }
    if (!node) return { node: null, requiredUnavailable: this.settingsStore.get().proxyMode === "required" };

    // Construct the agent before mutating counters. A malformed persisted proxy
    // must not consume a concurrency slot when agent construction throws.
    let agent: https.Agent;
    try {
      agent = this.createAgent(node);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create proxy agent";
      node.failCount += 1;
      node.lastError = message;
      node.lastCheckedAt = new Date().toISOString();
      node.cooldownUntil = new Date(Date.now() + DEFAULT_PROXY_COOLDOWN_MS).toISOString();
      node.lastRecoveryTestAt = null;
      this.recordResult(node, false, 502);
      this.persistState(node.id);
      // Try another node immediately; optional mode can still fall back to direct.
      return this.acquire(new Set([...excludeProxyIds, node.id]), model);
    }
    node.currentConcurrency += 1;
    node.dailyRequestCount += 1;
    node.lastUsedAt = new Date().toISOString();
    this.disableIfDailyLimitReached(node);
    this.persistState(node.id);

    const leaseId = crypto.randomUUID();
    this.activeLeases.set(leaseId, node.id);
    return { node: { ...node }, leaseId, agent };
  }

  release(id: string, leaseId?: string): void {
    const node = this.find(id);
    if (!node) return;
    if (!this.takeLease(id, leaseId)) return;
    this.persistState(id);
  }

  markSuccess(id: string, leaseId?: string, statusCode = 200): void {
    const node = this.find(id);
    if (!node) return;
    if (!this.takeLease(id, leaseId)) return;
    node.successCount += 1;
    if (!node.autoDisabledBy429) node.consecutiveRateLimitCount = 0;
    if (!node.autoDisabledBy429) node.lastRecoveryTestAt = null;
    this.recordResult(node, true, statusCode);
    if (!node.autoDisabledBy429) node.lastError = null;
    node.lastCheckedAt = new Date().toISOString();
    this.persistState(id);
  }

  markFailure(id: string, error: string, options: { statusCode?: number; cooldownMs?: number; leaseId?: string } = {}): void {
    const node = this.find(id);
    if (!node) return;
    if (!this.takeLease(id, options.leaseId)) return;
    node.failCount += 1;
    this.recordResult(node, false, options.statusCode || 502);
    node.lastError = error;
    node.lastCheckedAt = new Date().toISOString();
    if (options.statusCode === 429) {
      node.consecutiveRateLimitCount += 1;
      if (node.consecutiveRateLimitCount >= 5) {
        node.enabled = false;
        node.autoDisabledBy429 = true;
        node.lastRecoveryTestAt = null;
        node.cooldownUntil = null;
        node.lastError = "Disabled after 5 consecutive 429 responses";
      }
    } else {
      if (!node.autoDisabledBy429) {
        node.consecutiveRateLimitCount = 0;
        node.cooldownUntil = new Date(Date.now() + (options.cooldownMs ?? DEFAULT_PROXY_COOLDOWN_MS)).toISOString();
        // A new failure should be eligible for the next recovery cycle after its cooldown.
        node.lastRecoveryTestAt = null;
      }
    }
    this.persistState(id);
  }

  recordTokenUsage(id: string, totalTokens: number): void {
    const node = this.find(id);
    if (!node || !Number.isFinite(totalTokens) || totalTokens <= 0) return;
    this.resetDailyIfNeeded();
    const tokens = Math.max(0, Math.trunc(totalTokens));
    if (tokens === 0) return;
    node.totalTokens += tokens;
    node.dailyTokens += tokens;
    this.persistState(id);
  }

  clearStats(id: string): ProxyNode {
    const node = this.find(id);
    if (!node) throw new Error("Proxy not found");
    node.successCount = 0;
    node.failCount = 0;
    node.dailyRequestCount = 0;
    node.dailyCountDate = today();
    node.totalTokens = 0;
    node.dailyTokens = 0;
    node.dailyTokensDate = today();
    node.recentResults = [];
    this.persistState(id);
    return { ...node };
  }

  async test(id: string, options: ProxyModelTestOptions = DEFAULT_MODEL_TEST_OPTIONS): Promise<ProxyNode> {
    const node = this.find(id);
    if (!node) throw new Error("Proxy not found");
    this.validateNode(node);
    if (!isProxyCompatibleWithModel(node, options.model)) {
      throw new Error(`Proxy ${node.name} is not compatible with model ${options.model}`);
    }

    const checkedAt = new Date().toISOString();
    try {
      const statusCode = await this.requestModelHealthCheck(node, options);
      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`Model health check returned HTTP ${statusCode}`);
      }
      node.lastCheckedAt = checkedAt;
      if (node.autoDisabledBy429 && !node.enabled) node.lastRecoveryTestAt = checkedAt;
      node.lastError = null;
      if (!node.autoDisabledBy429) {
        node.cooldownUntil = null;
        node.lastRecoveryTestAt = null;
      }
      this.recordResult(node, true, statusCode);
      this.persistState(id);
      return { ...node };
    } catch (error) {
      node.lastCheckedAt = checkedAt;
      if (node.autoDisabledBy429 && !node.enabled) node.lastRecoveryTestAt = checkedAt;
      node.lastError = error instanceof Error ? error.message : "Model health check failed";
      this.recordResult(node, false, this.statusCodeFromHealthCheckError(error));
      this.persistState(id);
      throw error;
    }
  }

  /** Probe a bounded batch of abnormal nodes without overlapping recovery runs. */
  async recoverRateLimitedProxies(options: ProxyModelTestOptions): Promise<ProxyRecoverySummary> {
    if (this.recoveryRunInFlight) return { tested: 0, recovered: 0 };
    this.recoveryRunInFlight = true;
    try {
      const now = Date.now();
      const recoveryIntervalMs = options.recoveryIntervalMs ?? 10 * 60 * 1000;
      const candidates = this.proxies.filter((node) => {
        if (this.recoveryTestsInFlight.has(node.id)) return false;
        if (!isProxyCompatibleWithModel(node, options.model)) return false;
        return this.isRecoveryCandidate(node, now, recoveryIntervalMs);
      }).sort((a, b) => {
        const aTime = a.lastRecoveryTestAt ? Date.parse(a.lastRecoveryTestAt) : 0;
        const bTime = b.lastRecoveryTestAt ? Date.parse(b.lastRecoveryTestAt) : 0;
        return aTime - bTime;
      }).slice(0, this.recoveryBatchSize);
      if (candidates.length === 0) return { tested: 0, recovered: 0 };

      const queue = [...candidates];
      let tested = 0;
      let recovered = 0;
      const worker = async (): Promise<void> => {
        while (queue.length > 0) {
          const node = queue.shift();
          if (!node) return;
          const candidateNow = Date.now();
          if (this.recoveryTestsInFlight.has(node.id) || !this.isRecoveryCandidate(node, candidateNow, recoveryIntervalMs)) continue;

          this.recoveryTestsInFlight.add(node.id);
          const recoveryTestAt = new Date().toISOString();
          node.lastRecoveryTestAt = recoveryTestAt;
          this.persistState(node.id);
          tested += 1;
          const wasAutoDisabled = node.autoDisabledBy429 && !node.enabled;
          const expectedState: RecoveryProbeState = {
            enabled: node.enabled,
            autoDisabledBy429: node.autoDisabledBy429,
            currentConcurrency: node.currentConcurrency,
            lastError: node.lastError,
            lastCheckedAt: node.lastCheckedAt,
            lastRecoveryTestAt: recoveryTestAt,
            endpoint: this.proxyEndpoint(node),
          };
          try {
            const statusCode = await this.requestModelHealthCheck(node, options);
            if (!this.recoveryStateUnchanged(node, expectedState)) continue;
            if (statusCode >= 200 && statusCode < 300) {
              if (wasAutoDisabled) {
                node.enabled = true;
                node.autoDisabledBy429 = false;
                node.consecutiveRateLimitCount = 0;
              }
              node.cooldownUntil = null;
              node.lastRecoveryTestAt = null;
              node.lastError = null;
              recovered += 1;
            } else {
              node.lastError = `Model health check returned HTTP ${statusCode}`;
              if (!wasAutoDisabled) node.cooldownUntil = new Date(Date.now() + DEFAULT_PROXY_COOLDOWN_MS).toISOString();
            }
            node.lastCheckedAt = new Date().toISOString();
            this.recordResult(node, statusCode >= 200 && statusCode < 300, statusCode);
          } catch (error) {
            if (this.recoveryStateUnchanged(node, expectedState)) {
              node.lastError = error instanceof Error ? error.message : "Model health check failed";
              if (!wasAutoDisabled) node.cooldownUntil = new Date(Date.now() + DEFAULT_PROXY_COOLDOWN_MS).toISOString();
              node.lastCheckedAt = new Date().toISOString();
              this.recordResult(node, false, this.statusCodeFromHealthCheckError(error));
            }
          } finally {
            this.recoveryTestsInFlight.delete(node.id);
            this.persistState(node.id);
          }
        }
      };

      const workerCount = Math.min(this.recoveryConcurrency, candidates.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      return { tested, recovered };
    } finally {
      this.recoveryRunInFlight = false;
    }
  }

  private buildNode(input: ProxyInput): ProxyNode {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      name: input.name?.trim() || "未命名代理",
      type: input.type || "http",
      url: input.url?.trim() || "",
      enabled: input.enabled ?? true,
      weight: Math.max(1, Math.trunc(input.weight || 1)),
      maxConcurrency: Math.max(1, Math.trunc(input.maxConcurrency || 10)),
      currentConcurrency: 0,
      dailyRequestLimit: Math.max(0, Math.trunc(input.dailyRequestLimit || 0)),
      dailyRequestCount: 0,
      dailyCountDate: today(),
      autoDisableWhenDailyLimitReached: input.autoDisableWhenDailyLimitReached ?? false,
      consecutiveRateLimitCount: 0,
      autoDisabledBy429: false,
      lastRecoveryTestAt: null,
      cooldownUntil: null,
      successCount: 0,
      failCount: 0,
      totalTokens: 0,
      dailyTokens: 0,
      dailyTokensDate: today(),
      recentResults: [],
      lastError: null,
      lastUsedAt: null,
      lastCheckedAt: now,
    };
  }

  private createAgent(node: ProxyNode): https.Agent {
    const settings = this.settingsStore.get();
    const preProxyUrl = settings.outboundPreProxyEnabled ? settings.outboundPreProxyUrl : "";
    if (preProxyUrl && node.type === "socks5") return new HttpPreProxyToSocksAgent(preProxyUrl, node.url);
    if (preProxyUrl && ["http", "https"].includes(node.type)) return new HttpPreProxyToHttpAgent(preProxyUrl, node.url);
    return node.type === "socks5" ? new SocksProxyAgent(node.url) as unknown as https.Agent : new HttpsProxyAgent(node.url) as unknown as https.Agent;
  }

  private validateNode(node: ProxyNode): void {
    if (!node.name.trim()) throw new Error("Proxy name is required");
    if (!node.url.trim()) throw new Error("Proxy url is required");
    if (!['http', 'https', 'socks5'].includes(node.type)) throw new Error("Unsupported proxy type");
    const parsed = new URL(node.url);
    if (node.type === "socks5" && !parsed.protocol.startsWith("socks")) throw new Error("SOCKS5 proxy url must use socks:// or socks5://");
    if (node.type !== "socks5" && !["http:", "https:"].includes(parsed.protocol)) throw new Error("HTTP proxy url must use http:// or https://");
  }

  private resetDailyIfNeeded(): void {
    const current = today();
    for (const node of this.proxies) {
      if (node.dailyCountDate !== current) {
        node.dailyCountDate = current;
        node.dailyRequestCount = 0;
        if (node.autoDisableWhenDailyLimitReached && node.lastError === "Daily request limit reached") {
          node.enabled = true;
          node.lastError = null;
        }
        this.persistState(node.id);
      }
      if (node.dailyTokensDate !== current) {
        node.dailyTokensDate = current;
        node.dailyTokens = 0;
        this.persistState(node.id);
      }
    }
  }

  private normalizeDaily(node: ProxyNode): ProxyNode {
    const current = today();
    const dailyCountDate = node.dailyCountDate || current;
    const dailyTokensDate = node.dailyTokensDate || current;
    const recentResults = Array.isArray(node.recentResults) ? node.recentResults : [];
    return {
      ...node,
      name: typeof node.name === "string" && node.name.trim() ? node.name : "未命名代理",
      type: node.type || "http",
      url: typeof node.url === "string" ? node.url : "",
      enabled: node.enabled !== false,
      weight: Number.isFinite(node.weight) ? Math.max(1, Math.trunc(node.weight)) : 1,
      maxConcurrency: Number.isFinite(node.maxConcurrency) ? Math.max(1, Math.trunc(node.maxConcurrency)) : 10,
      currentConcurrency: 0,
      dailyCountDate: current,
      dailyRequestLimit: Number.isFinite(node.dailyRequestLimit) ? Math.max(0, Math.trunc(node.dailyRequestLimit)) : 0,
      dailyRequestCount: dailyCountDate === current && Number.isFinite(node.dailyRequestCount) ? Math.max(0, Math.trunc(node.dailyRequestCount)) : 0,
      autoDisableWhenDailyLimitReached: Boolean(node.autoDisableWhenDailyLimitReached),
      consecutiveRateLimitCount: Number.isFinite(node.consecutiveRateLimitCount) ? Math.max(0, Math.trunc(node.consecutiveRateLimitCount)) : 0,
      autoDisabledBy429: Boolean(node.autoDisabledBy429 || (!node.enabled && node.lastError === "Disabled after 5 consecutive 429 responses")),
      lastRecoveryTestAt: node.lastRecoveryTestAt || null,
      cooldownUntil: node.cooldownUntil || null,
      successCount: Number.isFinite(node.successCount) ? Math.max(0, Math.trunc(node.successCount)) : 0,
      failCount: Number.isFinite(node.failCount) ? Math.max(0, Math.trunc(node.failCount)) : 0,
      totalTokens: Number.isFinite(node.totalTokens) ? Math.max(0, Math.trunc(node.totalTokens)) : 0,
      dailyTokens: dailyTokensDate === current && Number.isFinite(node.dailyTokens) ? Math.max(0, Math.trunc(node.dailyTokens)) : 0,
      dailyTokensDate: current,
      recentResults,
      lastError: node.lastError || null,
      lastUsedAt: node.lastUsedAt || null,
      lastCheckedAt: node.lastCheckedAt || null,
    };
  }

  private recordResult(node: ProxyNode, ok: boolean, statusCode: number): void {
    node.recentResults = [...(node.recentResults || []), { at: new Date().toISOString(), ok, statusCode }].slice(-20);
  }

  private disableIfDailyLimitReached(node: ProxyNode): void {
    if (node.dailyRequestLimit === 0 || node.dailyRequestCount < node.dailyRequestLimit) return;
    if (!node.autoDisableWhenDailyLimitReached) return;
    node.enabled = false;
    node.autoDisabledBy429 = false;
    node.lastRecoveryTestAt = null;
    node.lastError = "Daily request limit reached";
  }

  private isRecoveryCandidate(node: ProxyNode, now: number, recoveryIntervalMs: number): boolean {
    if (node.currentConcurrency > 0) return false;
    const autoDisabledBy429 = !node.enabled && node.autoDisabledBy429;
    const cooldownUntil = node.cooldownUntil ? Date.parse(node.cooldownUntil) : Number.NaN;
    const cooldownExpired = !node.cooldownUntil || !Number.isFinite(cooldownUntil) || cooldownUntil <= now;
    const abnormal = node.enabled && !node.autoDisabledBy429 && Boolean(node.lastError) && cooldownExpired;
    if (!autoDisabledBy429 && !abnormal) return false;
    if (!node.lastRecoveryTestAt) return true;
    const lastTestAt = Date.parse(node.lastRecoveryTestAt);
    return !Number.isFinite(lastTestAt) || now - lastTestAt >= recoveryIntervalMs;
  }

  private recoveryStateUnchanged(node: ProxyNode, expected: RecoveryProbeState): boolean {
    return node.enabled === expected.enabled
      && node.autoDisabledBy429 === expected.autoDisabledBy429
      && node.currentConcurrency === expected.currentConcurrency
      && node.lastError === expected.lastError
      && node.lastCheckedAt === expected.lastCheckedAt
      && node.lastRecoveryTestAt === expected.lastRecoveryTestAt
      && this.proxyEndpoint(node) === expected.endpoint;
  }

  private proxyEndpoint(node: ProxyNode): string {
    return `${node.type}\n${node.url}`;
  }

  private requestModelHealthCheck(node: ProxyNode, options: ProxyModelTestOptions): Promise<number> {
    const protocol = options.protocol === "responses" ? "responses" : options.protocol === "systemone" ? "systemone" : "chat_completions";
    // The upstream gate requires `stream: true` plus the `read`/`bash` tool
    // declarations, so the health check has to look like a real request.
    const tools = [
      { type: "function", name: "read", description: "Placeholder", parameters: { type: "object", properties: {} } },
      { type: "function", name: "bash", description: "Placeholder", parameters: { type: "object", properties: {} } },
    ];
    const body = JSON.stringify(protocol === "systemone"
      // System One never streams: a plain non-streamed state/questions body that
      // expects a JSON document with an `answers` map back.
      ? {
        model: options.model,
        state: "ping",
        questions: { ok: { type: "choice", instructions: "Reply with exactly: OK", criteria: { ok: "The answer is OK" } } },
      }
      : protocol === "responses"
        ? { model: options.model, input: "ping", stream: true, max_output_tokens: 16, tools }
        : {
          model: options.model,
          messages: [{ role: "user", content: "ping" }],
          stream: true,
          max_tokens: 1,
          tools: tools.map(({ type, name, description, parameters }) => ({ type, function: { name, description, parameters } })),
        });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const req = https.request({
        hostname: options.hostname,
        port: 443,
        path: options.path,
        method: "POST",
        headers: {
          "Accept-Encoding": "identity",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: "Bearer public",
          "User-Agent": "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13",
          "x-opencode-client": "cli",
          "x-opencode-project": "global",
          "x-opencode-request": ocId("proxy-health"),
          "x-opencode-session": ocId("ses"),
        },
        agent: this.createAgent(node),
        timeout: options.timeoutMs,
      }, (res) => {
        const statusCode = res.statusCode || 502;
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        res.on("data", (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > 64 * 1024) {
            res.destroy(new Error("Model health check response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.once("end", () => finish(() => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (statusCode >= 200 && statusCode < 300) {
            try {
              // The health check streams, so the body is SSE. Only the JSON
              // payloads matter here; error events carry the upstream error.
              const payloads: Record<string, unknown>[] = [];
              const trimmed = raw.trim();
              if (trimmed.startsWith("{")) {
                payloads.push(JSON.parse(trimmed) as Record<string, unknown>);
              } else {
                for (const line of trimmed.split(/\r?\n/)) {
                  if (!line.startsWith("data:")) continue;
                  const payload = line.slice(5).trim();
                  if (!payload || payload === "[DONE]") continue;
                  try {
                    payloads.push(JSON.parse(payload) as Record<string, unknown>);
                  } catch {
                    // A malformed chunk does not invalidate the whole stream.
                  }
                }
              }
              const errorPayload = payloads.find((entry) => entry.error || entry.type === "error");
              if (errorPayload || raw.includes("FreeUsageLimitError") || raw.includes("rate_limit_error")) {
                const errorValue = errorPayload?.error;
                const message = typeof errorValue === "string" ? errorValue : (errorValue as { message?: string } | undefined)?.message;
                const error = new Error(`Model health check returned an upstream error${message ? `: ${message}` : ""}`) as Error & { statusCode?: number };
                error.statusCode = statusCode;
                reject(error);
                return;
              }
              const validResponse = protocol === "systemone"
                // System One never streams: one JSON document with an `answers` map.
                ? payloads.some((entry) => entry.answers !== undefined && typeof entry.answers === "object")
                : protocol === "responses"
                  ? payloads.some((entry) => {
                    const response = entry.response as { object?: string; output?: unknown[] } | undefined;
                    return entry.object === "response" || Array.isArray(entry.output) || response?.object === "response" || Array.isArray(response?.output);
                  })
                  // The first chunk of any chat stream carries the choices array.
                  : payloads.some((entry) => Array.isArray(entry.choices));
              if (!validResponse) {
                const error = new Error(protocol === "systemone" ? "Model health check returned no System One answers" : protocol === "responses" ? "Model health check returned no response output" : "Model health check returned no choices") as Error & { statusCode?: number };
                error.statusCode = statusCode;
                reject(error);
                return;
              }
            } catch {
              const error = new Error("Model health check returned invalid JSON") as Error & { statusCode?: number };
              error.statusCode = statusCode;
              reject(error);
              return;
            }
          }
          resolve(statusCode);
        }));
        res.once("error", (error) => finish(() => reject(error)));
      });
      req.once("error", (error) => finish(() => reject(error)));
      req.once("timeout", () => {
        req.destroy();
        finish(() => reject(new Error("Proxy model health check timeout")));
      });
      req.write(body);
      req.end();
    });
  }

  private statusCodeFromHealthCheckError(error: unknown): number {
    const statusCode = (error as { statusCode?: unknown })?.statusCode;
    if (typeof statusCode === "number" && Number.isInteger(statusCode)) return statusCode;
    const message = error instanceof Error ? error.message : "";
    const match = message.match(/HTTP (\d{3})/);
    return match ? Number(match[1]) : 502;
  }

  private find(id: string): ProxyNode | undefined {
    return this.proxiesById.get(id);
  }

  private takeLease(id: string, leaseId?: string): boolean {
    const node = this.find(id);
    if (!node) return false;
    if (leaseId !== undefined) {
      if (this.activeLeases.get(leaseId) !== id) return false;
      this.activeLeases.delete(leaseId);
    } else {
      const legacyLease = [...this.activeLeases.entries()].find(([, nodeId]) => nodeId === id);
      if (!legacyLease) return false;
      this.activeLeases.delete(legacyLease[0]);
    }
    node.currentConcurrency = Math.max(0, node.currentConcurrency - 1);
    return true;
  }

  /** Flush pending config/state writes before shutdown or an administrative export. */
  async flush(): Promise<void> {
    if (this.configPersistTimer) {
      clearTimeout(this.configPersistTimer);
      this.configPersistTimer = undefined;
    }
    if (this.statePersistTimer) {
      clearTimeout(this.statePersistTimer);
      this.statePersistTimer = undefined;
    }
    do {
      await Promise.all([this.flushConfig(), this.flushState()]);
    } while (this.configDirty || this.stateDirty || this.configFlushPromise || this.stateFlushPromise);
  }

  private persistConfig(): void {
    this.configDirty = true;
    this.scheduleConfigPersist();
  }

  private persistState(id?: string, deleted = false): void {
    this.stateDirty = true;
    if (id) {
      this.dirtyStateIds.add(id);
      if (deleted) this.deletedStateIds.add(id);
      else this.deletedStateIds.delete(id);
    }
    this.scheduleStatePersist();
  }

  private scheduleConfigPersist(): void {
    if (this.configPersistTimer || this.configFlushPromise) return;
    this.configPersistTimer = setTimeout(() => {
      this.configPersistTimer = undefined;
      void this.flushConfig().catch((error) => this.reportPersistenceError("config", error));
    }, this.persistDebounceMs);
    this.configPersistTimer.unref();
  }

  private scheduleStatePersist(): void {
    if (this.statePersistTimer || this.stateFlushPromise) return;
    this.statePersistTimer = setTimeout(() => {
      this.statePersistTimer = undefined;
      void this.flushState().catch((error) => this.reportPersistenceError("state", error));
    }, this.persistDebounceMs);
    this.statePersistTimer.unref();
  }

  private flushConfig(): Promise<void> {
    if (this.configFlushPromise) return this.configFlushPromise;
    if (!this.configDirty) return Promise.resolve();
    this.configDirty = false;
    const snapshot: ProxyFile = {
      version: 2,
      proxies: this.proxies.map((node): ProxyStaticNode => ({
        id: node.id,
        name: node.name,
        type: node.type,
        url: node.url,
        enabled: node.enabled,
        weight: node.weight,
        maxConcurrency: node.maxConcurrency,
        dailyRequestLimit: node.dailyRequestLimit,
        autoDisableWhenDailyLimitReached: node.autoDisableWhenDailyLimitReached,
      })),
    };
    this.configFlushPromise = this.enqueueWrite(() => this.store.writeAsync(snapshot)).catch((error) => {
      this.configDirty = true;
      throw error;
    }).finally(() => {
      this.configFlushPromise = undefined;
      if (this.configDirty) this.scheduleConfigPersist();
    });
    return this.configFlushPromise;
  }

  private flushState(): Promise<void> {
    if (this.stateFlushPromise) return this.stateFlushPromise;
    if (!this.stateDirty) return Promise.resolve();

    this.stateDirty = false;
    const ids = [...this.dirtyStateIds];
    const entries: ProxyStateJournalEntry[] = [];
    for (const id of ids) {
      if (this.deletedStateIds.has(id) || !this.proxiesById.has(id)) {
        entries.push({ id, deleted: true });
        continue;
      }
      const node = this.proxiesById.get(id);
      if (node) entries.push({ id, state: this.stateForNode(node) });
    }
    this.dirtyStateIds.clear();
    this.deletedStateIds.clear();

    this.stateFlushPromise = this.enqueueWrite(async () => {
      await this.stateJournal.appendMany(entries);
      if (await this.stateJournal.size() >= 8 * 1024 * 1024) {
        // Compact only after the incremental journal is durable. The snapshot
        // contains any state changes that arrived while the append was pending;
        // those changes remain dirty and will be journaled again if necessary.
        await this.stateStore.writeAsync(this.stateSnapshot());
        await this.stateJournal.truncate();
      }
    }).catch((error) => {
      this.stateDirty = true;
      for (const entry of entries) {
        if (this.dirtyStateIds.has(entry.id)) continue;
        this.dirtyStateIds.add(entry.id);
        if (entry.deleted) this.deletedStateIds.add(entry.id);
      }
      throw error;
    }).finally(() => {
      this.stateFlushPromise = undefined;
      if (this.stateDirty) this.scheduleStatePersist();
    });
    return this.stateFlushPromise;
  }

  private stateForNode(node: ProxyNode): ProxyState {
    return {
      enabled: node.enabled,
      dailyRequestCount: node.dailyRequestCount,
      dailyCountDate: node.dailyCountDate,
      consecutiveRateLimitCount: node.consecutiveRateLimitCount,
      autoDisabledBy429: node.autoDisabledBy429,
      lastRecoveryTestAt: node.lastRecoveryTestAt,
      cooldownUntil: node.cooldownUntil,
      successCount: node.successCount,
      failCount: node.failCount,
      totalTokens: node.totalTokens,
      dailyTokens: node.dailyTokens,
      dailyTokensDate: node.dailyTokensDate,
      recentResults: node.recentResults,
      lastError: node.lastError,
      lastUsedAt: node.lastUsedAt,
      lastCheckedAt: node.lastCheckedAt,
    };
  }

  private stateSnapshot(): ProxyStateFile {
    const states: Record<string, ProxyState> = {};
    for (const node of this.proxies) states[node.id] = this.stateForNode(node);
    return { version: 1, states };
  }

  private enqueueWrite(writer: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(writer, writer);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private reportPersistenceError(kind: "config" | "state", error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[proxy-pool] ${kind} persistence failed: ${message}`);
  }
}
