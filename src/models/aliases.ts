import { JsonFileStore } from "../storage/jsonFile.js";

export interface ModelAlias {
  downstreamModelId: string;
  upstreamModelId: string;
}

export interface ModelAliasConfig {
  onlyConfiguredAliases: boolean;
  aliases: ModelAlias[];
}

interface ModelAliasFile extends ModelAliasConfig {
  version: 1;
}

export interface ModelAliasUpdateInput {
  onlyConfiguredAliases?: boolean;
  aliases?: Array<Partial<ModelAlias>>;
}

export class ModelAliasStore {
  private readonly store: JsonFileStore<ModelAliasFile>;
  private config: ModelAliasConfig = { onlyConfiguredAliases: false, aliases: [] };

  constructor(filePath: string) {
    this.store = new JsonFileStore<ModelAliasFile>(filePath);
  }

  load(): void {
    const data = this.store.read({ version: 1, onlyConfiguredAliases: false, aliases: [] });
    this.config = this.normalize(data);
    this.persist();
  }

  get(): ModelAliasConfig {
    return { onlyConfiguredAliases: this.config.onlyConfiguredAliases, aliases: this.config.aliases.map((alias) => ({ ...alias })) };
  }

  find(downstreamModelId: string): ModelAlias | null {
    const alias = this.config.aliases.find((item) => item.downstreamModelId === downstreamModelId);
    return alias ? { ...alias } : null;
  }

  resolveUpstream(downstreamModelId: string): string {
    return this.find(downstreamModelId)?.upstreamModelId || downstreamModelId;
  }

  isAllowed(downstreamModelId: string): boolean {
    return !this.config.onlyConfiguredAliases || this.config.aliases.some((alias) => alias.downstreamModelId === downstreamModelId);
  }

  update(input: ModelAliasUpdateInput): ModelAliasConfig {
    const nextAliases = input.aliases === undefined ? this.config.aliases : input.aliases.map((alias) => ({
      downstreamModelId: String(alias.downstreamModelId || "").trim(),
      upstreamModelId: String(alias.upstreamModelId || "").trim(),
    }));
    this.validateAliases(nextAliases);
    this.config = {
      onlyConfiguredAliases: input.onlyConfiguredAliases === undefined ? this.config.onlyConfiguredAliases : Boolean(input.onlyConfiguredAliases),
      aliases: nextAliases,
    };
    this.persist();
    return this.get();
  }

  private normalize(data: Partial<ModelAliasFile>): ModelAliasConfig {
    const aliases = Array.isArray(data.aliases)
      ? data.aliases.map((alias) => ({
        downstreamModelId: String(alias?.downstreamModelId || "").trim(),
        upstreamModelId: String(alias?.upstreamModelId || "").trim(),
      })).filter((alias) => alias.downstreamModelId && alias.upstreamModelId)
      : [];
    const unique: ModelAlias[] = [];
    const seen = new Set<string>();
    for (const alias of aliases) {
      if (seen.has(alias.downstreamModelId)) continue;
      seen.add(alias.downstreamModelId);
      unique.push(alias);
    }
    return { onlyConfiguredAliases: Boolean(data.onlyConfiguredAliases), aliases: unique };
  }

  private validateAliases(aliases: ModelAlias[]): void {
    if (aliases.length > 500) throw new Error("最多配置 500 个模型别名");
    const seen = new Set<string>();
    for (const alias of aliases) {
      if (!alias.downstreamModelId || !alias.upstreamModelId) throw new Error("下游模型 ID 和上游模型 ID 不能为空");
      if (alias.downstreamModelId.length > 256 || alias.upstreamModelId.length > 256) throw new Error("模型 ID 长度不能超过 256 个字符");
      if (seen.has(alias.downstreamModelId)) throw new Error(`下游模型 ID 重复：${alias.downstreamModelId}`);
      seen.add(alias.downstreamModelId);
    }
  }

  private persist(): void {
    this.store.write({ version: 1, ...this.config });
  }
}
