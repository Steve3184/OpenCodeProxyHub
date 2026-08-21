import "dotenv/config";

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const boolFromEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

const proxyModeFromEnv = (): "direct" | "optional" | "required" => {
  const raw = process.env.PROXY_MODE?.toLowerCase();
  if (raw === "direct" || raw === "optional" || raw === "required") return raw;
  return boolFromEnv("REQUIRE_PROXY", false) ? "required" : "optional";
};

export interface AppConfig {
  host: string;
  port: number;
  keysFile: string;
  modelsFile: string;
  modelAliasesFile: string;
  settingsFile: string;
  proxiesFile: string;
  logsDir: string;
  adminPassword: string;
  zenHost: string;
  zenPath: string;
  upstreamTimeoutMs: number;
  globalRequestsPerMinute: number;
  apiKeyRequestsPerMinute: number;
  apiKeyMaxConcurrentRequests: number;
  apiKeyMaxConcurrentStreams: number;
  redisUrl: string;
  redisKeyPrefix: string;
  shutdownDrainTimeoutMs: number;
  storePlaintextApiKeys: boolean;
  proxyMode: "direct" | "optional" | "required";
  outboundPreProxyEnabled: boolean;
  outboundPreProxyUrl: string;
  proxyHealthCheckModel: string;
  proxyHealthCheckTimeoutMs: number;
  proxyRecoveryIntervalMs: number;
}

export const loadConfig = (): AppConfig => ({
  host: process.env.PROXY_HOST || "0.0.0.0",
  port: intFromEnv("PROXY_PORT", 6446),
  keysFile: process.env.KEYS_FILE || "./api-keys.json",
  modelsFile: process.env.MODELS_FILE || "./models.json",
  modelAliasesFile: process.env.MODEL_ALIASES_FILE || "./model-aliases.json",
  settingsFile: process.env.SETTINGS_FILE || "./settings.json",
  proxiesFile: process.env.PROXIES_FILE || "./proxies.json",
  logsDir: process.env.LOGS_DIR || "./logs",
  adminPassword: process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || "admin",
  zenHost: process.env.ZEN_HOST || "opencode.ai",
  zenPath: process.env.ZEN_PATH || "/zen/v1/chat/completions",
  upstreamTimeoutMs: intFromEnv("UPSTREAM_TIMEOUT_MS", 120000),
  globalRequestsPerMinute: intFromEnv("GLOBAL_REQUESTS_PER_MINUTE", 120),
  apiKeyRequestsPerMinute: intFromEnv("API_KEY_REQUESTS_PER_MINUTE", 60),
  apiKeyMaxConcurrentRequests: intFromEnv("API_KEY_MAX_CONCURRENT_REQUESTS", 10),
  apiKeyMaxConcurrentStreams: intFromEnv("API_KEY_MAX_CONCURRENT_STREAMS", 5),
  redisUrl: process.env.REDIS_URL || "",
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX || "opencode-proxy-hub:limit",
  shutdownDrainTimeoutMs: intFromEnv("SHUTDOWN_DRAIN_TIMEOUT_MS", 30000),
  storePlaintextApiKeys: boolFromEnv("STORE_PLAINTEXT_API_KEYS", false),
  proxyMode: proxyModeFromEnv(),
  outboundPreProxyEnabled: boolFromEnv("OUTBOUND_PRE_PROXY_ENABLED", false),
  outboundPreProxyUrl: process.env.OUTBOUND_PRE_PROXY_URL || "",
  proxyHealthCheckModel: process.env.PROXY_HEALTH_CHECK_MODEL?.trim() || "big-pickle",
  proxyHealthCheckTimeoutMs: Math.max(1000, intFromEnv("PROXY_HEALTH_CHECK_TIMEOUT_MS", 10000)),
  proxyRecoveryIntervalMs: Math.max(1000, intFromEnv("PROXY_RECOVERY_INTERVAL_MS", 10 * 60 * 1000)),
});
