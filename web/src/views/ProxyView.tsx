import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, Check, CheckCircle2, Network, Plus, RotateCcw, Route, Trash2, Waypoints } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { fadeUp, staggerContainer } from "@/lib/motion";
import type { ConsoleData } from "../hooks/useConsoleData";
import type { ProxyDraft, ProxyNode } from "../types";
import { MeterBar } from "../components/MeterBar";
import { ResultStrip } from "../components/ResultStrip";
import { ConfirmDialog } from "../components/ConfirmDialog";

const proxyModes = [
  { value: "direct", label: "直连", description: "所有请求不使用代理池" },
  { value: "optional", label: "优先代理", description: "有可用节点则使用，否则直连" },
  { value: "required", label: "强制代理", description: "无可用节点时请求失败" },
] as const;

const stateBadge = (proxy: ProxyNode): { label: string; variant: "muted" | "warning" | "info" | "destructive" | "success" } => {
  if (!proxy.enabled && proxy.autoDisabledBy429) return { label: "429 自动禁用", variant: "warning" };
  if (!proxy.enabled) return { label: "已禁用", variant: "muted" };
  if (proxy.consecutiveRateLimitCount >= 3) return { label: "429 风险", variant: "warning" };
  if (proxy.cooldownUntil && Date.parse(proxy.cooldownUntil) > Date.now()) return { label: "冷却中", variant: "info" };
  if (proxy.lastError) return { label: "异常", variant: "destructive" };
  return { label: "健康", variant: "success" };
};

export function ProxyView({ data }: { data: ConsoleData }) {
  const { proxies, settings, busy, createProxy, toggleProxy, testProxy, deleteProxy, clearProxyStats, updateSettings } = data;
  const [draft, setDraft] = useState<ProxyDraft>({ name: "香港节点 1", type: "http", url: "", dailyRequestLimit: 1000, maxConcurrency: 10 });
  const [deleteTarget, setDeleteTarget] = useState<ProxyNode | null>(null);
  const [statsTarget, setStatsTarget] = useState<ProxyNode | null>(null);

  const proxyMode = settings?.proxyMode ?? "optional";
  const preProxyEnabled = Boolean(settings?.outboundPreProxyEnabled);
  const [preProxyDraft, setPreProxyDraft] = useState("");
  useEffect(() => {
    setPreProxyDraft(settings?.outboundPreProxyUrl ?? "");
  }, [settings?.outboundPreProxyUrl]);
  const preProxyDirty = preProxyDraft.trim() !== (settings?.outboundPreProxyUrl ?? "");

  const prioritized = useMemo(() => {
    const now = Date.now();
    return (
      [...proxies]
        .filter((p) => p.enabled)
        .filter((p) => !p.cooldownUntil || Date.parse(p.cooldownUntil) <= now)
        .filter((p) => p.dailyRequestLimit === 0 || p.dailyRequestCount < p.dailyRequestLimit)
        .filter((p) => p.currentConcurrency < p.maxConcurrency)
        .sort((a, b) => b.weight - a.weight)[0] || null
    );
  }, [proxies]);

  return (
    <div className="space-y-4">
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 gap-3 md:grid-cols-3"
      >
        <motion.div variants={fadeUp}>
          <InfoCard icon={<Route size={16} className="text-primary" />} title="当前策略" value="优先填充" sub="高权重节点优先，同权重按顺序" />
        </motion.div>
        <motion.div variants={fadeUp}>
          <InfoCard icon={<AlertTriangle size={16} className="text-warning" />} title="429 熔断" value="连续 5 次" sub="每 10 分钟发起模型探测，成功后自动恢复" />
        </motion.div>
        <motion.div variants={fadeUp}>
          <InfoCard icon={<CheckCircle2 size={16} className="text-success" />} title="优先节点" value={prioritized?.name || "无可用"} sub="按权重与可用性选出" />
        </motion.div>
      </motion.div>

      <Card className="p-5">
        <div className="flex items-center gap-2">
          <Route size={16} className="text-primary" />
          <h2 className="text-sm font-semibold">代理使用模式</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">控制请求是否使用出口代理池。该设置对下一个请求即时生效，无需重启。</p>
        <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3">
          {proxyModes.map((mode) => {
            const active = proxyMode === mode.value;
            return (
              <button
                key={mode.value}
                className={cn(
                  "group relative rounded-lg border p-4 text-left transition-colors",
                  active
                    ? "border-primary bg-primary/10 ring-1 ring-inset ring-primary/30"
                    : "border-border bg-muted/30 hover:bg-muted/50"
                )}
                disabled={busy || !settings}
                onClick={() => updateSettings({ proxyMode: mode.value })}
              >
                {active && (
                  <span className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-content">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
                <span
                  className={cn(
                    "block text-sm font-medium",
                    active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
                  )}
                >
                  {mode.label}
                </span>
                <span className="text-xs text-muted-foreground">{mode.description}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2">
          <Waypoints size={16} className="text-primary" />
          <h2 className="text-sm font-semibold">出站前置代理（链式代理）</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          开启后，所有代理节点的出站连接会先经此本机地址再连上游。仅当代理使用模式不是“直连”且请求实际选中代理节点时生效，修改后无需重启。
        </p>

        <div className="mt-4 flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">前置代理</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {preProxyEnabled ? "已开启，节点经前置代理出网" : "已关闭，节点直连上游"}
            </div>
          </div>
          <Switch
            disabled={busy || !settings}
            checked={preProxyEnabled}
            onCheckedChange={() => updateSettings({ outboundPreProxyEnabled: !preProxyEnabled })}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground">前置代理地址（http/https）</Label>
            <Input
              value={preProxyDraft}
              disabled={busy || !settings}
              onChange={(e) => setPreProxyDraft(e.target.value)}
              placeholder="http://127.0.0.1:7897"
            />
          </div>
          <Button
            size="sm"
            disabled={busy || !settings || !preProxyDirty}
            onClick={() => updateSettings({ outboundPreProxyUrl: preProxyDraft.trim() })}
          >
            保存
          </Button>
        </div>
        {!(settings?.outboundPreProxyUrl || "").trim() && (
          <p className="mt-2 text-xs text-warning/90">请先填写并保存地址，再开启前置代理（直接开启会因地址为空而报错）。</p>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold">新增代理节点</h2>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="w-36 space-y-1.5">
            <Label className="text-xs text-muted-foreground">名称</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="代理名称" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">类型</Label>
            <Select value={draft.type} onValueChange={(v) => setDraft({ ...draft, type: v })}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP</SelectItem>
                <SelectItem value="https">HTTPS</SelectItem>
                <SelectItem value="socks5">SOCKS5</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-64 flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground">代理 URL</Label>
            <Input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="http://user:pass@1.2.3.4:8080" />
          </div>
          <div className="w-32 space-y-1.5">
            <Label className="text-xs text-muted-foreground">每日上限（0=不限）</Label>
            <Input
              type="number"
              min={0}
              value={draft.dailyRequestLimit}
              onChange={(e) => setDraft({ ...draft, dailyRequestLimit: Number(e.target.value) })}
            />
          </div>
          <div className="w-24 space-y-1.5">
            <Label className="text-xs text-muted-foreground">最大并发</Label>
            <Input
              type="number"
              min={1}
              value={draft.maxConcurrency}
              onChange={(e) => setDraft({ ...draft, maxConcurrency: Number(e.target.value) })}
            />
          </div>
          <Button size="sm" disabled={busy} onClick={() => createProxy(draft)}>
            <Plus size={16} /> 新增
          </Button>
        </div>
      </Card>

      {proxies.length === 0 && (
        <Card className="p-8">
          <div className="flex flex-col items-center text-center">
            <span className="grid h-12 w-12 place-items-center rounded-lg bg-muted/40 text-muted-foreground">
              <Network size={26} />
            </span>
            <h3 className="mt-3 text-sm font-semibold">尚未配置出口节点</h3>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              添加 HTTP、HTTPS 或 SOCKS5 代理后，网关会优先填充第一个可用节点；连续 5 次 429 会自动禁用，并在恢复探测成功后重新启用。
            </p>
          </div>
        </Card>
      )}

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="proxy-grid"
      >
        {proxies.map((proxy) => {
          const badge = stateBadge(proxy);
          const isPrimary = prioritized?.id === proxy.id;
          return (
            <motion.div key={proxy.id} variants={fadeUp} layout>
              <Card className={cn("h-full p-4", isPrimary && "ring-2 ring-primary/40")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <strong className="truncate">{proxy.name}</strong>
                      <Badge variant="outline" className="uppercase">{proxy.type}</Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{proxy.url}</p>
                  </div>
                  <Badge variant={isPrimary ? "default" : badge.variant} className="shrink-0">
                    {isPrimary ? "当前优先" : badge.label}
                  </Badge>
                </div>

                <div className="mt-4 space-y-3">
                  <MeterBar label="今日用量" current={proxy.dailyRequestCount} max={proxy.dailyRequestLimit} />
                  <MeterBar label="并发" current={proxy.currentConcurrency} max={proxy.maxConcurrency} />
                  <MeterBar label="连续 429" current={proxy.consecutiveRateLimitCount || 0} max={5} unlimitedText="5" />
                </div>

                {(() => {
                  const total = proxy.successCount + proxy.failCount;
                  const rate = total === 0 ? "—" : `${Math.round((proxy.successCount / total) * 100)}%`;
                  return (
                    <div className="mt-3 space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          成功率 <span className="font-medium tabular-nums text-foreground/80">{rate}</span>
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          总 {total} · 成 {proxy.successCount} · 败 {proxy.failCount}
                        </span>
                      </div>
                      <ResultStrip results={proxy.recentResults || []} />
                    </div>
                  );
                })()}

                <div className="mt-4 grid grid-cols-4 gap-2 rounded-md border border-border bg-muted/30 p-2 text-center text-xs">
                  <div>
                    <div className="text-muted-foreground">成功</div>
                    <div className="font-semibold tabular-nums text-success">{proxy.successCount}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">失败</div>
                    <div className="font-semibold tabular-nums text-destructive">{proxy.failCount}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">权重</div>
                    <div className="font-semibold tabular-nums">{proxy.weight}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">总 Token</div>
                    <div className="font-semibold tabular-nums">{proxy.totalTokens.toLocaleString()}</div>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>今日 Token</span>
                  <span className="font-semibold tabular-nums text-foreground">{proxy.dailyTokens.toLocaleString()}</span>
                </div>

                {proxy.lastError && <p className="mt-2 break-words text-xs text-destructive">最后错误：{proxy.lastError}</p>}
                {proxy.autoDisabledBy429 && !proxy.enabled && (
                  <p className="mt-1 text-xs text-warning/90">
                    自动恢复探测：{proxy.lastRecoveryTestAt ? new Date(proxy.lastRecoveryTestAt).toLocaleString() : "等待下一轮（10 分钟）"}
                  </p>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggleProxy(proxy)}>
                    {proxy.enabled ? "禁用" : "启用"}
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => testProxy(proxy)}>
                    测试
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStatsTarget(proxy)} title="清空统计数据">
                    <RotateCcw size={14} /> 清空统计
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => setDeleteTarget(proxy)}
                  >
                    <Trash2 size={14} /> 删除
                  </Button>
                </div>
              </Card>
            </motion.div>
          );
        })}
      </motion.div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除代理节点"
        message={`确定删除代理「${deleteTarget?.name}」吗？`}
        confirmText="删除"
        busy={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteProxy(deleteTarget);
          setDeleteTarget(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(statsTarget)}
        title="清空代理统计"
        message={`确定清空代理「${statsTarget?.name}」的成功失败、Token 和最近结果统计吗？`}
        confirmText="清空统计"
        busy={busy}
        onCancel={() => setStatsTarget(null)}
        onConfirm={() => {
          if (statsTarget) clearProxyStats(statsTarget);
          setStatsTarget(null);
        }}
      />
    </div>
  );
}

function InfoCard({ icon, title, value, sub }: { icon: React.ReactNode; title: string; value: string; sub: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {title}
      </div>
      <strong className="mt-2 block truncate text-lg font-semibold">{value}</strong>
      <small className="text-xs text-muted-foreground/70">{sub}</small>
    </Card>
  );
}
