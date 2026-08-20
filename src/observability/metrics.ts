import type { FastifyInstance, FastifyRequest } from "fastify";

interface HttpMetricInput {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}

interface UpstreamMetricInput {
  statusCode: number;
  durationMs: number;
  proxyId?: string;
  error?: string;
}

const percentile = (values: number[], target: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((target / 100) * sorted.length) - 1);
  return Math.round(sorted[index] || 0);
};

const increment = (record: Record<string, number>, key: string, amount = 1): void => {
  record[key] = (record[key] || 0) + amount;
};

const currentHourKey = (): string => `${new Date().toISOString().slice(0, 13)}:00:00Z`;

export class MetricsStore {
  private readonly startedAt = new Date().toISOString();
  private readonly httpByRoute: Record<string, number> = {};
  private readonly httpByStatus: Record<string, number> = {};
  private readonly httpByHour: Record<string, number> = {};
  private readonly httpLatencies: number[] = [];
  private upstreamRequests = 0;
  private upstreamErrors = 0;
  private readonly upstreamByStatus: Record<string, number> = {};
  private readonly upstreamByProxy: Record<string, number> = {};
  private readonly upstreamLatencies: number[] = [];
  private readonly recentErrors: Array<{ at: string; scope: string; message: string; statusCode?: number }> = [];

  recordHttp(input: HttpMetricInput): void {
    increment(this.httpByRoute, `${input.method} ${input.route}`);
    increment(this.httpByStatus, String(input.statusCode));
    increment(this.httpByHour, currentHourKey());
    this.pruneHourlyRequests();
    this.httpLatencies.push(input.durationMs);
    if (this.httpLatencies.length > 1000) this.httpLatencies.shift();
    if (input.statusCode >= 500) this.recordError("http", `HTTP ${input.statusCode} ${input.method} ${input.route}`, input.statusCode);
  }

  recordUpstream(input: UpstreamMetricInput): void {
    this.upstreamRequests += 1;
    increment(this.upstreamByStatus, String(input.statusCode));
    if (input.proxyId) increment(this.upstreamByProxy, input.proxyId);
    this.upstreamLatencies.push(input.durationMs);
    if (this.upstreamLatencies.length > 1000) this.upstreamLatencies.shift();
    if (input.error || input.statusCode >= 500 || input.statusCode === 429) {
      this.upstreamErrors += 1;
      this.recordError("upstream", input.error || `Upstream HTTP ${input.statusCode}`, input.statusCode);
    }
  }

  recordError(scope: string, message: string, statusCode?: number): void {
    this.recentErrors.unshift({ at: new Date().toISOString(), scope, message, statusCode });
    if (this.recentErrors.length > 30) this.recentErrors.pop();
  }

  snapshot() {
    const totalHttp = Object.values(this.httpByStatus).reduce((sum, count) => sum + count, 0);
    const httpErrors = Object.entries(this.httpByStatus)
      .filter(([status]) => Number(status) >= 400)
      .reduce((sum, [, count]) => sum + count, 0);
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      http: {
        totalRequests: totalHttp,
        errorRequests: httpErrors,
        errorRate: totalHttp ? Number((httpErrors / totalHttp).toFixed(4)) : 0,
        byStatus: this.httpByStatus,
        byRoute: this.httpByRoute,
        byHour: this.httpByHour,
        latencyMs: {
          p50: percentile(this.httpLatencies, 50),
          p95: percentile(this.httpLatencies, 95),
          p99: percentile(this.httpLatencies, 99),
        },
      },
      upstream: {
        totalRequests: this.upstreamRequests,
        errorRequests: this.upstreamErrors,
        errorRate: this.upstreamRequests ? Number((this.upstreamErrors / this.upstreamRequests).toFixed(4)) : 0,
        byStatus: this.upstreamByStatus,
        byProxy: this.upstreamByProxy,
        latencyMs: {
          p50: percentile(this.upstreamLatencies, 50),
          p95: percentile(this.upstreamLatencies, 95),
          p99: percentile(this.upstreamLatencies, 99),
        },
      },
      recentErrors: this.recentErrors,
    };
  }

  private pruneHourlyRequests(): void {
    const keys = Object.keys(this.httpByHour).sort();
    while (keys.length > 168) {
      const key = keys.shift();
      if (key) delete this.httpByHour[key];
    }
  }
}

export const registerMetricsHooks = (app: FastifyInstance, metrics: MetricsStore): void => {
  const starts = new WeakMap<FastifyRequest, bigint>();
  app.addHook("onRequest", async (request) => {
    starts.set(request, process.hrtime.bigint());
  });
  app.addHook("onResponse", async (request, reply) => {
    const started = starts.get(request);
    const durationMs = started ? Number(process.hrtime.bigint() - started) / 1_000_000 : 0;
    metrics.recordHttp({
      method: request.method,
      route: request.routeOptions.url || request.url,
      statusCode: reply.statusCode,
      durationMs,
    });
  });
  app.addHook("onError", async (request, _reply, error) => {
    metrics.recordError("fastify", `${request.method} ${request.url}: ${error.message}`);
  });
};
