import { useCallback, useEffect, useState } from "react";
import { apiFetch, ApiFetchError } from "../api";
import type {
  ApiKeyItem,
  ApiKeyPolicy,
  AuthMode,
  HealthPayload,
  MetricsPayload,
  ModelItem,
  ModelAliasConfig,
  ProxyDraft,
  ProxyNode,
  RuntimePayload,
  SystemSettings,
} from "../types";

export type ToastTone = "success" | "error" | "info";
export interface ToastMessage {
  id: number;
  tone: ToastTone;
  text: string;
}

let toastSeq = 0;

const copyText = async (value: string): Promise<void> => {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the legacy path for HTTP and restricted browser contexts.
    }
  }
  if (typeof document === "undefined") throw new Error("当前浏览器不支持复制到剪贴板");
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("复制失败，请手动选择并复制");
};

export function useConsoleData() {
  const [token, setToken] = useState("");
  const [draftToken, setDraftToken] = useState(() => localStorage.getItem("oph_admin_token") || "");
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);

  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelAliases, setModelAliases] = useState<ModelAliasConfig>({ onlyConfiguredAliases: false, aliases: [] });
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [proxies, setProxies] = useState<ProxyNode[]>([]);
  const [runtime, setRuntime] = useState<RuntimePayload | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsPayload | null>(null);

  const [busy, setBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const pushToast = useCallback((text: string, tone: ToastTone = "info") => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, tone, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const logout = useCallback(async (message = "已退出控制台") => {
    const activeToken = token;
    if (activeToken) {
      try {
        await apiFetch<void>("/admin/logout", activeToken, { method: "POST" });
      } catch {
        // The session may already be expired; local cleanup still applies.
      }
    }
    localStorage.removeItem("oph_admin_token");
    setToken("");
    setDraftToken("");
    setAuthMode(null);
    setApiKeys([]);
    setModels([]);
    setModelAliases({ onlyConfiguredAliases: false, aliases: [] });
    setSettings(null);
    setProxies([]);
    setRuntime(null);
    setMetricsData(null);
    pushToast(message, "info");
  }, [pushToast, token]);

  const loadPublic = useCallback(async (activeToken: string, options: { silent?: boolean } = {}) => {
    if (!options.silent) setBusy(true);
    try {
      const [healthData, publicModels] = await Promise.all([
        fetch("/health").then((res) => res.json()),
        fetch("/v1/models").then((res) => res.json()),
      ]);
      setHealth(healthData);
      if (!activeToken) return;

      const [keysData, modelsData, aliasesData, settingsData, proxiesData, runtimeData, metricsResult] = await Promise.all([
        apiFetch<{ data: ApiKeyItem[] }>("/admin/api-keys", activeToken),
        apiFetch<{ data: ModelItem[] }>("/admin/models", activeToken),
        apiFetch<{ data: ModelAliasConfig }>("/admin/model-aliases", activeToken),
        apiFetch<{ data: SystemSettings }>("/admin/settings", activeToken),
        apiFetch<{ data: ProxyNode[] }>("/admin/proxies", activeToken),
        apiFetch<{ data: RuntimePayload }>("/admin/runtime", activeToken),
        apiFetch<{ data: MetricsPayload }>("/admin/metrics", activeToken),
      ]);
      setApiKeys(keysData.data);
      setModels(modelsData.data);
      setModelAliases(aliasesData.data);
      setSettings(settingsData.data);
      setProxies(proxiesData.data);
      setRuntime(runtimeData.data);
      setMetricsData(metricsResult.data);
      if (!modelsData.data.length && Array.isArray(publicModels.data)) {
        setModels(publicModels.data.map((item: any) => ({ id: item.id, enabled: true, ownedBy: item.owned_by, created: item.created })));
      }
    } finally {
      if (!options.silent) setBusy(false);
    }
  }, []);

  const login = useCallback(async (candidate: string) => {
    const cleanToken = candidate.trim();
    if (!cleanToken) {
      setLoginError("请输入控制台密码");
      return;
    }
    setBusy(true);
    setLoginError(null);
    try {
      const session = await apiFetch<{ data: { authenticated: boolean; mode: AuthMode; token: string } }>("/admin/login", "", {
        method: "POST",
        body: JSON.stringify({ password: cleanToken }),
      });
      localStorage.setItem("oph_admin_token", session.data.token);
      setToken(session.data.token);
      setDraftToken("");
      setAuthMode(session.data.mode);
      pushToast("控制台已解锁", "success");
      await loadPublic(session.data.token);
    } catch (err) {
      localStorage.removeItem("oph_admin_token");
      setToken("");
      setAuthMode(null);
      setLoginError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setAuthChecked(true);
      setBusy(false);
    }
  }, [loadPublic, pushToast]);

  const restoreSession = useCallback(async (savedToken: string) => {
    setBusy(true);
    try {
      const session = await apiFetch<{ data: { authenticated: boolean; mode: AuthMode } }>("/admin/session", savedToken);
      if (!session.data.authenticated) throw new Error("登录状态已失效");
      setToken(savedToken);
      setAuthMode(session.data.mode);
      setDraftToken("");
      await loadPublic(savedToken);
    } catch {
      localStorage.removeItem("oph_admin_token");
      setToken("");
      setAuthMode(null);
      setDraftToken("");
    } finally {
      setAuthChecked(true);
      setBusy(false);
    }
  }, [loadPublic]);

  useEffect(() => {
    const saved = localStorage.getItem("oph_admin_token") || "";
    if (saved) {
      void restoreSession(saved);
      return;
    }
    setAuthChecked(true);
    void loadPublic("").catch((err: Error) => setLoginError(err.message));
  }, [loadPublic, restoreSession]);

  // Wraps an action: runs it, refreshes data, and routes errors (401 -> logout) to toast.
  const run = useCallback(
    async (fn: () => Promise<void>, opts: { refresh?: boolean; successText?: string } = {}) => {
      setBusy(true);
      try {
        await fn();
        if (opts.refresh !== false) await loadPublic(token);
        if (opts.successText) pushToast(opts.successText, "success");
      } catch (err) {
        if (err instanceof ApiFetchError && err.status === 401) {
          logout("登录状态已失效，请重新登录");
        } else {
          pushToast(err instanceof Error ? err.message : "操作失败", "error");
        }
      } finally {
        setBusy(false);
      }
    },
    [loadPublic, token, pushToast, logout],
  );

  // ---- API Key actions ----
  const createKey = (name: string) =>
    run(async () => {
      const result = await apiFetch<{ data: { key: string } }>("/admin/api-keys", token, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      pushToast("API key 已创建，请立即复制；之后不会再次显示明文。", "success");
      setLastCreatedKey(result.data.key);
    });

  const [lastCreatedKey, setLastCreatedKey] = useState<string | null>(null);

  const toggleKey = (item: ApiKeyItem) =>
    run(() => apiFetch(`/admin/api-keys/${item.id}`, token, { method: "PATCH", body: JSON.stringify({ enabled: !item.enabled }) }).then(() => undefined));

  const deleteKey = (item: ApiKeyItem) =>
    run(() => apiFetch(`/admin/api-keys/${item.id}`, token, { method: "DELETE" }).then(() => undefined), { successText: `已删除 API Key「${item.name}」` });

  const updateKeyPolicy = (item: ApiKeyItem, policy: ApiKeyPolicy) =>
    run(() => apiFetch(`/admin/api-keys/${item.id}`, token, { method: "PATCH", body: JSON.stringify({ policy }) }).then(() => undefined), { successText: "API Key 策略已更新" });

  const updateKeyMeta = (item: ApiKeyItem, description: string, labels: string[]) =>
    run(() => apiFetch(`/admin/api-keys/${item.id}`, token, { method: "PATCH", body: JSON.stringify({ description, labels }) }).then(() => undefined), { successText: "API Key 元数据已更新" });

  const copyCreatedKey = async () => {
    if (!lastCreatedKey) return;
    await copyText(lastCreatedKey);
    pushToast("新 API key 已复制到剪贴板", "success");
  };

  const copyStoredKey = (item: ApiKeyItem) =>
    run(
      async () => {
        if (!item.hasRecoverableKey) {
          throw new Error("该 API Key 创建时未保存明文，无法复制；请重新创建一个新 Key。");
        }
        const result = await apiFetch<{ data: { key: string } }>(`/admin/api-keys/${item.id}/secret`, token);
        await copyText(result.data.key);
      },
      { refresh: false, successText: `API Key「${item.name}」已复制到剪贴板` },
    );

  // ---- Model actions ----
  const toggleModel = (model: ModelItem) =>
    run(() =>
      apiFetch(`/admin/models/${encodeURIComponent(model.id)}`, token, {
        method: "PUT",
        body: JSON.stringify({ enabled: !model.enabled, ownedBy: model.ownedBy, created: model.created, displayName: model.displayName }),
      }).then(() => undefined),
    );

  const toggleOpenAiStreamTransform = (model: ModelItem) =>
    run(
      async () => {
        if (!settings) return;
        const current = settings.openAiStreamTransformModels || [];
        const next = current.includes(model.id) ? current.filter((id) => id !== model.id) : [...current, model.id];
        const result = await apiFetch<{ data: SystemSettings }>("/admin/settings", token, { method: "PATCH", body: JSON.stringify({ openAiStreamTransformModels: next }) });
        setSettings(result.data);
        pushToast(`OpenAI 流式转换白名单已实时${next.includes(model.id) ? "启用" : "关闭"}，新请求立即生效`, "success");
      },
      { refresh: false },
    );

  const toggleReasoningTag = (model: ModelItem) =>
    run(
      async () => {
        if (!settings) return;
        const current = settings.reasoningTagModels || [];
        const next = current.includes(model.id) ? current.filter((id) => id !== model.id) : [...current, model.id];
        const result = await apiFetch<{ data: SystemSettings }>("/admin/settings", token, { method: "PATCH", body: JSON.stringify({ reasoningTagModels: next }) });
        setSettings(result.data);
        pushToast(`思考标签抽取已实时${next.includes(model.id) ? "启用" : "关闭"}，新请求立即生效`, "success");
      },
      { refresh: false },
    );

  const syncFreeModels = () =>
    run(() => apiFetch<{ data: { synced: number; models: string[] } }>("/admin/models/sync-free", token, { method: "POST" }).then((result) => {
      pushToast(`成功同步 ${result.data.synced} 个免费模型`, "success");
    }), { successText: undefined });

  const updateModelAliases = (config: ModelAliasConfig) =>
    run(
      async () => {
        const result = await apiFetch<{ data: ModelAliasConfig }>("/admin/model-aliases", token, {
          method: "PUT",
          body: JSON.stringify(config),
        });
        setModelAliases(result.data);
      },
      { refresh: false, successText: "模型别名已更新" },
    );

  // ---- Settings ----
  const updateSettings = (patch: Partial<SystemSettings>) =>
    run(
      async () => {
        const result = await apiFetch<{ data: SystemSettings }>("/admin/settings", token, { method: "PATCH", body: JSON.stringify(patch) });
        setSettings(result.data);
      },
      { refresh: false, successText: "系统设置已更新" },
    );

  // ---- Proxy actions ----
  const createProxy = (draft: ProxyDraft) =>
    run(() => apiFetch("/admin/proxies", token, { method: "POST", body: JSON.stringify({ ...draft, type: draft.type as ProxyNode["type"] }) }).then(() => undefined), { successText: "代理节点已创建" });

  const toggleProxy = (proxy: ProxyNode) =>
    run(() => apiFetch(`/admin/proxies/${proxy.id}`, token, { method: "PATCH", body: JSON.stringify({ enabled: !proxy.enabled }) }).then(() => undefined));

  const testProxy = (proxy: ProxyNode) =>
    run(() => apiFetch(`/admin/proxies/${proxy.id}/test`, token, { method: "POST" }).then(() => undefined), { successText: `代理「${proxy.name}」测试成功` });

  const deleteProxy = (proxy: ProxyNode) =>
    run(() => apiFetch(`/admin/proxies/${proxy.id}`, token, { method: "DELETE" }).then(() => undefined), { successText: `已删除代理「${proxy.name}」` });

  const clearProxyStats = (proxy: ProxyNode) =>
    run(() => apiFetch(`/admin/proxies/${proxy.id}/stats/clear`, token, { method: "POST" }).then(() => undefined), { successText: `已清空代理「${proxy.name}」统计` });

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    try {
      await loadPublic(token, options);
      if (!options.silent) pushToast("已刷新数据", "success");
    } catch (err) {
      if (err instanceof ApiFetchError && err.status === 401) {
        await logout("登录状态已失效，请重新登录");
      } else if (!options.silent) {
        pushToast(err instanceof Error ? err.message : "刷新失败", "error");
      }
    }
  }, [loadPublic, logout, pushToast, token]);

  return {
    // state
    token,
    draftToken,
    setDraftToken,
    authChecked,
    authMode,
    health,
    apiKeys,
    models,
    modelAliases,
    settings,
    proxies,
    runtime,
    metricsData,
    busy,
    loginError,
    toasts,
    lastCreatedKey,
    // toast
    pushToast,
    dismissToast,
    // auth
    login,
    logout,
    // actions
    createKey,
    toggleKey,
    deleteKey,
    updateKeyPolicy,
    updateKeyMeta,
    copyCreatedKey,
    copyStoredKey,
    toggleModel,
    toggleOpenAiStreamTransform,
    toggleReasoningTag,
    syncFreeModels,
    updateModelAliases,
    updateSettings,
    createProxy,
    toggleProxy,
    testProxy,
    deleteProxy,
    clearProxyStats,
    refresh,
  };
}

export type ConsoleData = ReturnType<typeof useConsoleData>;
