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
  version: 1;
  proxies: ProxyNode[];
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
  agent?: https.Agent;
  requiredUnavailable?: boolean;
}

export interface ProxyModelTestOptions {
  hostname: string;
  path: string;
  model: string;
  timeoutMs: number;
  recoveryIntervalMs?: number;
}

export interface ProxyRecoverySummary {
  tested: number;
  recovered: number;
}

const DEFAULT_MODEL_TEST_OPTIONS: ProxyModelTestOptions = {
  hostname: "opencode.ai",
  path: "/zen/v1/chat/completions",
  model: "deepseek-v4-flash-free",
  timeoutMs: 10000,
};

const today = () => new Date().toISOString().slice(0, 10);

export class ProxyPoolStore {
  private readonly store: JsonFileStore<ProxyFile>;
  private proxies: ProxyNode[] = [];
  private readonly recoveryTestsInFlight = new Set<string>();

  constructor(proxiesFile: string, private readonly settingsStore: SettingsStore) {
    this.store = new JsonFileStore<ProxyFile>(proxiesFile);
  }

  load(): void {
    const data = this.store.read({ version: 1, proxies: [] });
    this.proxies = data.proxies.map((node) => this.normalizeDaily(node));
    this.persist();
  }

  list(): ProxyNode[] {
    this.resetDailyIfNeeded();
    return this.proxies.map((proxy) => ({ ...proxy }));
  }

  create(input: ProxyInput): ProxyNode {
    const node = this.buildNode(input);
    this.validateNode(node);
    this.proxies.push(node);
    this.persist();
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
    this.persist();
    return { ...node };
  }

  delete(id: string): boolean {
    const before = this.proxies.length;
    this.proxies = this.proxies.filter((node) => node.id !== id);
    if (this.proxies.length === before) return false;
    this.persist();
    return true;
  }

  acquire(excludeProxyIds: ReadonlySet<string> = new Set()): ProxyLease {
    this.resetDailyIfNeeded();
    const now = Date.now();
    const candidates = this.proxies
      .filter((node) => node.enabled)
      .filter((node) => !excludeProxyIds.has(node.id))
      .filter((node) => !node.cooldownUntil || Date.parse(node.cooldownUntil) <= now)
      .filter((node) => node.dailyRequestLimit === 0 || node.dailyRequestCount < node.dailyRequestLimit)
      .filter((node) => node.currentConcurrency < node.maxConcurrency)
      .sort((a, b) => b.weight - a.weight);

    const node = candidates[0];
    if (!node) return { node: null, requiredUnavailable: this.settingsStore.get().proxyMode === "required" };

    node.currentConcurrency += 1;
    node.dailyRequestCount += 1;
    node.lastUsedAt = new Date().toISOString();
    this.disableIfDailyLimitReached(node);
    this.persist();

    return { node: { ...node }, agent: this.createAgent(node) };
  }

  release(id: string): void {
    const node = this.find(id);
    if (!node) return;
    node.currentConcurrency = Math.max(0, node.currentConcurrency - 1);
    this.persist();
  }

  markSuccess(id: string): void {
    const node = this.find(id);
    if (!node) return;
    node.successCount += 1;
    if (!node.autoDisabledBy429) node.consecutiveRateLimitCount = 0;
    this.recordResult(node, true, 200);
    if (!node.autoDisabledBy429) node.lastError = null;
    node.lastCheckedAt = new Date().toISOString();
    this.release(id);
  }

  markFailure(id: string, error: string, options: { statusCode?: number; cooldownMs?: number } = {}): void {
    const node = this.find(id);
    if (!node) return;
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
        node.cooldownUntil = new Date(Date.now() + (options.cooldownMs ?? 5 * 60 * 1000)).toISOString();
      }
    }
    this.release(id);
  }

  recordTokenUsage(id: string, totalTokens: number): void {
    const node = this.find(id);
    if (!node || !Number.isFinite(totalTokens) || totalTokens <= 0) return;
    this.resetDailyIfNeeded();
    const tokens = Math.max(0, Math.trunc(totalTokens));
    if (tokens === 0) return;
    node.totalTokens += tokens;
    node.dailyTokens += tokens;
    this.persist();
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
    this.persist();
    return { ...node };
  }

  async test(id: string, options: ProxyModelTestOptions = DEFAULT_MODEL_TEST_OPTIONS): Promise<ProxyNode> {
    const node = this.find(id);
    if (!node) throw new Error("Proxy not found");
    this.validateNode(node);

    const checkedAt = new Date().toISOString();
    try {
      const statusCode = await this.requestModelHealthCheck(node, options);
      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`Model health check returned HTTP ${statusCode}`);
      }
      node.lastCheckedAt = checkedAt;
      if (node.autoDisabledBy429 && !node.enabled) node.lastRecoveryTestAt = checkedAt;
      node.lastError = null;
      this.recordResult(node, true, statusCode);
      this.persist();
      return { ...node };
    } catch (error) {
      node.lastCheckedAt = checkedAt;
      if (node.autoDisabledBy429 && !node.enabled) node.lastRecoveryTestAt = checkedAt;
      node.lastError = error instanceof Error ? error.message : "Model health check failed";
      this.recordResult(node, false, this.statusCodeFromHealthCheckError(error));
      this.persist();
      throw error;
    }
  }

  async recoverRateLimitedProxies(options: ProxyModelTestOptions): Promise<ProxyRecoverySummary> {
    const now = Date.now();
    const candidates = this.proxies.filter((node) => {
      if (node.enabled || !node.autoDisabledBy429 || this.recoveryTestsInFlight.has(node.id)) return false;
      if (!node.lastRecoveryTestAt) return true;
      const lastTestAt = Date.parse(node.lastRecoveryTestAt);
      return !Number.isFinite(lastTestAt) || now - lastTestAt >= (options.recoveryIntervalMs ?? 10 * 60 * 1000);
    });
    if (candidates.length === 0) return { tested: 0, recovered: 0 };

    const queue = [...candidates];
    let tested = 0;
    let recovered = 0;
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const node = queue.shift();
        if (!node) return;
        if (node.enabled || !node.autoDisabledBy429 || this.recoveryTestsInFlight.has(node.id)) continue;

        this.recoveryTestsInFlight.add(node.id);
        node.lastRecoveryTestAt = new Date().toISOString();
        this.persist();
        tested += 1;
        const wasAutoDisabled = node.autoDisabledBy429 && !node.enabled;
        try {
          const statusCode = await this.requestModelHealthCheck(node, options);
          // Do not overwrite a manual enable/disable that happened while the probe was in flight.
          if (wasAutoDisabled && node.autoDisabledBy429 && !node.enabled && statusCode >= 200 && statusCode < 300) {
            node.enabled = true;
            node.autoDisabledBy429 = false;
            node.consecutiveRateLimitCount = 0;
            node.cooldownUntil = null;
            node.lastError = null;
            recovered += 1;
          } else if (wasAutoDisabled && node.autoDisabledBy429 && !node.enabled) {
            node.lastError = `Model health check returned HTTP ${statusCode}`;
          }
          node.lastCheckedAt = new Date().toISOString();
          this.recordResult(node, statusCode >= 200 && statusCode < 300, statusCode);
        } catch (error) {
          if (wasAutoDisabled && node.autoDisabledBy429 && !node.enabled) {
            node.lastError = error instanceof Error ? error.message : "Model health check failed";
            node.lastCheckedAt = new Date().toISOString();
            this.recordResult(node, false, this.statusCodeFromHealthCheckError(error));
          }
        } finally {
          this.recoveryTestsInFlight.delete(node.id);
          this.persist();
        }
      }
    };

    const workerCount = Math.min(4, candidates.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { tested, recovered };
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
    let changed = false;
    for (const node of this.proxies) {
      if (node.dailyCountDate !== current) {
        node.dailyCountDate = current;
        node.dailyRequestCount = 0;
        if (node.autoDisableWhenDailyLimitReached && node.lastError === "Daily request limit reached") {
          node.enabled = true;
          node.lastError = null;
        }
        changed = true;
      }
      if (node.dailyTokensDate !== current) {
        node.dailyTokensDate = current;
        node.dailyTokens = 0;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private normalizeDaily(node: ProxyNode): ProxyNode {
    const current = today();
    const dailyTokensDate = node.dailyTokensDate || current;
    return {
      ...node,
      currentConcurrency: 0,
      dailyCountDate: node.dailyCountDate || today(),
      dailyRequestLimit: node.dailyRequestLimit || 0,
      dailyRequestCount: node.dailyRequestCount || 0,
      autoDisableWhenDailyLimitReached: Boolean(node.autoDisableWhenDailyLimitReached),
      consecutiveRateLimitCount: node.consecutiveRateLimitCount || 0,
      autoDisabledBy429: Boolean(node.autoDisabledBy429 || (!node.enabled && node.lastError === "Disabled after 5 consecutive 429 responses")),
      lastRecoveryTestAt: node.lastRecoveryTestAt || null,
      totalTokens: Number.isFinite(node.totalTokens) ? Math.max(0, Math.trunc(node.totalTokens)) : 0,
      dailyTokens: dailyTokensDate === current && Number.isFinite(node.dailyTokens) ? Math.max(0, Math.trunc(node.dailyTokens)) : 0,
      dailyTokensDate: current,
      recentResults: node.recentResults || [],
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

  private requestModelHealthCheck(node: ProxyNode, options: ProxyModelTestOptions): Promise<number> {
    const body = JSON.stringify({
      model: options.model,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_tokens: 1,
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
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: "Bearer public",
          "User-Agent": "opencode/1.15.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13",
          "x-opencode-client": "cli",
          "x-opencode-project": "global",
          "x-opencode-request": ocId("proxy-health"),
          "x-opencode-session": `proxy-health-check-${node.id}`,
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
              const parsed = JSON.parse(raw) as { choices?: unknown[]; error?: { message?: string } | string; type?: string };
              if (parsed.error || parsed.type === "error" || raw.includes("FreeUsageLimitError") || raw.includes("rate_limit_error")) {
                const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
                const error = new Error(`Model health check returned an upstream error${message ? `: ${message}` : ""}`) as Error & { statusCode?: number };
                error.statusCode = statusCode;
                reject(error);
                return;
              }
              if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) {
                const error = new Error("Model health check returned no choices") as Error & { statusCode?: number };
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
    return this.proxies.find((node) => node.id === id);
  }

  private persist(): void {
    this.store.write({ version: 1, proxies: this.proxies });
  }
}
