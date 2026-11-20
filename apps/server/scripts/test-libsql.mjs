// Runs the whole test suite through the Turso client (@libsql/client) instead of better-sqlite3,
// using local temp files, so the cloud code path is tested without a Turso account.
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, LEAD_DESK_TEST_LIBSQL_ENGINE: "1" },
});
process.exit(result.status ?? 1);
