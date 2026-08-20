import type { ReactNode } from "react";
import { LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { View } from "../types";
import { Sidebar } from "./Sidebar";
import { Switch } from "@/components/ui/switch";

const viewTitles: Record<View, string> = {
  dashboard: "总览",
  keys: "API Key 管理",
  models: "模型",
  settings: "系统设置",
  proxy: "出口代理池",
  monitor: "运行监控",
};

interface LayoutProps {
  view: View;
  onSelect: (view: View) => void;
  busy: boolean;
  statusText: string;
  authModeLabel: string;
  onRefresh: () => void;
  autoRefresh: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  onLogout: () => void;
  children: ReactNode;
}

export function Layout({ view, onSelect, busy, statusText, authModeLabel, onRefresh, autoRefresh, onAutoRefreshChange, onLogout, children }: LayoutProps) {
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar view={view} onSelect={onSelect} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-border bg-background/70 px-4 py-3 backdrop-blur md:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">{viewTitles[view]}</h1>
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <span className={cn("inline-block h-1.5 w-1.5 rounded-full transition-colors", busy ? "bg-warning" : "bg-success")} />
              {busy ? "处理中…" : statusText}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="muted" className="hidden md:inline-flex">
              {authModeLabel}
            </Badge>
            <label className="flex items-center gap-2 text-xs text-muted-foreground" title="每 5 秒静默更新数据，不会锁定页面控件">
              <span className="hidden sm:inline">自动刷新</span>
              <Switch checked={autoRefresh} onCheckedChange={onAutoRefreshChange} aria-label="开启每 5 秒自动刷新" />
            </label>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
              <RefreshCw size={16} className={busy ? "animate-spin" : ""} />
              <span className="hidden sm:inline">刷新</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={onLogout} disabled={busy}>
              <LogOut size={16} />
              <span className="hidden sm:inline">退出</span>
            </Button>
          </div>
        </header>
        <main className="oph-scroll flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1800px] px-4 py-6 md:px-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
