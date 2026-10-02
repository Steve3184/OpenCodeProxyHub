import { motion } from "motion/react";
import { Activity, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { fadeIn } from "@/lib/motion";
import type { ConsoleData } from "../hooks/useConsoleData";

export function ModelsView({ data }: { data: ConsoleData }) {
  const { models, settings, busy, toggleModel, toggleUseResponses, toggleOpenAiStreamTransform, toggleReasoningTag, syncFreeModels } = data;
  const enabledCount = models.filter((model) => model.enabled).length;

  return (
    <motion.div variants={fadeIn} initial="hidden" animate="show" className="min-w-0 space-y-4">
      <Card className="flex items-start gap-3 border-primary/20 bg-primary/[0.06] p-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
          <Activity size={16} />
        </span>
        <p className="text-sm text-muted-foreground">
          OpenAI 流式转换会把白名单模型的 Anthropic SSE 转为 ChatCompletions SSE；保存后热重载，新请求立即生效。
        </p>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="text-sm font-semibold">模型列表 <span className="ml-2 font-normal text-muted-foreground">{enabledCount} / {models.length} 已启用</span></h2>
            <p className="mt-1 text-xs text-muted-foreground">同步保留已有模型的启用状态和协议设置，新模型默认启用。</p>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => syncFreeModels()} className="gap-2">
            <RefreshCw size={14} />同步免费模型列表
          </Button>
        </div>
        <div className="overflow-x-auto" role="region" aria-label="模型配置表，可横向滚动" tabIndex={0}>
          <table className="w-full min-w-[880px] text-left text-sm">
            <caption className="sr-only">模型状态及上游协议、流式转换和思考标签设置</caption>
            <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">模型 / 提供方</th>
                <th scope="col" className="px-4 py-3 font-medium">状态</th>
                <th scope="col" className="px-4 py-3 font-medium">Responses 上游</th>
                <th scope="col" className="px-4 py-3 font-medium">OpenAI 流式转换</th>
                <th scope="col" className="px-4 py-3 font-medium">思考标签抽取</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {models.map((model) => {
                const transformEnabled = Boolean(settings?.openAiStreamTransformModels?.includes(model.id));
                const reasoningEnabled = Boolean(settings?.reasoningTagModels?.includes(model.id));
                const responsesEnabled = Boolean(model.useResponses);
                const systemOneOnly = Boolean(model.systemOneOnly);
                return (
                  <tr key={model.id} className={cn("transition-colors hover:bg-muted/30", !model.enabled && "bg-muted/15")}>
                    <th scope="row" className="max-w-[320px] px-4 py-4 font-normal">
                      <code className="break-all text-xs font-semibold">{model.id}</code>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="break-all">{model.ownedBy}</span>
                        {systemOneOnly && <Badge variant="muted">System One</Badge>}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground/70" title="上游创建时间戳">{model.created}</div>
                    </th>
                    <td className="whitespace-nowrap px-4 py-4">
                      <Badge variant={model.enabled ? "success" : "muted"}>{model.enabled ? "启用" : "禁用"}</Badge>
                    </td>
                    <td className="px-4 py-4">
                      <ModelSetting label={`${model.id} 使用 Responses 上游`} desc={systemOneOnly ? "仅支持 /v1/systemone" : responsesEnabled ? "/responses" : "Chat Completions"} checked={responsesEnabled} disabled={busy || systemOneOnly} onToggle={() => toggleUseResponses(model)} />
                    </td>
                    <td className="px-4 py-4">
                      <ModelSetting label={`${model.id} OpenAI 流式转换`} desc={transformEnabled ? "Anthropic → OpenAI" : "直通上游 SSE"} checked={transformEnabled} disabled={busy || !settings} onToggle={() => toggleOpenAiStreamTransform(model)} />
                    </td>
                    <td className="px-4 py-4">
                      <ModelSetting label={`${model.id} 思考标签抽取`} desc={reasoningEnabled ? "reasoning_content" : "保留原始标签"} checked={reasoningEnabled} disabled={busy || !settings} onToggle={() => toggleReasoningTag(model)} />
                    </td>
                    <td className="px-4 py-4 text-right">
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => toggleModel(model)} aria-label={`${model.enabled ? "禁用" : "启用"}模型 ${model.id}`}>
                        {model.enabled ? "禁用模型" : "启用模型"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {models.length === 0 && <tr><td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">暂无模型，点击「同步免费模型列表」获取。</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </motion.div>
  );
}

function ModelSetting({ label, desc, checked, disabled, onToggle }: {
  label: string;
  desc: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer flex-col items-start gap-2">
      <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onToggle} />
      <span className="whitespace-nowrap text-[11px] text-muted-foreground">{desc}</span>
    </label>
  );
}
