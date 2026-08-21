import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Plus, Save, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { fadeUp, staggerContainer } from "@/lib/motion";
import type { ConsoleData } from "../hooks/useConsoleData";
import type { ModelAlias } from "../types";

export function AliasesView({ data }: { data: ConsoleData }) {
  const { modelAliases, busy, updateModelAliases } = data;
  const [onlyConfiguredAliases, setOnlyConfiguredAliases] = useState(false);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);

  useEffect(() => {
    setOnlyConfiguredAliases(modelAliases.onlyConfiguredAliases);
    setAliases(modelAliases.aliases.map((alias) => ({ ...alias })));
  }, [modelAliases]);

  const updateRow = (index: number, field: keyof ModelAlias, value: string) => {
    setAliases((current) => current.map((alias, row) => row === index ? { ...alias, [field]: value } : alias));
  };

  const save = () => updateModelAliases({ onlyConfiguredAliases, aliases: aliases.filter((alias) => alias.downstreamModelId.trim() || alias.upstreamModelId.trim()) });

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-4">
      <motion.div variants={fadeUp}>
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">下游模型别名</h2>
              <p className="mt-1 text-xs text-muted-foreground">按上游 → 下游填写（例如：oc/ox-alpha → x-preview-f-free）。请求使用下游 ID，网关转发为上游 ID，并把响应中的模型 ID 换回下游 ID。</p>
            </div>
            <label className="flex items-center gap-3 text-sm">
              <span>只允许使用已配置的别名</span>
              <Switch checked={onlyConfiguredAliases} disabled={busy} onCheckedChange={setOnlyConfiguredAliases} />
            </label>
          </div>
        </Card>
      </motion.div>

      <motion.div variants={fadeUp}>
        <Card className="p-5">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border pb-2 text-xs text-muted-foreground">
            <Label className="text-xs text-muted-foreground">上游 model ID</Label>
            <span aria-hidden="true" />
            <Label className="text-xs text-muted-foreground">下游 model ID</Label>
            <span className="sr-only">操作</span>
          </div>
          <div className="mt-3 space-y-2">
            {aliases.map((alias, index) => (
              <div key={`${index}-${alias.downstreamModelId}`} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2">
                <Input
                  value={alias.upstreamModelId}
                  disabled={busy}
                  placeholder="oc/ox-alpha"
                  aria-label="上游 model ID"
                  onChange={(event) => updateRow(index, "upstreamModelId", event.target.value)}
                />
                <ArrowRight size={16} className="text-muted-foreground" aria-hidden="true" />
                <Input
                  value={alias.downstreamModelId}
                  disabled={busy}
                  placeholder="x-preview-f-free"
                  aria-label="下游 model ID"
                  onChange={(event) => updateRow(index, "downstreamModelId", event.target.value)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  title="删除别名"
                  aria-label="删除别名"
                  onClick={() => setAliases((current) => current.filter((_, row) => row !== index))}
                >
                  <Trash2 size={16} className="text-destructive" />
                </Button>
              </div>
            ))}
            {aliases.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">尚未配置模型别名</p>}
          </div>
          <div className="mt-4 flex flex-wrap justify-between gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setAliases((current) => [...current, { downstreamModelId: "", upstreamModelId: "" }])}>
              <Plus size={15} /> 添加别名
            </Button>
            <Button size="sm" disabled={busy} onClick={save}>
              <Save size={15} /> 保存别名配置
            </Button>
          </div>
        </Card>
      </motion.div>
    </motion.div>
  );
}
