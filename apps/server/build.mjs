// Production build for the server.
//
// `@leaddesk/shared` is a workspace package that ships TypeScript source (its package.json
// points at src/index.ts). tsx, vitest and the bundlers handle that fine, but plain
// `node dist/index.js` cannot load .ts files. So the production build bundles the server
// together with @leaddesk/shared into dist/index.js, and leaves every real npm dependency
// (better-sqlite3 and argon2 are native modules) external, loaded from node_modules at runtime.
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith("@leaddesk/"));

rmSync(join(here, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [join(here, "src/index.ts")],
  outfile: join(here, "dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: [...external, ...external.map((name) => `${name}/*`)],
  logLevel: "info",
});
