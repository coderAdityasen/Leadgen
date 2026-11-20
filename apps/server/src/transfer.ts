/**
 * Copy a whole Lead Desk installation between local SQLite files and Turso.
 *
 *   to-turso: <dir>/control.sqlite, <dir>/leaddesk.sqlite, <dir>/tenants/*.sqlite  ->  Turso
 *   to-local: Turso (the databases named in the environment)                       ->  <dir>/…
 *
 * Every destination database is created and migrated first, then each table is replaced with
 * the source rows (parents before children, multi-row inserts so remote copies stay fast).
 * The control database's account.db_file is rewritten to point at the new location.
 * The CLI lives in scripts/transfer.ts.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connectDb, isRemoteUrl, openDb, type Db } from "./db.js";
import { localTenantStorage, openControlDb, tursoTenantStorage, type AccountRow, type TenantStorage } from "./tenancy.js";

type Log = (line: string) => void;

async function tableNames(db: Db): Promise<string[]> {
  const rows = (await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' AND name NOT LIKE '_litestream%'
       ORDER BY name`
    )
    .all()) as { name: string }[];
  return rows.map((r) => r.name);
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function columns(db: Db, table: string): Promise<string[]> {
  const rows = (await db.prepare(`PRAGMA table_info(${q(table)})`).all()) as { name: string }[];
  return rows.map((r) => r.name);
}

/** Tables ordered so that every table comes after the tables its foreign keys point at. */
async function parentFirst(db: Db, tables: string[]): Promise<string[]> {
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const fks = (await db.prepare(`PRAGMA foreign_key_list(${q(t)})`).all()) as { table: string }[];
    deps.set(t, new Set(fks.map((f) => f.table).filter((p) => p !== t && tables.includes(p))));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, stack: Set<string>) => {
    if (seen.has(t) || stack.has(t)) return;
    stack.add(t);
    for (const p of deps.get(t) ?? []) visit(p, stack);
    stack.delete(t);
    seen.add(t);
    out.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return out;
}

/** Replace every table of `dst` that also exists in `src` with the rows of `src`. Returns row counts. */
export async function copyDatabase(src: Db, dst: Db): Promise<Record<string, number>> {
  const srcTables = await tableNames(src);
  const dstTables = new Set(await tableNames(dst));
  const shared = await parentFirst(src, srcTables.filter((t) => dstTables.has(t)));
  const counts: Record<string, number> = {};

  // Children first when clearing, parents first when filling: foreign keys hold at every step.
  for (const t of [...shared].reverse()) await dst.prepare(`DELETE FROM ${q(t)}`).run();

  for (const t of shared) {
    const dstCols = new Set(await columns(dst, t));
    const cols = (await columns(src, t)).filter((c) => dstCols.has(c));
    if (cols.length === 0) continue;
    const rows = (await src.prepare(`SELECT ${cols.map(q).join(", ")} FROM ${q(t)}`).all()) as Record<string, unknown>[];
    counts[t] = rows.length;
    // Stay far below SQLite's bound-parameter limit.
    const perInsert = Math.max(1, Math.floor(900 / cols.length));
    for (let i = 0; i < rows.length; i += perInsert) {
      const chunk = rows.slice(i, i + perInsert);
      const values = chunk.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ");
      const args = chunk.flatMap((row) => cols.map((c) => row[c] ?? null));
      await dst.prepare(`INSERT INTO ${q(t)} (${cols.map(q).join(", ")}) VALUES ${values}`).run(args);
    }
  }
  return counts;
}

async function hasUserData(control: Db): Promise<boolean> {
  try {
    const row = (await control.prepare("SELECT COUNT(*) AS c FROM app_user").get()) as { c: number };
    return row.c > 0;
  } catch {
    return false;
  }
}

function summary(counts: Record<string, number>): string {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const main = ["lead", "message_log", "outbound_queue", "sequence", "account", "app_user"]
    .filter((t) => counts[t] !== undefined)
    .map((t) => `${t}=${counts[t]}`)
    .join(", ");
  return `${total} rows${main ? ` (${main})` : ""}`;
}

export interface Endpoint {
  url: string;
  authToken?: string;
}

export interface TransferOptions {
  /** where the default desk database goes / comes from */
  main: Endpoint;
  control: Endpoint;
  /** how to reach / create account databases at the destination */
  tenantStorage: TenantStorage;
  /** how to open account databases at the source */
  sourceTenant: (dbFile: string) => Endpoint;
  force?: boolean;
  log?: Log;
}

/**
 * Generic copy: source (main + control + every account listed in control) to destination.
 * `dst` endpoints are created/migrated; account databases are created with `tenantStorage`.
 */
export async function transferInstallation(
  source: { main: Endpoint; control: Endpoint | null },
  options: TransferOptions
): Promise<void> {
  const log = options.log ?? (() => {});

  const dstControl = await openControlDb(options.control.url, options.control.authToken);
  if (!options.force && (await hasUserData(dstControl))) {
    await dstControl.close();
    throw new Error("The destination already has logins. Re-run with --force to overwrite it.");
  }

  // 1. Default desk (the operator's own data).
  const srcMain = await connectDb(source.main.url, source.main.authToken);
  const dstMain = await openDb({ url: options.main.url, authToken: options.main.authToken });
  log(`default desk: ${summary(await copyDatabase(srcMain, dstMain))}`);
  await srcMain.close();
  await dstMain.close();

  if (!source.control) {
    log("no control database at the source (single-operator install): it is created on first start.");
    await dstControl.close();
    return;
  }

  // 2. Control database (accounts, logins, plans, payments).
  const srcControl = await connectDb(source.control.url, source.control.authToken);
  log(`control: ${summary(await copyDatabase(srcControl, dstControl))}`);

  // 3. One database per client account.
  const accounts = (await srcControl.prepare("SELECT * FROM account WHERE db_file IS NOT NULL").all()) as AccountRow[];
  for (const account of accounts) {
    const from = options.sourceTenant(account.db_file!);
    const dbFile = await options.tenantStorage.create(account.id);
    const to = options.tenantStorage.locate(dbFile);
    const srcDb = await connectDb(from.url, from.authToken);
    const dstDb = await openDb({ url: to.url, authToken: to.authToken });
    log(`account ${account.id} (${account.name}): ${summary(await copyDatabase(srcDb, dstDb))}`);
    await dstControl.prepare("UPDATE account SET db_file = ? WHERE id = ?").run(dbFile, account.id);
    await srcDb.close();
    await dstDb.close();
  }
  await srcControl.close();
  await dstControl.close();
}

/** Local data folder -> the Turso databases named in the environment. */
export async function localToTurso(dir: string, opts: { force?: boolean; log?: Log } = {}): Promise<void> {
  const env = process.env;
  const mainUrl = env["DATABASE_URL"]?.trim();
  const controlUrl = env["CONTROL_DATABASE_URL"]?.trim();
  if (!mainUrl || !isRemoteUrl(mainUrl) || !controlUrl || !isRemoteUrl(controlUrl)) {
    throw new Error("Set DATABASE_URL and CONTROL_DATABASE_URL to libsql:// URLs (and DATABASE_AUTH_TOKEN) first.");
  }
  const token = env["DATABASE_AUTH_TOKEN"]?.trim() || undefined;
  const mainFile = join(dir, "leaddesk.sqlite");
  if (!existsSync(mainFile)) throw new Error(`${mainFile} not found.`);
  const controlFile = join(dir, "control.sqlite");
  const turso = tursoTenantStorage();
  await transferInstallation(
    { main: { url: mainFile }, control: existsSync(controlFile) ? { url: controlFile } : null },
    {
      main: { url: mainUrl, authToken: token },
      control: { url: controlUrl, authToken: env["CONTROL_DATABASE_AUTH_TOKEN"]?.trim() || token },
      tenantStorage: turso,
      sourceTenant: (dbFile) => ({ url: join(dir, dbFile) }),
      force: opts.force,
      log: opts.log,
    }
  );
}

/** The Turso databases named in the environment -> a local data folder (for a VPS). */
export async function tursoToLocal(dir: string, opts: { force?: boolean; log?: Log } = {}): Promise<void> {
  const env = process.env;
  const mainUrl = env["DATABASE_URL"]?.trim();
  const controlUrl = env["CONTROL_DATABASE_URL"]?.trim();
  if (!mainUrl || !controlUrl) throw new Error("Set DATABASE_URL and CONTROL_DATABASE_URL (the Turso ones) first.");
  const token = env["DATABASE_AUTH_TOKEN"]?.trim() || undefined;
  const mainFile = join(dir, "leaddesk.sqlite");
  if (existsSync(mainFile) && !opts.force) throw new Error(`${mainFile} already exists. Re-run with --force to overwrite it.`);
  const local = localTenantStorage(dir);
  const forceLocal: TenantStorage = {
    // --force: an existing tenant file is reused (its tables are replaced by the copy).
    create: async (id) => (opts.force ? `tenants/${id}.sqlite` : local.create(id)),
    locate: local.locate,
  };
  await transferInstallation(
    { main: { url: mainUrl, authToken: token }, control: { url: controlUrl, authToken: env["CONTROL_DATABASE_AUTH_TOKEN"]?.trim() || token } },
    {
      main: { url: mainFile },
      control: { url: join(dir, "control.sqlite") },
      tenantStorage: forceLocal,
      sourceTenant: (dbFile) => ({ url: dbFile, authToken: (env["TURSO_GROUP_AUTH_TOKEN"] || env["DATABASE_AUTH_TOKEN"])?.trim() || undefined }),
      force: true, // the empty-destination check above already ran for the main file
      log: opts.log,
    }
  );
}
