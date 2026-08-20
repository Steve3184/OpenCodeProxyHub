import { motion } from "motion/react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { fadeUp, staggerContainer } from "@/lib/motion";
import type { ConsoleData } from "../hooks/useConsoleData";

const AXIS = { fontSize: 11, fill: "#8a8f98" };
const GRID = "#21242b";
const COLORS = { primary: "#5e6ad2", success: "#4cb782", warning: "#f5a524", error: "#e5484d" } as const;

function statusColor(code: string) {
  const n = Number(code);
  if (n >= 200 && n < 300) return COLORS.success;
  if (n >= 400 && n < 500) return COLORS.warning;
  if (n >= 500) return COLORS.error;
  return COLORS.primary;
}

function ChartTooltip({ active, payload, label, suffix = "ms" }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-xl shadow-black/40">
      <div className="mb-1 font-medium">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium tabular-nums">{p.value}{suffix}</span>
        </div>
      ))}
    </div>
  );
}

const barSpring = { duration: 0.3, ease: [0.22, 1, 0.36, 1] as const };

export function MonitorView({ data }: { data: ConsoleData }) {
  const { metricsData, runtime } = data;

  if (!metricsData) {
    return (
      <Card className="p-8">
        <div className="flex flex-col items-center text-center">
          <span className="grid h-12 w-12 place-items-center rounded-lg bg-muted/40 text-muted-foreground">
            <BarChart3 size={26} />
          </span>
          <h3 className="mt-3 text-sm font-semibold">指标加载中…</h3>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            输入控制台密码后可查看 HTTP、上游、限流器与运行时指标。
          </p>
        </div>
      </Card>
    );
  }

  const stats = [
    { label: "HTTP 请求", value: metricsData.http.totalRequests, sub: `错误 ${metricsData.http.errorRequests} · P95 ${metricsData.http.latencyMs.p95}ms` },
    { label: "上游请求", value: metricsData.upstream.totalRequests, sub: `错误 ${metricsData.upstream.errorRequests} · P95 ${metricsData.upstream.latencyMs.p95}ms` },
    { label: "运行状态", value: runtime?.runtime.draining ? "排水中" : "运行中", sub: `进行中 ${runtime?.runtime.inFlightRequests ?? 0} · ${runtime?.limiter.backend || "limiter"}` },
    { label: "运行时长", value: `${Math.floor(metricsData.uptimeSeconds / 60)}m`, sub: metricsData.startedAt },
  ];

  const latencyData = [
    { p: "P50", HTTP: metricsData.http.latencyMs.p50, upstream: metricsData.upstream.latencyMs.p50 },
    { p: "P95", HTTP: metricsData.http.latencyMs.p95, upstream: metricsData.upstream.latencyMs.p95 },
    { p: "P99", HTTP: metricsData.http.latencyMs.p99, upstream: metricsData.upstream.latencyMs.p99 },
  ];

  const statusData = Object.entries(metricsData.http.byStatus)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => Number(a.code) - Number(b.code));
  const maxStatus = Math.max(1, ...statusData.map((s) => s.count));

  const routeEntries = Object.entries(metricsData.http.byRoute).sort((a, b) => b[1] - a[1]);
  const maxRoute = Math.max(1, ...routeEntries.map((r) => r[1]));
  const hourlyData = Object.entries(metricsData.http.byHour || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-24)
    .map(([hour, requests]) => ({
      hour,
      label: new Date(hour).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit" }),
      requests,
    }));

  return (
    <div className="space-y-4">
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="grid grid-cols-2 gap-4 lg:grid-cols-4"
      >
        {stats.map((s) => (
          <motion.div key={s.label} variants={fadeUp}>
            <Card className="p-4">
              <span className="text-xs text-muted-foreground">{s.label}</span>
              <strong className="mt-1 block truncate text-2xl font-semibold tracking-tight tabular-nums">
                {s.value}
              </strong>
              <small className="mt-1 block truncate text-xs text-muted-foreground/70">{s.sub}</small>
            </Card>
          </motion.div>
        ))}
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1], delay: 0.04 }}
      >
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">每小时请求数</h3>
            <span className="text-xs text-muted-foreground">最近 24 个小时（UTC）</span>
          </div>
          {hourlyData.length === 0 ? (
            <p className="mt-12 text-center text-sm text-muted-foreground/70">暂无请求数据</p>
          ) : (
            <div className="mt-4 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourlyData} margin={{ top: 4, right: 8, bottom: 20, left: -16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={AXIS}
                    axisLine={{ stroke: GRID }}
                    tickLine={false}
                    minTickGap={18}
                    angle={-25}
                    textAnchor="end"
                  />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} width={48} allowDecimals={false} />
                  <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={<ChartTooltip suffix="" />} />
                  <Bar dataKey="requests" name="请求数" fill={COLORS.primary} radius={[4, 4, 0, 0]} maxBarSize={32} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </motion.div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="lg:col-span-2"
        >
          <Card className="h-full p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">延迟分位（毫秒）</h3>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: COLORS.primary }} /> HTTP
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: COLORS.success }} /> 上游
                </span>
              </div>
            </div>
            <div className="mt-4 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={latencyData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
                  <XAxis dataKey="p" tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} width={48} />
                  <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} content={<ChartTooltip />} />
                  <Bar dataKey="HTTP" fill={COLORS.primary} radius={[4, 4, 0, 0]} maxBarSize={36} />
                  <Bar dataKey="upstream" name="上游" fill={COLORS.success} radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
        >
          <Card className="h-full p-5">
            <h3 className="text-sm font-semibold">HTTP 状态码</h3>
            {statusData.length === 0 ? (
              <p className="mt-12 text-center text-sm text-muted-foreground/70">暂无数据</p>
            ) : (
              <div className="mt-4 space-y-3">
                {statusData.map((s) => (
                  <div key={s.code}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium tabular-nums">{s.code}</span>
                      <span className="tabular-nums text-muted-foreground">{s.count}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ background: statusColor(s.code), transformOrigin: "left" }}
                        initial={false}
                        animate={{ transform: `scaleX(${s.count / maxStatus})` }}
                        transition={barSpring}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1], delay: 0.08 }}
          className="lg:col-span-2"
        >
          <Card className="h-full p-5">
            <h3 className="text-sm font-semibold">路由热度</h3>
            {routeEntries.length === 0 ? (
              <p className="mt-12 text-center text-sm text-muted-foreground/70">暂无数据</p>
            ) : (
              <div className="mt-4 space-y-2.5">
                {routeEntries.map(([route, count]) => (
                  <div key={route}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate font-mono text-muted-foreground">{route}</span>
                      <span className="ml-2 shrink-0 tabular-nums text-muted-foreground">{count}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <motion.div
                        className="h-full rounded-full bg-primary"
                        style={{ transformOrigin: "left" }}
                        initial={false}
                        animate={{ transform: `scaleX(${count / maxRoute})` }}
                        transition={barSpring}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1], delay: 0.11 }}
        >
          <Card className="h-full p-5">
            <h3 className="text-sm font-semibold">最近错误</h3>
            {metricsData.recentErrors.length === 0 ? (
              <p className="mt-12 text-center text-sm text-muted-foreground/70">暂无错误</p>
            ) : (
              <div className="mt-4 space-y-2">
                {metricsData.recentErrors.map((item) => (
                  <motion.div
                    key={`${item.at}-${item.message}`}
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="rounded-md border border-destructive/25 bg-destructive/[0.07] p-2.5"
                  >
                    <div className="text-xs font-medium text-destructive">
                      {item.scope} · {item.statusCode || "ERR"}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{item.message}</div>
                  </motion.div>
                ))}
              </div>
            )}
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
