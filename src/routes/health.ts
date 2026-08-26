import type { FastifyInstance } from "fastify";
import type { ModelConfigStore } from "../models/catalog.js";

export const registerHealthRoutes = async (app: FastifyInstance, models: ModelConfigStore): Promise<void> => {
  app.get("/health", async () => ({
    status: "ok",
    version: "0.1.6",
    models: models.listEnabled().length,
    endpoints: ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/models"],
  }));
};
