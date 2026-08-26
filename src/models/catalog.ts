import { JsonFileStore } from "../storage/jsonFile.js";

export const DEFAULT_MODELS = [
  "deepseek-v4-flash-free",
  "big-pickle",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "mimo-v2.5-free",
  "hy3-free",
  "laguna-s-2.1-free",
] as const;

/**
 * Models that have been retired by upstream and should be auto-disabled on
 * startup so existing deployments don't encounter 401 errors after upgrade.
 */
export const RETIRED_MODELS: ReadonlyArray<{ id: string; reason: string }> = [
  { id: "nemotron-3-super-free", reason: "Model no longer supported by upstream" },
  { id: "minimax-m3-free", reason: "Free promotion ended, now requires OpenCode Go subscription" },
  { id: "north-mini-code-free", reason: "Model no longer offered as a free model by upstream" },
  { id: "ling-3.0-flash-free", reason: "Model no longer offered as a free model by upstream" },
  { id: "longcat-2.0-free", reason: "Model no longer offered as a free model by upstream" },
];

/**
 * Models previously auto-disabled by the retirement mechanism that are
 * available again as upstream free models. On startup, entries carrying the
 * "(retired:" annotation are re-enabled and the annotation is stripped, so
 * only auto-disabled entries are touched — manual user choices are kept.
 */
export const REACTIVATED_MODELS: ReadonlySet<string> = new Set(["hy3-free"]);

export interface ModelConfig {
  id: string;
  enabled: boolean;
  ownedBy: string;
  created: number;
  displayName?: string;
  /** Route this model to the upstream OpenAI Responses endpoint. */
  useResponses?: boolean;
}

interface ModelConfigFile {
  version: 1;
  models: ModelConfig[];
}

export interface ModelUpdateInput {
  enabled?: boolean;
  ownedBy?: string;
  created?: number;
  displayName?: string;
  useResponses?: boolean;
}

export class ModelConfigStore {
  private readonly store: JsonFileStore<ModelConfigFile>;
  private models: ModelConfig[] = [];

  constructor(modelsFile: string) {
    this.store = new JsonFileStore<ModelConfigFile>(modelsFile);
  }

  load(): void {
    const data = this.store.read({ version: 1, models: [] });
    this.models = this.mergeDefaultModels(data.models);
    this.persist();
  }

  list(): ModelConfig[] {
    return this.models.map((model) => ({ ...model }));
  }

  listEnabled(): ModelConfig[] {
    return this.list().filter((model) => model.enabled);
  }

  isEnabled(modelId: string): boolean {
    return this.models.some((model) => model.id === modelId && model.enabled);
  }

  usesResponses(modelId: string): boolean {
    return this.models.some((model) => model.id === modelId && model.useResponses === true);
  }

  enabledIds(): string[] {
    return this.listEnabled().map((model) => model.id);
  }

  upsert(id: string, input: ModelUpdateInput): ModelConfig {
    const cleanId = id.trim();
    if (!cleanId) throw new Error("Model id is required");

    let model = this.models.find((item) => item.id === cleanId);
    if (!model) {
      model = { id: cleanId, enabled: true, ownedBy: "opencode-free", created: 1779000000 };
      this.models.push(model);
    }

    if (input.enabled !== undefined) model.enabled = input.enabled;
    if (input.ownedBy !== undefined) model.ownedBy = input.ownedBy.trim() || "opencode-free";
    if (input.created !== undefined) model.created = input.created;
    if (input.displayName !== undefined) model.displayName = input.displayName.trim() || undefined;
    if (input.useResponses !== undefined) model.useResponses = input.useResponses;

    this.persist();
    return { ...model };
  }

  delete(id: string): boolean {
    const before = this.models.length;
    this.models = this.models.filter((model) => model.id !== id);
    if (this.models.length === before) return false;
    this.persist();
    return true;
  }

  private defaultModels(): ModelConfig[] {
    return DEFAULT_MODELS.map((id) => ({ id, enabled: true, ownedBy: "opencode-free", created: 1779000000 }));
  }

  private mergeDefaultModels(models: ModelConfig[]): ModelConfig[] {
    const merged = [...models];
    const existingIds = new Set(merged.map((model) => model.id));
    for (const model of this.defaultModels()) {
      if (!existingIds.has(model.id)) merged.push(model);
    }
    // Auto-disable retired models on startup
    for (const retired of RETIRED_MODELS) {
      const model = merged.find((m) => m.id === retired.id);
      if (model && model.enabled) {
        model.enabled = false;
        model.displayName = `${model.displayName || model.id} (retired: ${retired.reason})`;
      }
    }
    // Re-enable models that returned to the upstream free list and were
    // previously auto-disabled via the retirement mechanism
    for (const model of merged) {
      if (!REACTIVATED_MODELS.has(model.id)) continue;
      if (model.enabled || !model.displayName?.includes("(retired:")) continue;
      model.enabled = true;
      const cleaned = model.displayName.replace(/\s*\(retired:[^)]*\)/g, "").trim();
      model.displayName = cleaned === model.id ? undefined : cleaned;
    }
    return merged;
  }

  private persist(): void {
    this.store.write({ version: 1, models: this.models });
  }
}
