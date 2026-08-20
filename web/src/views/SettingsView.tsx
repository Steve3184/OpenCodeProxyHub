import { motion } from "motion/react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { fadeUp, staggerContainer } from "@/lib/motion";
import type { ConsoleData } from "../hooks/useConsoleData";
import type { SystemSettings } from "../types";

export function SettingsView({ data }: { data: ConsoleData }) {
  const { settings, busy, updateSettings } = data;
  if (!settings) return <p className="text-sm text-muted-foreground">设置加载中…</p>;

  const numberField = (label: string, key: keyof SystemSettings, disabled = false) => (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        disabled={busy || disabled}
        value={settings[key] as number}
        onChange={(e) => updateSettings({ [key]: Number(e.target.value) } as Partial<SystemSettings>)}
      />
    </div>
  );

  const toggleField = (label: string, key: keyof SystemSettings, disabled = false) => (
    <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-3">
      <span className="text-sm">{label}</span>
      <Switch
        disabled={busy || disabled}
        checked={settings[key] as boolean}
        onCheckedChange={(v) => updateSettings({ [key]: v } as Partial<SystemSettings>)}
      />
    </div>
  );

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <motion.div variants={fadeUp}>
        <Card className="p-5">
          <h2 className="text-sm font-semibold">网关参数</h2>
          <div className="mt-4 space-y-4">
            {numberField("上游超时（毫秒）", "upstreamTimeoutMs")}
            {numberField("请求体限制（字节）", "requestBodyLimitBytes")}
            {toggleField("默认流式输出", "defaultStream")}
          </div>
        </Card>
      </motion.div>

      <motion.div variants={fadeUp}>
        <Card className="p-5">
          <h2 className="text-sm font-semibold">日志与审计</h2>
          <div className="mt-4 space-y-3">
            {toggleField("启用文件日志", "logEnabled")}
            {toggleField("记录管理审计", "logAudit", !settings.logEnabled)}
            {toggleField("记录 AI 请求摘要", "logApiRequests", !settings.logEnabled)}
            <div className="grid grid-cols-2 gap-3">
              {numberField("日志保留天数", "logRetentionDays", !settings.logEnabled)}
            </div>
          </div>
        </Card>
      </motion.div>
    </motion.div>
  );
}
