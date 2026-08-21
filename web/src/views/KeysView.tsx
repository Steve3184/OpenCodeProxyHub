import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, Copy, KeyRound, Pencil, Plus, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { fadeUp, staggerContainer } from "@/lib/motion";
import type { ConsoleData } from "../hooks/useConsoleData";
import type { ApiKeyItem, ApiKeyPolicy } from "../types";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";

export function KeysView({ data }: { data: ConsoleData }) {
  const {
    apiKeys,
    busy,
    lastCreatedKey,
    createKey,
    toggleKey,
    deleteKey,
    updateKeyMeta,
    updateKeyPolicy,
    copyCreatedKey,
    copyStoredKey,
  } = data;
  const [newName, setNewName] = useState("默认用户");
  const [search, setSearch] = useState("");
  const [metaTarget, setMetaTarget] = useState<ApiKeyItem | null>(null);
  const [policyTarget, setPolicyTarget] = useState<ApiKeyItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyItem | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return apiKeys;
    return apiKeys.filter((k) =>
      [k.name, k.keyPrefix, k.description || "", ...k.labels].join(" ").toLowerCase().includes(q)
    );
  }, [apiKeys, search]);

  return (
    <div className="space-y-4">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2">
              <div className="relative">
                <KeyRound size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-8 w-44" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新 Key 名称" />
              </div>
              <Button size="sm" disabled={busy} onClick={() => createKey(newName)}>
                <Plus size={16} /> 创建 Key
              </Button>
            </div>
            <Input className="ml-auto w-64" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索名称、前缀、备注或标签" />
          </div>

          {lastCreatedKey && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="mt-4 flex items-center gap-3 rounded-md border border-success/25 bg-success/[0.08] p-3"
            >
              <KeyRound size={18} className="shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-success">新建 Key 明文（仅显示一次）</div>
                <code className="block truncate font-mono text-sm">{lastCreatedKey}</code>
              </div>
              <Button size="sm" variant="outline" onClick={() => copyCreatedKey()}>
                <Copy size={14} /> 复制
              </Button>
            </motion.div>
          )}
        </Card>
      </motion.div>

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        {visible.map((key) => (
          <motion.div key={key.id} variants={fadeUp} layout>
            <Card className={cn("h-full p-4", !key.enabled && "opacity-60")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <strong className="truncate">{key.name}</strong>
                    <Badge variant={key.enabled ? "success" : "muted"}>{key.enabled ? "启用" : "禁用"}</Badge>
                  </div>
                  <code className="font-mono text-xs text-muted-foreground">{key.keyPrefix}</code>
                </div>
                <ShieldCheck size={18} className="shrink-0 text-muted-foreground/40" />
              </div>

              <p className="mt-3 text-xs text-muted-foreground">{key.description || "无备注"}</p>
              {key.labels.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {key.labels.map((label) => (
                    <Badge key={label} variant="outline">
                      #{label}
                    </Badge>
                  ))}
                </div>
              )}

              <div className="mt-3 grid grid-cols-3 gap-2 rounded-md border border-border bg-muted/30 p-2 text-center text-xs">
                <div>
                  <div className="text-muted-foreground">请求</div>
                  <div className="font-semibold tabular-nums">{key.requestCount}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">RPM</div>
                  <div className="font-semibold tabular-nums">{key.policy.requestsPerMinute ?? "默认"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">客户端</div>
                  <div className="font-semibold tabular-nums">{key.recentClients.length}</div>
                </div>
              </div>

              <div className="mt-3 text-[11px] text-muted-foreground/70">最近使用：{key.lastUsedAt || "从未使用"}</div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !key.hasRecoverableKey}
                  onClick={() => copyStoredKey(key)}
                  title={key.hasRecoverableKey ? "复制明文" : "该 Key 未保存明文"}
                >
                  <Copy size={13} /> 复制
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMetaTarget(key)}>
                  <Pencil size={13} /> 备注
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPolicyTarget(key)}>
                  <SlidersHorizontal size={13} /> 策略
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggleKey(key)}>
                  {key.enabled ? "禁用" : "启用"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => setDeleteTarget(key)}
                >
                  <Trash2 size={13} /> 删除
                </Button>
              </div>
            </Card>
          </motion.div>
        ))}
        {visible.length === 0 && <p className="text-sm text-muted-foreground/70">没有匹配的 API Key</p>}
      </motion.div>

      {metaTarget && (
        <MetaModal
          target={metaTarget}
          busy={busy}
          onClose={() => setMetaTarget(null)}
          onSave={(desc, labels) => {
            updateKeyMeta(metaTarget, desc, labels);
            setMetaTarget(null);
          }}
        />
      )}
      {policyTarget && (
        <PolicyModal
          target={policyTarget}
          busy={busy}
          onClose={() => setPolicyTarget(null)}
          onSave={(policy) => {
            updateKeyPolicy(policyTarget, policy);
            setPolicyTarget(null);
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 API Key"
        message={`确定删除 API key「${deleteTarget?.name}」吗？此操作不可撤销。`}
        confirmText="删除"
        busy={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteKey(deleteTarget);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

function MetaModal({
  target,
  busy,
  onClose,
  onSave,
}: {
  target: ApiKeyItem;
  busy: boolean;
  onClose: () => void;
  onSave: (desc: string, labels: string[]) => void;
}) {
  const [desc, setDesc] = useState(target.description || "");
  const [labels, setLabels] = useState(target.labels.join(", "));
  return (
    <Modal
      open
      title={`编辑「${target.name}」`}
      icon={<Pencil size={18} className="text-primary" />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onSave(desc, labels.split(",").map((l) => l.trim()).filter(Boolean))}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <Label>备注</Label>
        <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="用途说明" />
      </div>
      <div className="space-y-1.5">
        <Label>标签（逗号分隔）</Label>
        <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="prod, team-a" />
      </div>
    </Modal>
  );
}

function PolicyModal({
  target,
  busy,
  onClose,
  onSave,
}: {
  target: ApiKeyItem;
  busy: boolean;
  onClose: () => void;
  onSave: (policy: ApiKeyPolicy) => void;
}) {
  const p = target.policy;
  const [rpm, setRpm] = useState(p.requestsPerMinute?.toString() ?? "");
  const [maxReq, setMaxReq] = useState(p.maxConcurrentRequests?.toString() ?? "");
  const [maxStream, setMaxStream] = useState(p.maxConcurrentStreams?.toString() ?? "");
  const [models, setModels] = useState((p.allowedModels || []).join(", "));
  // The backend treats an omitted allowProxy policy as allowed. Keep the
  // policy editor consistent so saving unrelated limits does not silently
  // disable the proxy pool for this key.
  const [allowProxy, setAllowProxy] = useState(p.allowProxy ?? true);

  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

  const submit = () => {
    const policy: ApiKeyPolicy = {
      requestsPerMinute: num(rpm),
      maxConcurrentRequests: num(maxReq),
      maxConcurrentStreams: num(maxStream),
      allowedModels: models.split(",").map((m) => m.trim()).filter(Boolean),
      allowProxy,
    };
    if (!policy.allowedModels?.length) delete policy.allowedModels;
    onSave(policy);
  };

  return (
    <Modal
      open
      title={`策略「${target.name}」`}
      icon={<SlidersHorizontal size={18} className="text-primary" />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button size="sm" disabled={busy} onClick={submit}>
            保存策略
          </Button>
        </>
      }
    >
      <p className="text-xs text-muted-foreground">留空字段继承全局默认值。</p>
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">每分钟请求</Label>
          <Input type="number" value={rpm} onChange={(e) => setRpm(e.target.value)} placeholder="默认" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">并发请求</Label>
          <Input type="number" value={maxReq} onChange={(e) => setMaxReq(e.target.value)} placeholder="默认" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">并发流</Label>
          <Input type="number" value={maxStream} onChange={(e) => setMaxStream(e.target.value)} placeholder="默认" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>允许模型（逗号分隔，空=全部）</Label>
        <Input value={models} onChange={(e) => setModels(e.target.value)} placeholder="deepseek-v4-flash-free, ..." />
      </div>
      <label className="flex cursor-pointer items-center gap-2">
        <Switch checked={allowProxy} onCheckedChange={setAllowProxy} />
        <span className="text-sm">允许使用出口代理</span>
      </label>
      {!allowProxy && (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning" role="alert">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>已关闭代理：此 API Key 的请求将绕过代理池，不参与代理切号、代理失败和 Token 用量统计。</span>
        </p>
      )}
    </Modal>
  );
}
