import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

const PORT = Number(process.env["PORT"] ?? 8787);
/** 127.0.0.1 on a VPS (Caddy in front). Cloud hosts such as Render need HOST=0.0.0.0. */
const HOST = process.env["HOST"]?.trim() || "127.0.0.1";

/**
 * Load `.env` before anything reads process.env. The README tells the operator to
 * create `.env` at the repo root, but `npm -w @leaddesk/server run start` runs with
 * cwd = apps/server, so look in both places. Variables already set in the real
 * environment win (process.loadEnvFile does not overwrite them).
 */
function loadEnvFiles(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), ".env"),
    resolve(here, "../.env"), // apps/server/.env
    resolve(here, "../../../.env"), // repo root .env
  ];
  const seen = new Set<string>();
  for (const file of candidates) {
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.error(`Failed to load env file ${file}:`, err);
    }
  }
}

async function main() {
  loadEnvFiles();
  const app = await buildApp({ startBackgroundServices: true });
  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info({ host: HOST, port: PORT }, `listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error({ err }, `Failed to bind ${HOST}:${PORT}`);
    throw err;
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
