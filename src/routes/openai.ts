import type { FastifyInstance } from "fastify";
import type { ApiKeyStore } from "../auth/apiKeys.js";
import type { AppConfig } from "../config/env.js";
import type { ModelConfigStore } from "../models/catalog.js";
import type { ModelAliasStore } from "../models/aliases.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import { prepareZenRequest, pipeZenOpenAIResponse, requestZenFull } from "../providers/zenClient.js";
import { pipeAnthropicSseAsOpenAI } from "../converters/anthropicSseToOpenAi.js";
import { pipeOpenAiStreamStrippingThink } from "../converters/openAiThinkTagToReasoning.js";
import { createResponsesToOpenAIStreamTransformer, openAIChatToResponsesRequest, responsesToOpenAIChatResponse } from "../converters/openAiResponses.js";
import { SessionStore, sessionScopeFromHeaders } from "../sessions/sessionStore.js";
import type { OpenAIChatRequest } from "../types/api.js";
import type { ProxyPoolStore } from "../proxy/proxyPool.js";
import type { AsyncLimiter } from "../rateLimit/limiter.js";
import type { RequestTracker } from "../runtime/requestTracker.js";
import type { MetricsStore } from "../observability/metrics.js";
import { clientIdFromHeaders, type EventLogger } from "../observability/eventLogger.js";

export const registerOpenAIRoutes = async (
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
  app.post<{ Body: OpenAIChatRequest }>("/v1/chat/completions", async (request, reply) => {
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

    const {
      model: downstreamModel,
      messages,
      stream,
      tools,
      tool_choice,
      temperature,
      top_p,
      max_tokens,
      stop,
      presence_penalty,
      frequency_penalty,
      response_format,
      seed,
      user,
      reasoning_effort,
    } = request.body || {} as OpenAIChatRequest;
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
      return reply.code(429).send({ error: { message: limit.reason || "Rate limit exceeded", type: "rate_limit_error", code: "rate_limit_exceeded" } });
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
      return reply.code(400).send({ error: { message: `Model alias is required: ${model}`, type: "invalid_request_error" } });
    }
    const upstreamModel = modelAliasStore.resolveUpstream(model);
    const useResponsesUpstream = modelStore.usesResponses(upstreamModel);
    if (!modelAliasStore.find(model) && !modelStore.isEnabled(upstreamModel)) {
      release();
      return reply.code(400).send({ error: { message: `Unknown or disabled model: ${model}. Available: ${modelStore.enabledIds().join(", ")}` } });
    }
    if (!keyStore.isModelAllowed(auth.id, model)) {
      release();
      return reply.code(403).send({ error: { message: `Model is not allowed for this API key: ${model}`, type: "permission_error" } });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      release();
      return reply.code(400).send({ error: { message: "messages array is required" } });
    }

    const sessionId = sessions.getSession(sessionScopeFromHeaders(auth.id, "openai", model, request.headers));
    app.log.info({ user: auth.name, model, upstreamModel, stream: isStream, messageCount: messages.length }, "openai_request");
    const resolveTransform = (settings: ReturnType<typeof settingsStore.get>): string => {
      if (useResponsesUpstream) return "responses-to-openai";
      if (!isStream) return "passthrough";
      if (settings.openAiStreamTransformModels.includes(model)) return "anthropic-sse-to-openai";
      if (settings.reasoningTagModels.includes(model)) return "think-to-reasoning";
      return "passthrough";
    };
    const useProxy = (settings: ReturnType<typeof settingsStore.get>): boolean => settings.proxyMode !== "direct" && auth.policy.allowProxy !== false;
    const logRequest = (statusCode: number, extra: Record<string, unknown> = {}) => {
      const currentSettings = settingsStore.get();
      const node = prepared?.lease?.node ?? null;
      eventLogger.apiRequest({
        protocol: "openai",
        route: "/v1/chat/completions",
        apiKeyId: auth.id,
        apiKeyName: auth.name,
        clientId: clientIdFromHeaders(request.headers),
        model: downstreamModel,
        stream: isStream,
        messageCount: messages.length,
        statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
        proxyId: node?.id ?? null,
        proxyName: node?.name ?? (useProxy(currentSettings) ? null : "direct"),
        proxyType: node?.type ?? null,
        viaPreProxy: Boolean(node && currentSettings.outboundPreProxyEnabled && currentSettings.outboundPreProxyUrl),
        transform: resolveTransform(currentSettings),
        ...extra,
      });
    };
    reply.raw.once("finish", () => logRequest(reply.raw.statusCode));

    const activeSettings = settingsStore.get();
    const effectiveProxyPool = useProxy(activeSettings) ? proxyPool : undefined;
    const responseRequest = useResponsesUpstream ? openAIChatToResponsesRequest({
      model: upstreamModel,
      messages,
      stream: isStream,
      tools,
      tool_choice,
      temperature,
      top_p,
      max_tokens,
      stop,
      presence_penalty,
      frequency_penalty,
      response_format,
      seed,
      user,
      reasoning_effort,
    }) : undefined;
    const prepareRequest = (excludeProxyIds: ReadonlySet<string> = new Set()) => prepareZenRequest(config, {
      model: upstreamModel,
      stream: isStream,
      sessionId,
      ...(useResponsesUpstream
        ? { protocol: "responses" as const, responseBody: responseRequest }
        : { messages, tools, toolChoice: tool_choice, parameters: { temperature, top_p, max_tokens, stop, presence_penalty, frequency_penalty, response_format, seed, user, reasoning_effort } }),
    }, effectiveProxyPool, excludeProxyIds);
    const prepared = prepareRequest();

    if (useResponsesUpstream && !isStream) {
      try {
        const zenResp = await requestZenFull(prepared, effectiveProxyPool, metrics, prepareRequest);
        const raw = zenResp.raw || "";
        const rateLimited = zenResp.status === 429 || raw.includes("FreeUsageLimitError") || raw.includes("rate_limit_error") || raw.toLowerCase().includes("rate limit");
        if (rateLimited || zenResp.status < 200 || zenResp.status >= 300 || zenResp.data?.error || zenResp.data?.type === "error") {
          const message = zenResp.data?.error?.message || zenResp.data?.message || (rateLimited ? "Rate limit exceeded" : `Upstream returned HTTP ${zenResp.status}`);
          return reply.code(rateLimited ? 429 : (zenResp.status >= 400 ? zenResp.status : 502)).send({
            error: { message: rateLimited ? `${message} (free model rate limit)` : message, type: rateLimited ? "rate_limit_error" : "upstream_error", ...(rateLimited ? { code: "rate_limit_exceeded" } : {}) },
          });
        }
        return reply.code(200).send(responsesToOpenAIChatResponse(zenResp.data, model));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown upstream error";
        return reply.code(502).send({ error: { message, type: "upstream_error" } });
      }
    }

    reply.hijack();
    if (useResponsesUpstream) {
      pipeZenOpenAIResponse(prepared, true, reply.raw, effectiveProxyPool, metrics, prepareRequest, false, undefined, createResponsesToOpenAIStreamTransformer(model));
      return;
    }
    if (isStream && activeSettings.openAiStreamTransformModels.includes(model)) {
      pipeAnthropicSseAsOpenAI(prepared, model, reply.raw, effectiveProxyPool, metrics, prepareRequest);
      return;
    }
    if (isStream && activeSettings.reasoningTagModels.includes(model)) {
      pipeOpenAiStreamStrippingThink(prepared, model, reply.raw, effectiveProxyPool, metrics, prepareRequest);
      return;
    }
    pipeZenOpenAIResponse(prepared, isStream, reply.raw, effectiveProxyPool, metrics, prepareRequest, false, model);
  });
};
