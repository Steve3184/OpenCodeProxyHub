import cors from "@fastify/cors";
import Fastify from "fastify";
import type { AppConfig } from "./config/env.js";
import { ApiKeyStore } from "./auth/apiKeys.js";
import { AdminSessionStore } from "./auth/adminSessions.js";
import { SessionStore } from "./sessions/sessionStore.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerOpenAIRoutes } from "./routes/openai.js";
import { registerAnthropicRoutes } from "./routes/anthropic.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerWebRoutes } from "./routes/web.js";
import { ModelConfigStore } from "./models/catalog.js";
import { ModelAliasStore } from "./models/aliases.js";
import { SettingsStore } from "./settings/settingsStore.js";
import { ProxyPoolStore } from "./proxy/proxyPool.js";
import { createLimiter } from "./rateLimit/limiter.js";
import { RequestTracker } from "./runtime/requestTracker.js";
import { MetricsStore, registerMetricsHooks } from "./observability/metrics.js";
import { EventLogger } from "./observability/eventLogger.js";

export const buildApp = async (config: AppConfig) => {
  const settingsStore = new SettingsStore(config.settingsFile, {
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    proxyMode: config.proxyMode,
    outboundPreProxyEnabled: config.outboundPreProxyEnabled,
    outboundPreProxyUrl: config.outboundPreProxyUrl,
    globalRequestsPerMinute: config.globalRequestsPerMinute,
    apiKeyRequestsPerMinute: config.apiKeyRequestsPerMinute,
    apiKeyMaxConcurrentRequests: config.apiKeyMaxConcurrentRequests,
    apiKeyMaxConcurrentStreams: config.apiKeyMaxConcurrentStreams,
  });
  settingsStore.load();
  const settings = settingsStore.get();

  const app = Fastify({ logger: true, bodyLimit: settings.requestBodyLimitBytes });
  const metrics = new MetricsStore();
  const eventLogger = new EventLogger(settingsStore, config.logsDir);
  registerMetricsHooks(app, metrics);
  await app.register(cors, {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
  });

  const keyStore = new ApiKeyStore(config.keysFile, config.storePlaintextApiKeys);
  keyStore.load();
  const modelStore = new ModelConfigStore(config.modelsFile);
  modelStore.load();
  const modelAliasStore = new ModelAliasStore(config.modelAliasesFile);
  modelAliasStore.load();
  const proxyHealthCheckModel = () => modelStore.isEnabled(config.proxyHealthCheckModel)
    ? config.proxyHealthCheckModel
    : modelStore.enabledIds()[0] || config.proxyHealthCheckModel;
  const proxyPool = new ProxyPoolStore(config.proxiesFile, settingsStore);
  proxyPool.load();
  const proxyRecoveryTimer = setInterval(() => {
    void proxyPool.recoverRateLimitedProxies({
      hostname: config.zenHost,
      path: config.zenPath,
      model: proxyHealthCheckModel(),
      timeoutMs: config.proxyHealthCheckTimeoutMs,
      recoveryIntervalMs: config.proxyRecoveryIntervalMs,
    }).then((summary) => {
      if (summary.tested > 0) app.log.info(summary, "proxy_recovery_check_completed");
    }).catch((error) => {
      app.log.warn({ error }, "proxy_recovery_check_failed");
    });
  }, config.proxyRecoveryIntervalMs);
  proxyRecoveryTimer.unref();
  const sessions = new SessionStore();
  const adminSessions = new AdminSessionStore();
  const requestTracker = new RequestTracker();
  const limiter = await createLimiter({
    globalRequestsPerMinute: settings.globalRequestsPerMinute,
    apiKeyRequestsPerMinute: settings.apiKeyRequestsPerMinute,
    apiKeyMaxConcurrentRequests: settings.apiKeyMaxConcurrentRequests,
    apiKeyMaxConcurrentStreams: settings.apiKeyMaxConcurrentStreams,
  }, config.redisUrl, config.redisKeyPrefix);
  app.log.info({ limiter: await limiter.snapshot() }, "limiter_ready");
  app.addHook("onClose", async () => {
    clearInterval(proxyRecoveryTimer);
    const drained = await requestTracker.drain(config.shutdownDrainTimeoutMs);
    if (!drained) app.log.warn({ runtime: requestTracker.snapshot() }, "shutdown_drain_timeout");
    await limiter.close();
  });

  await registerHealthRoutes(app, modelStore);
  await registerModelRoutes(app, modelStore, modelAliasStore);
  await registerAdminRoutes(app, config, keyStore, modelStore, modelAliasStore, settingsStore, proxyPool, limiter, requestTracker, metrics, eventLogger, adminSessions);
  await registerOpenAIRoutes(app, config, keyStore, modelStore, modelAliasStore, settingsStore, sessions, proxyPool, limiter, requestTracker, metrics, eventLogger);
  await registerAnthropicRoutes(app, config, keyStore, modelStore, modelAliasStore, settingsStore, sessions, proxyPool, limiter, requestTracker, metrics, eventLogger);
  await registerWebRoutes(app);

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ error: { message: "Route not found", type: "not_found_error" } });
  });

  return { app, keyStore, requestTracker, modelAliasStore };
};
