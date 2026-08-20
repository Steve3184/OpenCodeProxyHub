import { motion } from "motion/react";
import { Activity, Coins, KeyRound, ListChecks, Network, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface StatItem {
  label: string;
  value: string;
  detail: string;
  tone: "primary" | "success" | "warning" | "info";
  icon: "shield" | "key" | "net" | "activity" | "requests" | "tokens";
}

const iconMap = { shield: ShieldCheck, key: KeyRound, net: Network, activity: Activity, requests: ListChecks, tokens: Coins };

const toneStyle: Record<StatItem["tone"], { icon: string; ring: string }> = {
  primary: { icon: "text-primary", ring: "ring-primary/25" },
  success: { icon: "text-success", ring: "ring-success/25" },
  warning: { icon: "text-warning", ring: "ring-warning/25" },
  info: { icon: "text-info", ring: "ring-info/25" },
};

export function StatCards({ items }: { items: StatItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      {items.map((item, i) => {
        const Icon = iconMap[item.icon];
        const tone = toneStyle[item.tone];
        return (
          <motion.div
            key={item.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1], delay: i * 0.05 }}
          >
            <Card className="relative overflow-hidden p-4">
              <div className="flex items-start justify-between">
                <span className="text-xs font-medium text-muted-foreground">{item.label}</span>
                <span className={cn("grid h-8 w-8 place-items-center rounded-md bg-muted/50 ring-1 ring-inset", tone.ring)}>
                  <Icon size={16} className={tone.icon} />
                </span>
              </div>
              <strong className="mt-3 block text-2xl font-semibold tracking-tight tabular-nums">{item.value}</strong>
              <small className="mt-1 block text-xs text-muted-foreground">{item.detail}</small>
              <div className="pointer-events-none absolute -right-6 -top-6 h-16 w-16 rounded-full bg-primary/5 blur-2xl" />
            </Card>
          </motion.div>
        );
      })}
    </div>
  );
}
