import type { FastifyInstance } from "fastify";
import type { ApiKeyStore } from "../auth/apiKeys.js";
import type { AppConfig } from "../config/env.js";
import type { ModelConfigStore } from "../models/catalog.js";
import type { ModelAliasStore } from "../models/aliases.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import { pipeZenOpenAIResponse, prepareZenRequest, requestZenFull } from "../providers/zenClient.js";
import { createOpenAIToResponsesStreamTransformer, openAIChatResponseToResponses, responsesToOpenAIChatRequest } from "../converters/openAiResponses.js";
import { SessionStore, sessionScopeFromHeaders } from "../sessions/sessionStore.js";
import type { OpenAIResponsesRequest } from "../types/api.js";
import type { ProxyPoolStore } from "../proxy/proxyPool.js";
import type { AsyncLimiter } from "../rateLimit/limiter.js";
import type { RequestTracker } from "../runtime/requestTracker.js";
import type { MetricsStore } from "../observability/metrics.js";
import { clientIdFromHeaders, type EventLogger } from "../observability/eventLogger.js";

const responseInputCount = (input: unknown): number => {
  if (Array.isArray(input)) return input.length;
  return input === undefined ? 0 : 1;
};

const rewriteResponseModel = (value: any, model: string): any => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value, model };
  if (result.response && typeof result.response === "object" && !Array.isArray(result.response)) {
    result.response = { ...result.response, model };
  }
  return result;
};

export const registerResponsesRoutes = async (
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
  app.post<{ Body: OpenAIResponsesRequest }>("/v1/responses", async (request, reply) => {
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

    const body = (request.body || {}) as OpenAIResponsesRequest;
    const model = body.model;
    const isStream = Boolean(body.stream);
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
    if (!useResponsesUpstream && body.input === undefined && !body.instructions) {
      release();
      return reply.code(400).send({ error: { message: "input is required when this model uses the Chat Completions upstream", type: "invalid_request_error" } });
    }

    const inputItems = responseInputCount(body.input);
    const sessionId = sessions.getSession(sessionScopeFromHeaders(auth.id, "responses", model, request.headers));
    app.log.info({ user: auth.name, model, upstreamModel, stream: isStream, inputItems, useResponsesUpstream }, "responses_request");
    const useProxy = (settings: ReturnType<typeof settingsStore.get>): boolean => settings.proxyMode !== "direct" && auth.policy.allowProxy !== false;
    const logRequest = (statusCode: number, extra: Record<string, unknown> = {}) => {
      const currentSettings = settingsStore.get();
      const node = prepared?.lease?.node ?? null;
      eventLogger.apiRequest({
        protocol: "responses",
        route: "/v1/responses",
        apiKeyId: auth.id,
        apiKeyName: auth.name,
        clientId: clientIdFromHeaders(request.headers),
        model,
        stream: isStream,
        messageCount: inputItems,
        statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
        proxyId: node?.id ?? null,
        proxyName: node?.name ?? (useProxy(currentSettings) ? null : "direct"),
        proxyType: node?.type ?? null,
        viaPreProxy: Boolean(node && currentSettings.outboundPreProxyEnabled && currentSettings.outboundPreProxyUrl),
        transform: useResponsesUpstream ? "passthrough" : "chat-to-responses",
        ...extra,
      });
    };
    reply.raw.once("finish", () => logRequest(reply.raw.statusCode));

    const activeSettings = settingsStore.get();
    const effectiveProxyPool = useProxy(activeSettings) ? proxyPool : undefined;
    const chatRequest = useResponsesUpstream ? undefined : responsesToOpenAIChatRequest({ ...body, model: upstreamModel, stream: isStream });
    const prepareRequest = (excludeProxyIds: ReadonlySet<string> = new Set()) => prepareZenRequest(config, {
      model: upstreamModel,
      stream: isStream,
      sessionId,
      ...(useResponsesUpstream
        ? { protocol: "responses" as const, responseBody: { ...body, model: upstreamModel, stream: isStream } }
        : { messages: chatRequest?.messages, tools: chatRequest?.tools, toolChoice: chatRequest?.tool_choice, parameters: {
          temperature: chatRequest?.temperature,
          top_p: chatRequest?.top_p,
          max_tokens: chatRequest?.max_tokens,
          stop: chatRequest?.stop,
          presence_penalty: chatRequest?.presence_penalty,
          frequency_penalty: chatRequest?.frequency_penalty,
          response_format: chatRequest?.response_format,
          seed: chatRequest?.seed,
          user: chatRequest?.user,
        } }),
    }, effectiveProxyPool, excludeProxyIds);
    const prepared = prepareRequest();

    if (!isStream) {
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
        const result = useResponsesUpstream
          ? rewriteResponseModel(zenResp.data, model)
          : openAIChatResponseToResponses(zenResp.data, model);
        return reply.code(200).send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown upstream error";
        return reply.code(502).send({ error: { message, type: "upstream_error" } });
      }
    }

    reply.hijack();
    if (useResponsesUpstream) {
      pipeZenOpenAIResponse(prepared, true, reply.raw, effectiveProxyPool, metrics, prepareRequest, false, model);
      return;
    }
    pipeZenOpenAIResponse(prepared, true, reply.raw, effectiveProxyPool, metrics, prepareRequest, false, undefined, createOpenAIToResponsesStreamTransformer(model));
  });
};
