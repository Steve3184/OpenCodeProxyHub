import type { FastifyInstance } from "fastify";
import type { ApiKeyStore } from "../auth/apiKeys.js";
import type { AppConfig } from "../config/env.js";
import type { ModelConfigStore } from "../models/catalog.js";
import type { ModelAliasStore } from "../models/aliases.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import { prepareZenRequest, requestZenFull } from "../providers/zenClient.js";
import { SessionStore, sessionScopeFromHeaders } from "../sessions/sessionStore.js";
import { anthropicToOpenAI, handleAnthropicFullResponse, pipeZenAsAnthropic } from "../converters/anthropic.js";
import type { AnthropicMessageRequest } from "../types/api.js";
import type { ProxyPoolStore } from "../proxy/proxyPool.js";
import type { AsyncLimiter } from "../rateLimit/limiter.js";
import type { RequestTracker } from "../runtime/requestTracker.js";
import type { MetricsStore } from "../observability/metrics.js";
import { clientIdFromHeaders, type EventLogger } from "../observability/eventLogger.js";

export const registerAnthropicRoutes = async (
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
  app.post<{ Body: AnthropicMessageRequest }>("/v1/messages", async (request, reply) => {
    const started = process.hrtime.bigint();
    const releaseRequest = requestTracker.acquire();
    if (!releaseRequest) {
      return reply.code(503).header("Retry-After", "5").send({ type: "error", error: { type: "service_unavailable", message: "Server is draining" } });
    }

    const auth = keyStore.authenticateKey(request.headers);
    if (!auth) {
      releaseRequest();
      return reply.code(401).send({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
    }
    keyStore.recordClientUsage(auth.id, request.headers);

    const { model: downstreamModel, stream } = request.body || {} as AnthropicMessageRequest;
    const model = downstreamModel;
    const isStream = Boolean(stream);
    const limit = await limiter.acquire(auth.id, isStream, {
      requestsPerMinute: auth.policy.requestsPerMinute,
      maxConcurrentRequests: auth.policy.maxConcurrentRequests,
      maxConcurrentStreams: auth.policy.maxConcurrentStreams,
    });
    if (!limit.allowed) {
      releaseRequest();
      if (limit.retryAfterSeconds) reply.header("Retry-After", String(limit.retryAfterSeconds));
      return reply.code(429).send({ type: "error", error: { type: "rate_limit_error", message: limit.reason || "Rate limit exceeded" } });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseRequest();
      limiter.release(auth.id, isStream).catch((error) => app.log.warn({ error }, "limiter_release_failed"));
    };
    reply.raw.once("close", release);
    reply.raw.once("finish", release);

    if (!model || !modelAliasStore.isAllowed(model)) {
      release();
      return reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: `Model alias is required: ${model}` } });
    }
    const upstreamModel = modelAliasStore.resolveUpstream(model);
    if (!modelAliasStore.find(model) && !modelStore.isEnabled(upstreamModel)) {
      release();
      return reply.code(400).send({
        type: "error",
        error: { type: "invalid_request_error", message: `Unknown or disabled model: ${model}. Available: ${modelStore.enabledIds().join(", ")}` },
      });
    }
    if (!keyStore.isModelAllowed(auth.id, model)) {
      release();
      return reply.code(403).send({ type: "error", error: { type: "permission_error", message: `Model is not allowed for this API key: ${model}` } });
    }

    const sessionId = sessions.getSession(sessionScopeFromHeaders(auth.id, "anthropic", model, request.headers));
    const { messages, tools, toolChoice, parameters } = anthropicToOpenAI(request.body);
    const inputTokens = Math.trunc(JSON.stringify(messages).length / 4);
    app.log.info({ user: auth.name, model, upstreamModel, stream: isStream, messageCount: messages.length }, "anthropic_request");
    const useProxy = (settings: ReturnType<typeof settingsStore.get>): boolean => settings.proxyMode !== "direct" && auth.policy.allowProxy !== false;
    const logRequest = (statusCode: number, extra: Record<string, unknown> = {}) => {
      const currentSettings = settingsStore.get();
      const node = prepared?.lease?.node ?? null;
      eventLogger.apiRequest({
        protocol: "anthropic",
        route: "/v1/messages",
        apiKeyId: auth.id,
        apiKeyName: auth.name,
        clientId: clientIdFromHeaders(request.headers),
        model,
        stream: isStream,
        messageCount: messages.length,
        statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
        proxyId: node?.id ?? null,
        proxyName: node?.name ?? (useProxy(currentSettings) ? null : "direct"),
        proxyType: node?.type ?? null,
        viaPreProxy: Boolean(node && currentSettings.outboundPreProxyEnabled && currentSettings.outboundPreProxyUrl),
        ...extra,
      });
    };
    reply.raw.once("finish", () => logRequest(reply.raw.statusCode));

    const activeSettings = settingsStore.get();
    const effectiveProxyPool = useProxy(activeSettings) ? proxyPool : undefined;
    const prepareRequest = (excludeProxyIds: ReadonlySet<string> = new Set()) => prepareZenRequest(config, {
      model: upstreamModel,
      messages,
      stream: isStream,
      tools,
      toolChoice,
      parameters,
      sessionId,
    }, effectiveProxyPool, excludeProxyIds);
    const prepared = prepareRequest();

    if (isStream) {
      reply.hijack();
      pipeZenAsAnthropic(prepared, model, reply.raw, inputTokens, effectiveProxyPool, metrics, prepareRequest);
      return;
    }

    try {
      const zenResp = await requestZenFull(prepared, effectiveProxyPool, metrics, prepareRequest);
      const result = handleAnthropicFullResponse(zenResp, model, inputTokens);
      return reply.code(result.status).send(result.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown upstream error";
      return reply.code(502).send({ type: "error", error: { type: "upstream_error", message } });
    }
  });
};
