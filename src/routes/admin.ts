import type { FastifyInstance } from "fastify";
import type { ApiKeyPolicy, ApiKeyStore } from "../auth/apiKeys.js";
import type { AppConfig } from "../config/env.js";
import { adminAuthMode, isAdminRequest } from "../auth/adminAuth.js";
import type { ModelConfigStore, ModelUpdateInput } from "../models/catalog.js";
import type { SettingsStore, SystemSettingsUpdate } from "../settings/settingsStore.js";
import type { ProxyInput, ProxyPoolStore } from "../proxy/proxyPool.js";
import type { AsyncLimiter } from "../rateLimit/limiter.js";
import type { RequestTracker } from "../runtime/requestTracker.js";
import type { MetricsStore } from "../observability/metrics.js";
import { clientIdFromHeaders, type EventLogger } from "../observability/eventLogger.js";

interface CreateKeyBody {
  name?: string;
}

interface UpdateKeyBody {
  name?: string;
  enabled?: boolean;
  description?: string;
  labels?: string[];
  policy?: ApiKeyPolicy;
}

export const registerAdminRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  keyStore: ApiKeyStore,
  modelStore: ModelConfigStore,
  settingsStore: SettingsStore,
  proxyPool: ProxyPoolStore,
  limiter: AsyncLimiter,
  requestTracker: RequestTracker,
  metrics: MetricsStore,
  eventLogger: EventLogger,
): Promise<void> => {
  const audit = (request: { headers: Record<string, string | string[] | undefined>; ip?: string }, action: string, result: "success" | "failure", details: Record<string, unknown> = {}) => {
    eventLogger.audit({
      action,
      result,
      actor: "admin",
      clientId: clientIdFromHeaders(request.headers),
      ip: request.ip,
      userAgent: Array.isArray(request.headers["user-agent"]) ? request.headers["user-agent"][0] : request.headers["user-agent"],
      ...details,
    });
  };

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/admin/")) return;
    if (isAdminRequest(request, config.adminPassword)) return;
    return reply.code(401).send({ error: { message: "Unauthorized" } });
  });

  app.get("/admin/session", async (request) => ({
    data: {
      authenticated: true,
      mode: adminAuthMode(request, config.adminPassword),
    },
  }));

  app.get("/admin/api-keys", async () => ({ data: keyStore.list() }));

  app.post<{ Body: CreateKeyBody }>("/admin/api-keys", async (request, reply) => {
    try {
      const created = keyStore.create(request.body?.name || "");
      audit(request, "api_key.create", "success", { targetId: created.id, targetName: created.name, keyPrefix: created.keyPrefix });
      return reply.code(201).send({ data: created });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create API key";
      audit(request, "api_key.create", "failure", { error: message });
      return reply.code(400).send({ error: { message } });
    }
  });

  app.get<{ Params: { id: string } }>("/admin/api-keys/:id/secret", async (request, reply) => {
    const key = keyStore.getSecret(request.params.id);
    if (!key) return reply.code(404).send({ error: { message: "API key plaintext is not available for this key" } });
    return reply.send({ data: { key } });
  });

  app.patch<{ Params: { id: string }; Body: UpdateKeyBody }>("/admin/api-keys/:id", async (request, reply) => {
    try {
      const updated = keyStore.update(request.params.id, request.body || {});
      audit(request, "api_key.update", "success", { targetId: request.params.id, targetName: updated.name, enabled: updated.enabled });
      return reply.send({ data: updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update API key";
      const status = message === "API key not found" ? 404 : 400;
      audit(request, "api_key.update", "failure", { targetId: request.params.id, error: message });
      return reply.code(status).send({ error: { message } });
    }
  });

  app.delete<{ Params: { id: string } }>("/admin/api-keys/:id", async (request, reply) => {
    const deleted = keyStore.delete(request.params.id);
    if (!deleted) {
      audit(request, "api_key.delete", "failure", { targetId: request.params.id, error: "API key not found" });
      return reply.code(404).send({ error: { message: "API key not found" } });
    }
    audit(request, "api_key.delete", "success", { targetId: request.params.id });
    return reply.code(204).send();
  });

  app.get("/admin/models", async () => ({ data: modelStore.list() }));

  app.put<{ Params: { id: string }; Body: ModelUpdateInput }>("/admin/models/:id", async (request, reply) => {
    try {
      const model = modelStore.upsert(request.params.id, request.body || {});
      audit(request, "model.upsert", "success", { targetId: request.params.id, enabled: model.enabled });
      return reply.send({ data: model });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save model";
      audit(request, "model.upsert", "failure", { targetId: request.params.id, error: message });
      return reply.code(400).send({ error: { message } });
    }
  });

  app.delete<{ Params: { id: string } }>("/admin/models/:id", async (request, reply) => {
    const deleted = modelStore.delete(request.params.id);
    if (!deleted) {
      audit(request, "model.delete", "failure", { targetId: request.params.id, error: "Model not found" });
      return reply.code(404).send({ error: { message: "Model not found" } });
    }
    audit(request, "model.delete", "success", { targetId: request.params.id });
    return reply.code(204).send();
  });

  app.get("/admin/settings", async () => ({ data: settingsStore.get() }));

  app.patch<{ Body: SystemSettingsUpdate }>("/admin/settings", async (request, reply) => {
    try {
      const settings = settingsStore.update(request.body || {});
      audit(request, "settings.update", "success", { keys: Object.keys(request.body || {}) });
      return reply.send({ data: settings });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update settings";
      audit(request, "settings.update", "failure", { keys: Object.keys(request.body || {}), error: message });
      return reply.code(400).send({ error: { message } });
    }
  });

  app.get("/admin/proxies", async () => ({ data: proxyPool.list() }));

  app.get("/admin/runtime", async () => ({
    data: {
      runtime: requestTracker.snapshot(),
      limiter: await limiter.snapshot(),
    },
  }));

  app.get("/admin/metrics", async () => ({ data: metrics.snapshot() }));

  app.post<{ Body: ProxyInput }>("/admin/proxies", async (request, reply) => {
    try {
      const proxy = proxyPool.create(request.body || {});
      audit(request, "proxy.create", "success", { targetId: proxy.id, targetName: proxy.name, enabled: proxy.enabled });
      return reply.code(201).send({ data: proxy });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create proxy";
      audit(request, "proxy.create", "failure", { error: message });
      return reply.code(400).send({ error: { message } });
    }
  });

  app.patch<{ Params: { id: string }; Body: ProxyInput }>("/admin/proxies/:id", async (request, reply) => {
    try {
      const proxy = proxyPool.update(request.params.id, request.body || {});
      audit(request, "proxy.update", "success", { targetId: request.params.id, targetName: proxy.name, enabled: proxy.enabled });
      return reply.send({ data: proxy });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update proxy";
      const status = message === "Proxy not found" ? 404 : 400;
      audit(request, "proxy.update", "failure", { targetId: request.params.id, error: message });
      return reply.code(status).send({ error: { message } });
    }
  });

  app.delete<{ Params: { id: string } }>("/admin/proxies/:id", async (request, reply) => {
    const deleted = proxyPool.delete(request.params.id);
    if (!deleted) {
      audit(request, "proxy.delete", "failure", { targetId: request.params.id, error: "Proxy not found" });
      return reply.code(404).send({ error: { message: "Proxy not found" } });
    }
    audit(request, "proxy.delete", "success", { targetId: request.params.id });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/admin/proxies/:id/test", async (request, reply) => {
    try {
      const proxy = await proxyPool.test(request.params.id, {
        hostname: config.zenHost,
        path: config.zenPath,
        model: modelStore.isEnabled(config.proxyHealthCheckModel)
          ? config.proxyHealthCheckModel
          : modelStore.enabledIds()[0] || config.proxyHealthCheckModel,
        timeoutMs: config.proxyHealthCheckTimeoutMs,
      });
      audit(request, "proxy.test", "success", { targetId: request.params.id, targetName: proxy.name });
      return reply.send({ data: proxy });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to test proxy";
      audit(request, "proxy.test", "failure", { targetId: request.params.id, error: message });
      return reply.code(400).send({ error: { message } });
    }
  });

  app.post<{ Params: { id: string } }>("/admin/proxies/:id/stats/clear", async (request, reply) => {
    try {
      const proxy = proxyPool.clearStats(request.params.id);
      audit(request, "proxy.stats.clear", "success", { targetId: proxy.id, targetName: proxy.name });
      return reply.send({ data: proxy });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clear proxy statistics";
      const status = message === "Proxy not found" ? 404 : 400;
      audit(request, "proxy.stats.clear", "failure", { targetId: request.params.id, error: message });
      return reply.code(status).send({ error: { message } });
    }
  });
};
