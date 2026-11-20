/**
 * Move a whole Lead Desk installation between local SQLite files and Turso.
 *
 *   npm run db:to-turso -- --from data         local data folder  ->  Turso (free cloud setup)
 *   npm run db:to-local -- --out data          Turso              ->  local data folder (VPS)
 *
 * Both read DATABASE_URL, CONTROL_DATABASE_URL, DATABASE_AUTH_TOKEN, TURSO_ORG, TURSO_API_TOKEN
 * (and optionally TURSO_GROUP, TURSO_GROUP_AUTH_TOKEN) from the environment or a .env file.
 * Add --force to overwrite a destination that already has data.
 * Stop the server that uses the source data before copying.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { localToTurso, tursoToLocal } from "../src/transfer.js";

for (const file of [resolve(".env"), resolve("../../.env")]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const [mode, ...rest] = process.argv.slice(2);
const force = rest.includes("--force");
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const log = (line: string) => console.log(`  ${line}`);

async function main() {
  if (mode === "to-turso") {
    const dir = resolve(flag("--from") ?? "data");
    console.log(`Copying ${dir} -> Turso`);
    await localToTurso(dir, { force, log });
  } else if (mode === "to-local") {
    const dir = resolve(flag("--out") ?? "data");
    console.log(`Copying Turso -> ${dir}`);
    await tursoToLocal(dir, { force, log });
  } else {
    console.log("usage: transfer.ts to-turso --from <dir> | to-local --out <dir>  [--force]");
    process.exit(2);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
