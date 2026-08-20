import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Radar, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface LoginViewProps {
  draftToken: string;
  setDraftToken: (value: string) => void;
  busy: boolean;
  error: string | null;
  onLogin: (token: string) => void;
  checking?: boolean;
}

export function LoginView({ draftToken, setDraftToken, busy, error, onLogin, checking = false }: LoginViewProps) {
  const [local, setLocal] = useState(draftToken);

  useEffect(() => {
    setLocal(draftToken);
  }, [draftToken]);

  if (checking) {
    return (
      <div className="grid min-h-dvh place-items-center p-4">
        <div className="flex flex-col items-center gap-3">
          <span className="h-8 w-8 rounded-full border-2 border-primary/25 border-t-primary animate-spin" />
          <p className="text-sm text-muted-foreground">正在验证控制台凭据…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden p-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(800px_420px_at_50%_-12%,rgba(94,106,210,0.2),transparent_60%)]" />
      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="relative w-full max-w-md rounded-xl border border-border bg-card/80 p-7 shadow-2xl shadow-black/40 backdrop-blur"
        onSubmit={(event) => {
          event.preventDefault();
          setDraftToken(local);
          onLogin(local);
        }}
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/60 text-primary-content shadow-lg shadow-primary/30">
            <Radar size={22} />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">OpenCodeProxyHub</h1>
            <p className="text-xs text-muted-foreground">管理控制台登录</p>
          </div>
        </div>
        <p className="mb-5 text-sm text-muted-foreground">
          输入已配置的控制台密码。密码只用于本次登录，服务端验证后会签发临时会话令牌；生产环境请通过 HTTPS 访问控制台以保护传输安全。
        </p>
        <div className="space-y-2">
          <Label htmlFor="login-pw">控制台密码</Label>
          <Input
            id="login-pw"
            type="password"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            placeholder="输入控制台密码"
            autoFocus
          />
        </div>
        {error && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 text-sm text-destructive">
            {error}
          </motion.p>
        )}
        <Button type="submit" className="mt-5 w-full" disabled={busy}>
          {busy ? (
            <span className="h-4 w-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
          ) : (
            <ShieldCheck size={16} />
          )}
          进入控制台
        </Button>
      </motion.form>
    </div>
  );
}
