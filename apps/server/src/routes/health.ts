import type { FastifyInstance, FastifyPluginAsync } from "fastify";

export const healthRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get("/health", async () => ({ ok: true, version: "0.1.0" }));
};
