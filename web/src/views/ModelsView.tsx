import { motion } from "motion/react";
import { Activity, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { fadeIn, fadeUp, staggerContainer } from "@/lib/motion";
import type { ConsoleData } from "../hooks/useConsoleData";

export function ModelsView({ data }: { data: ConsoleData }) {
  const { models, settings, busy, toggleModel, toggleUseResponses, toggleOpenAiStreamTransform, toggleReasoningTag, syncFreeModels } = data;

  return (
    <div className="space-y-4">
      <motion.div variants={fadeIn} initial="hidden" animate="show">
        <Card className="flex items-start gap-3 border-primary/20 bg-primary/[0.06] p-4">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
            <Activity size={16} />
          </span>
          <p className="text-sm text-muted-foreground">
            OpenAI 流式转换会把白名单模型的 Anthropic SSE 转为 ChatCompletions SSE；保存后热重载，新请求立即生效。
          </p>
        </Card>
      </motion.div>

      <motion.div variants={fadeIn} initial="hidden" animate="show" className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => syncFreeModels()}
          className="gap-2"
        >
          <RefreshCw size={14} />
          同步免费模型列表
        </Button>
      </motion.div>

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        {models.map((model) => {
          const transformEnabled = Boolean(settings?.openAiStreamTransformModels?.includes(model.id));
          const reasoningEnabled = Boolean(settings?.reasoningTagModels?.includes(model.id));
          const responsesEnabled = Boolean(model.useResponses);
          return (
            <motion.div key={model.id} variants={fadeUp}>
              <Card className={cn("h-full p-4", !model.enabled && "opacity-60")}>
                <div className="flex items-start justify-between gap-2">
                  <code className="break-all text-sm font-semibold">{model.id}</code>
                  <Badge variant={model.enabled ? "success" : "muted"} className="shrink-0">
                    {model.enabled ? "启用" : "禁用"}
                  </Badge>
                </div>
                <div className="mt-2 flex gap-3 text-xs text-muted-foreground">
                  <span>{model.ownedBy}</span>
                  <span className="tabular-nums">{model.created}</span>
                </div>

                <div className="mt-4 space-y-2">
                  <SettingRow
                    title="使用 Responses 上游"
                    desc={responsesEnabled ? "全部协议自动转换并连接 /responses" : "连接上游 Chat Completions"}
                    checked={responsesEnabled}
                    disabled={busy}
                    onToggle={() => toggleUseResponses(model)}
                  />
                  <SettingRow
                    title="OpenAI 流式转换"
                    desc={transformEnabled ? "Anthropic SSE → OpenAI SSE" : "直通上游流式响应"}
                    checked={transformEnabled}
                    disabled={busy || !settings}
                    onToggle={() => toggleOpenAiStreamTransform(model)}
                  />
                  <SettingRow
                    title="思考标签抽取"
                    desc={reasoningEnabled ? "流式抽取到 reasoning_content" : "content 内含标签原样直通"}
                    checked={reasoningEnabled}
                    disabled={busy || !settings}
                    onToggle={() => toggleReasoningTag(model)}
                  />
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 w-full"
                  disabled={busy}
                  onClick={() => toggleModel(model)}
                >
                  {model.enabled ? "禁用模型" : "启用模型"}
                </Button>
              </Card>
            </motion.div>
          );
        })}
        {models.length === 0 && <p className="text-sm text-muted-foreground/70">暂无模型</p>}
      </motion.div>
    </div>
  );
}

function SettingRow({
  title,
  desc,
  checked,
  disabled,
  onToggle,
}: {
  title: string;
  desc: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{desc}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onToggle} />
    </div>
  );
}
