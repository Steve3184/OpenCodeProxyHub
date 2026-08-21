import type { FastifyInstance } from "fastify";
import type { ModelConfigStore } from "../models/catalog.js";
import type { ModelAliasStore } from "../models/aliases.js";

export const registerModelRoutes = async (app: FastifyInstance, models: ModelConfigStore, aliases: ModelAliasStore): Promise<void> => {
  app.get("/v1/models", async () => {
    const aliasConfig = aliases.get();
    const modelMetadata = new Map(models.list().map((model) => [model.id, model]));
    const aliasModels = aliasConfig.aliases.map((alias) => ({
      id: alias.downstreamModelId,
      object: "model",
      created: modelMetadata.get(alias.upstreamModelId)?.created ?? 0,
      owned_by: modelMetadata.get(alias.upstreamModelId)?.ownedBy || "model-alias",
    }));
    const baseModels = aliasConfig.onlyConfiguredAliases ? [] : models.listEnabled().map((model) => ({
      id: model.id,
      object: "model",
      created: model.created,
      owned_by: model.ownedBy,
    }));
    const seen = new Set<string>();
    const data = [...aliasModels, ...baseModels].filter((model) => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
    return {
      object: "list",
      data,
    };
  });
};
