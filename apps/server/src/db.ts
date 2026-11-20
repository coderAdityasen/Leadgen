/**
 * Database layer: one async API over two engines.
 *
 *   local  — a SQLite file through better-sqlite3 (VPS / your own PC).        url: file:<path>
 *   remote — Turso / libSQL server through @libsql/client (free cloud setup).  url: libsql://… or https://…
 *
 * The rest of the server only sees `Db`:
 *
 *   const row = (await db.prepare("SELECT * FROM lead WHERE id = ?").get(id)) as LeadRow | undefined;
 *   await db.prepare("UPDATE lead SET name = ? WHERE id = ?").run(name, id);
 *   await db.transaction(async () => { ...more awaited db calls... });
 *
 * Statements inside `transaction()` run inside that transaction automatically (the active
 * transaction is tracked with AsyncLocalStorage), so code reads the same as with better-sqlite3.
 *
 * Concurrency: better-sqlite3 was synchronous, so every request handler ran without interleaving.
 * To keep that guarantee for transactions, each Db serializes its transactions. In local mode
 * every statement also goes through the same lock, because a local transaction lives on the one
 * shared connection and an unrelated statement must never land inside it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { createClient, type Client as LibsqlClient, type InValue, type Transaction as LibsqlTx } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = join(here, "../migrations");

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  get(...args: unknown[]): Promise<unknown>;
  all(...args: unknown[]): Promise<unknown[]>;
  run(...args: unknown[]): Promise<RunResult>;
}

type Args = unknown[] | Record<string, unknown>;
type Mode = "get" | "all" | "run";

/** Engine-specific part: runs one statement or a script on a connection or open transaction. */
interface Runner {
  query(sql: string, args: Args, mode: Mode): Promise<unknown>;
  script(sql: string): Promise<void>;
}
interface TxRunner extends Runner {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
interface Engine extends Runner {
  readonly kind: "local" | "remote";
  begin(): Promise<TxRunner>;
  close(): Promise<void>;
  backupTo(path: string): Promise<void>;
}

/** better-sqlite3 style arguments: positional values, one array, or one object of named values. */
function normalizeArgs(args: unknown[]): Args {
  if (args.length === 1) {
    const only = args[0];
    if (Array.isArray(only)) return only.map(toSqlValue);
    if (only && typeof only === "object" && !Buffer.isBuffer(only) && !(only instanceof Uint8Array)) {
      const named: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(only)) named[k] = toSqlValue(v);
      return named;
    }
  }
  return args.map(toSqlValue);
}

function toSqlValue(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

// ---------- engines ----------

class LocalEngine implements Engine {
  readonly kind = "local" as const;
  constructor(private readonly conn: BetterSqlite3.Database) {}

  async query(sql: string, args: Args, mode: Mode) {
    const stmt = this.conn.prepare(sql);
    const a = Array.isArray(args) ? args : [args];
    if (mode === "get") return stmt.get(...a);
    if (mode === "all") return stmt.all(...a);
    const info = stmt.run(...a);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid } satisfies RunResult;
  }
  async script(sql: string) {
    this.conn.exec(sql);
  }
  async begin(): Promise<TxRunner> {
    this.conn.exec("BEGIN IMMEDIATE");
    return {
      query: (sql, args, mode) => this.query(sql, args, mode),
      script: (sql) => this.script(sql),
      commit: async () => void this.conn.exec("COMMIT"),
      rollback: async () => {
        if (this.conn.inTransaction) this.conn.exec("ROLLBACK");
      },
    };
  }
  async close() {
    this.conn.close();
  }
  async backupTo(path: string) {
    await this.conn.backup(path);
  }
}

function plainRow(columns: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    const v = row[col];
    out[col] = v instanceof ArrayBuffer ? Buffer.from(v) : typeof v === "bigint" ? Number(v) : v;
  }
  return out;
}

async function remoteQuery(target: LibsqlClient | LibsqlTx, sql: string, args: Args, mode: Mode) {
  const rs = await target.execute({ sql, args: args as InValue[] | Record<string, InValue> });
  if (mode === "run") {
    return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid ?? 0 } satisfies RunResult;
  }
  const rows = rs.rows.map((r) => plainRow(rs.columns, r as unknown as Record<string, unknown>));
  return mode === "get" ? rows[0] : rows;
}

class RemoteEngine implements Engine {
  readonly kind = "remote" as const;
  constructor(private readonly client: LibsqlClient) {}

  query(sql: string, args: Args, mode: Mode) {
    return remoteQuery(this.client, sql, args, mode);
  }
  async script(sql: string) {
    await this.client.executeMultiple(sql);
  }
  async begin(): Promise<TxRunner> {
    const tx = await this.client.transaction("write");
    return {
      query: (sql, args, mode) => remoteQuery(tx, sql, args, mode),
      script: async (sql) => void (await tx.executeMultiple(sql)),
      commit: () => tx.commit(),
      rollback: async () => {
        if (!tx.closed) await tx.rollback();
      },
    };
  }
  async close() {
    this.client.close();
  }
  async backupTo() {
    // Turso keeps its own point-in-time restore; nothing to copy from here.
  }
}

// ---------- the Db everyone uses ----------

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

interface TxContext {
  db: Db;
  runner: TxRunner;
  active: boolean;
}
const txStore = new AsyncLocalStorage<TxContext>();

export class Db {
  private readonly lock = new Mutex();
  constructor(
    private readonly engine: Engine,
    /** where this database lives (file path or URL without token), for logs */
    readonly location: string
  ) {}

  get kind(): "local" | "remote" {
    return this.engine.kind;
  }

  private activeTx(): TxRunner | null {
    const ctx = txStore.getStore();
    return ctx && ctx.db === this && ctx.active ? ctx.runner : null;
  }

  private exec<T>(fn: (r: Runner) => Promise<T>): Promise<T> {
    const tx = this.activeTx();
    if (tx) return fn(tx);
    // Remote statements are independent requests; local ones share the transaction's connection.
    if (this.engine.kind === "remote") return fn(this.engine);
    return this.lock.run(() => fn(this.engine));
  }

  prepare(sql: string): Statement {
    return {
      get: (...args) => this.exec((r) => r.query(sql, normalizeArgs(args), "get")),
      all: (...args) => this.exec((r) => r.query(sql, normalizeArgs(args), "all")) as Promise<unknown[]>,
      run: (...args) => this.exec((r) => r.query(sql, normalizeArgs(args), "run")) as Promise<RunResult>,
    };
  }

  /** Run a script of one or more statements (migrations). */
  execScript(sql: string): Promise<void> {
    return this.exec((r) => r.script(sql));
  }

  /**
   * Run `fn` in a write transaction. Commits when it resolves, rolls back when it throws.
   * Nested calls on the same database join the outer transaction.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeTx()) return fn();
    return this.lock.run(async () => {
      const runner = await this.engine.begin();
      const ctx: TxContext = { db: this, runner, active: true };
      try {
        const result = await txStore.run(ctx, fn);
        ctx.active = false;
        await runner.commit();
        return result;
      } catch (err) {
        ctx.active = false;
        try {
          await runner.rollback();
        } catch {
          // keep the original error
        }
        throw err;
      }
    });
  }

  /** Online copy of a local database to `path`. Remote (Turso) databases are skipped. */
  backupTo(path: string): Promise<void> {
    if (this.engine.kind === "remote") return Promise.resolve();
    return this.lock.run(() => this.engine.backupTo(path));
  }

  close(): Promise<void> {
    return this.engine.close();
  }
}

// ---------- opening ----------

export interface DbOptions {
  /**
   * `file:<path>`, a plain file path, `:memory:`, or a `libsql://` / `https://` URL.
   * Defaults to DATABASE_URL, then DATABASE_PATH, then data/leaddesk.sqlite.
   */
  url?: string;
  /** alias of `url` for a local file path */
  path?: string;
  authToken?: string;
  migrationsDir?: string;
}

export function isRemoteUrl(url: string): boolean {
  return /^(libsql|https?|wss?):\/\//i.test(url);
}

/** Local file path for a `file:` URL or plain path (relative paths resolve from the working dir). */
export function localPathOf(url: string): string {
  const raw = url.startsWith("file:") ? url.slice("file:".length).replace(/^\/\/(?=\/?[A-Za-z]:)/, "") : url;
  if (raw === ":memory:") return raw;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

export function defaultDatabaseUrl(): string {
  return (
    process.env["DATABASE_URL"]?.trim() ||
    process.env["DATABASE_PATH"]?.trim() ||
    join(process.cwd(), "data/leaddesk.sqlite")
  );
}

/** Open a database without running migrations. */
export async function connectDb(url: string, authToken?: string): Promise<Db> {
  if (isRemoteUrl(url)) {
    const client = createClient({ url, authToken, intMode: "number" });
    const db = new Db(new RemoteEngine(client), url.replace(/\?.*$/, ""));
    // Foreign keys are a per-connection setting; ask for them (the server may ignore it).
    await db.prepare("PRAGMA foreign_keys = ON").run().catch(() => {});
    return db;
  }
  const path = localPathOf(url);
  if (process.env["LEAD_DESK_TEST_LIBSQL_ENGINE"] === "1") {
    // Test-only: run the Turso code path (@libsql/client) against a local file, so the whole
    // suite can exercise it without a Turso account. ":memory:" becomes a fresh temp file.
    const file =
      path === ":memory:" ? join(tmpdir(), `leaddesk-libsql-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`) : path;
    mkdirSync(dirname(file), { recursive: true });
    const client = createClient({ url: pathToFileURL(file).href, intMode: "number" });
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
    const db = new Db(new RemoteEngine(client), file);
    await db.prepare("PRAGMA foreign_keys = ON").run();
    return db;
  }
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const conn = new BetterSqlite3(path);
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");
  return new Db(new LocalEngine(conn), path);
}

/** Open (creating if needed) an account database and bring its schema up to date. */
export async function openDb(options: DbOptions = {}): Promise<Db> {
  const explicit = options.url ?? options.path;
  const url = explicit ?? defaultDatabaseUrl();
  const authToken = options.authToken ?? (explicit ? undefined : process.env["DATABASE_AUTH_TOKEN"]?.trim());
  const db = await connectDb(url, authToken || undefined);
  await runMigrations(db, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  return db;
}

export async function runMigrations(db: Db, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Promise<number> {
  await db.execScript(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = (await db.prepare("SELECT version FROM schema_migration ORDER BY version ASC").all()) as {
    version: number;
  }[];
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match || !match[1]) continue;
    const version = parseInt(match[1], 10);
    if (appliedSet.has(version)) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await db.transaction(async () => {
      await db.execScript(sql);
      await db.prepare("INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)").run(version, Date.now());
    });
    count++;
  }

  return count;
}
