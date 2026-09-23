import type { FastifyInstance } from "fastify";
import type { ApiKeyStore } from "../auth/apiKeys.js";
import type { AppConfig } from "../config/env.js";
import type { ModelConfigStore } from "../models/catalog.js";
import type { ModelAliasStore } from "../models/aliases.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import { prepareZenRequest, requestZenFull } from "../providers/zenClient.js";
import { createToolNameMapper } from "../converters/toolMapping.js";
import { SessionStore, sessionScopeFromHeaders } from "../sessions/sessionStore.js";
import type { ProxyPoolStore } from "../proxy/proxyPool.js";
import type { AsyncLimiter } from "../rateLimit/limiter.js";
import type { RequestTracker } from "../runtime/requestTracker.js";
import type { MetricsStore } from "../observability/metrics.js";
import { clientIdFromHeaders, type EventLogger } from "../observability/eventLogger.js";

interface SystemoneRequest {
  model?: string;
  state?: unknown;
  questions?: unknown;
  [key: string]: unknown;
}

const rewriteModel = (data: any, model: string): any => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  return { ...data, model };
};

export const registerSystemoneRoutes = async (
  app: FastifyInstance,
  config: AppConfig,
  keyStore: ApiKeyStore,
  modelStore: ModelConfigStore,
  modelAliasStore: ModelAliasStore,
  settingsStore: SettingsStore,
  sessions: SessionStore,
  proxyPool: ProxyPoolStore,
  limiter: AsyncLimiter,
  requestTracker: RequestTracker,
  metrics: MetricsStore,
  eventLogger: EventLogger,
): Promise<void> => {
  app.post<{ Body: SystemoneRequest }>("/v1/systemone", async (request, reply) => {
    const started = process.hrtime.bigint();
    const releaseRequest = requestTracker.acquire();
    if (!releaseRequest) {
      return reply.code(503).header("Retry-After", "5").send({ error: { message: "Server is draining", type: "service_unavailable" } });
    }

    const auth = keyStore.authenticateKey(request.headers);
    if (!auth) {
      releaseRequest();
      return reply.code(401).send({ error: { message: "Invalid API key" } });
    }
    keyStore.recordClientUsage(auth.id, request.headers);

    const body = (request.body || {}) as SystemoneRequest;
    const downstreamModel = typeof body.model === "string" ? body.model.trim() : "";
    const limit = await limiter.acquire(auth.id, false, {
      requestsPerMinute: auth.policy.requestsPerMinute,
      maxConcurrentRequests: auth.policy.maxConcurrentRequests,
      maxConcurrentStreams: auth.policy.maxConcurrentStreams,
    });
    if (!limit.allowed) {
      releaseRequest();
      if (limit.retryAfterSeconds) reply.header("Retry-After", String(limit.retryAfterSeconds));
      return reply.code(429).send({ error: { message: limit.reason || "Rate limit exceeded", type: "rate_limit_error", code: "rate_limit_exceeded" } });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseRequest();
      limiter.release(auth.id, false).catch((error) => app.log.warn({ error }, "limiter_release_failed"));
    };
    reply.raw.once("close", release);
    reply.raw.once("finish", release);

    if (!downstreamModel || !modelAliasStore.isAllowed(downstreamModel)) {
      release();
      return reply.code(400).send({ error: { message: `Model alias is required: ${downstreamModel}`, type: "invalid_request_error" } });
    }
    const upstreamModel = modelAliasStore.resolveUpstream(downstreamModel);
    if (!modelAliasStore.find(downstreamModel) && !modelStore.isEnabled(upstreamModel)) {
      release();
      return reply.code(400).send({ error: { message: `Unknown or disabled model: ${downstreamModel}. Available: ${modelStore.enabledIds().join(", ")}` } });
    }
    if (!keyStore.isModelAllowed(auth.id, downstreamModel)) {
      release();
      return reply.code(403).send({ error: { message: `Model is not allowed for this API key: ${downstreamModel}`, type: "permission_error" } });
    }

    const sessionId = sessions.getSession(sessionScopeFromHeaders(auth.id, "systemone", downstreamModel, request.headers));
    const prepareRequest = (excludeProxyIds: ReadonlySet<string> = new Set()) => prepareZenRequest(config, {
      model: upstreamModel,
      protocol: "systemone",
      responseBody: { ...body, model: upstreamModel },
      sessionId,
      toolMapper: createToolNameMapper(undefined),
    }, settingsStore.get().proxyMode !== "direct" && auth.policy.allowProxy !== false ? proxyPool : undefined, excludeProxyIds);

    const logRequest = (statusCode: number) => {
      const currentSettings = settingsStore.get();
      const node = prepared?.lease?.node ?? null;
      eventLogger.apiRequest({
        protocol: "systemone",
        route: "/v1/systemone",
        apiKeyId: auth.id,
        apiKeyName: auth.name,
        clientId: clientIdFromHeaders(request.headers),
        model: downstreamModel,
        stream: false,
        messageCount: 0,
        statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
        proxyId: node?.id ?? null,
        proxyName: node?.name ?? (currentSettings.proxyMode !== "direct" && auth.policy.allowProxy !== false ? null : "direct"),
        proxyType: node?.type ?? null,
        viaPreProxy: Boolean(node && currentSettings.outboundPreProxyEnabled && currentSettings.outboundPreProxyUrl),
        transform: "systemone-model-alias",
      });
    };
    reply.raw.once("finish", () => logRequest(reply.raw.statusCode));

    const prepared = prepareRequest();
    try {
      const upstream = await requestZenFull(prepared, settingsStore.get().proxyMode !== "direct" && auth.policy.allowProxy !== false ? proxyPool : undefined, metrics, prepareRequest, false, "systemone");
      const raw = upstream.raw || "";
      const rateLimited = upstream.status === 429 || raw.includes("rate_limit_error") || raw.toLowerCase().includes("rate limit");
      if (rateLimited || upstream.status < 200 || upstream.status >= 300 || upstream.data?.error || upstream.data?.type === "error") {
        const message = upstream.data?.error?.message || upstream.data?.message || (rateLimited ? "Rate limit exceeded" : `Upstream returned HTTP ${upstream.status}`);
        const status = rateLimited ? 429 : (upstream.status >= 400 ? upstream.status : 502);
        return reply.code(status).send({ error: { message: rateLimited ? `${message} (free model rate limit)` : message, type: rateLimited ? "rate_limit_error" : "upstream_error", ...(rateLimited ? { code: "rate_limit_exceeded" } : {}) } });
      }
      return reply.code(200).send(rewriteModel(upstream.data, downstreamModel));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown upstream error";
      return reply.code(502).send({ error: { message, type: "upstream_error" } });
    }
  });
};
