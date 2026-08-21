import { motion } from "motion/react";
import { Activity, BarChart3, Gauge, KeyRound, Network, SlidersHorizontal, Workflow, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";
import type { View } from "../types";

const navItems: Array<{ view: View; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = [
  { view: "dashboard", label: "总览", icon: Gauge },
  { view: "keys", label: "API Keys", icon: KeyRound },
  { view: "models", label: "模型", icon: Activity },
  { view: "aliases", label: "模型别名", icon: Waypoints },
  { view: "settings", label: "设置", icon: SlidersHorizontal },
  { view: "proxy", label: "代理池", icon: Network },
  { view: "monitor", label: "监控", icon: BarChart3 },
];

const spring = { type: "spring" as const, stiffness: 520, damping: 40, mass: 0.7 };

export function Sidebar({ view, onSelect }: { view: View; onSelect: (view: View) => void }) {
  return (
    <aside className="flex w-16 shrink-0 flex-col border-r border-border bg-card/40 backdrop-blur md:w-60">
      <div className="flex items-center gap-3 px-2 py-5 md:px-4">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/60 text-primary-content shadow-md shadow-primary/30">
          <Workflow size={18} />
        </div>
        <div className="hidden flex-col leading-tight md:flex">
          <strong className="text-sm font-semibold tracking-tight">OpenCodeProxyHub</strong>
          <span className="text-[11px] text-muted-foreground">Control Plane</span>
        </div>
      </div>

      <nav className="mt-1 flex flex-1 flex-col gap-0.5 px-2 md:px-3" aria-label="Primary">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = view === item.view;
          return (
            <button
              key={item.view}
              onClick={() => onSelect(item.view)}
              title={item.label}
              className={cn(
                "relative flex items-center justify-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors md:justify-start",
                active ? "text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
                  className="absolute inset-0 rounded-md bg-accent ring-1 ring-inset ring-border"
                  transition={spring}
                />
              )}
              {active && (
                <motion.span
                  layoutId="sidebar-bar"
                  className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-primary"
                  transition={spring}
                />
              )}
              <Icon size={18} className="relative z-10 shrink-0" />
              <span className="relative z-10 hidden md:inline">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="hidden px-4 py-4 text-[11px] text-muted-foreground/60 md:block">v0.1.6 · MIT</div>
    </aside>
  );
}
