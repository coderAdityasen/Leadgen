/**
 * Multi-tenancy: one database per client account, plus a control database.
 *
 * Every existing route reads `app.db`. That property is a getter that returns the database
 * of the account the current request belongs to (held in AsyncLocalStorage for the life of the
 * request, including any async work it starts). The account is found from:
 *   - the session cookie   `ses_<accountId>.<random>`
 *   - the device token     `ld_dev_<accountId>.<random>`
 *   - a pairing code       (looked up in the control database's pairing_route table)
 * Tokens without an account part (issued before multi-tenancy) belong to the default account.
 * The account part is only routing; the token is still verified against that account's own
 * database, so it cannot be used to reach another account.
 *
 * Where account databases live (account.db_file):
 *   - a relative path such as `tenants/acc_x.sqlite` — a local SQLite file under the data dir (VPS)
 *   - a `libsql://…` URL — a Turso database, created through the Turso Platform API (cloud)
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDb, isRemoteUrl, openDb, runMigrations, type Db } from "./db.js";

export const DEFAULT_ACCOUNT_ID = "acc_default";

const here = dirname(fileURLToPath(import.meta.url));
export const CONTROL_MIGRATIONS_DIR = join(here, "../migrations-control");

export interface AccountRow {
  id: string;
  name: string;
  db_file: string | null;
  status: "active" | "suspended";
  billing_exempt: number;
  plan_id: string | null;
  paid_until: number | null;
  rz_subscription_id: string | null;
  rz_subscription_status: string | null;
  rz_pending_subscription_id: string | null;
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface TenantContext {
  accountId: string;
  db: Db;
}

export const tenantStore = new AsyncLocalStorage<TenantContext>();

export function currentTenant(): TenantContext | undefined {
  return tenantStore.getStore();
}

/** Account id of the current request (the default account outside a request). */
export function currentAccountId(): string {
  return tenantStore.getStore()?.accountId ?? DEFAULT_ACCOUNT_ID;
}

const ACCOUNT_ID = "acc_[0-9A-Za-z]{1,40}";
const SESSION_RE = new RegExp(`^ses_(${ACCOUNT_ID})\\.`);
const DEVICE_RE = new RegExp(`^ld_dev_(${ACCOUNT_ID})\\.`);

export function sessionTokenPrefix(accountId: string): string {
  return `ses_${accountId}.`;
}
export function deviceTokenPrefix(accountId: string): string {
  return `ld_dev_${accountId}.`;
}
export function accountFromSessionToken(token: string | undefined): string | null {
  return token ? SESSION_RE.exec(token)?.[1] ?? null : null;
}
export function accountFromDeviceToken(token: string | undefined): string | null {
  return token ? DEVICE_RE.exec(token)?.[1] ?? null : null;
}

// ---------- control database ----------

/** Open the control database (file path, `file:` URL, `:memory:` or Turso URL) and migrate it. */
export async function openControlDb(url: string, authToken?: string): Promise<Db> {
  const db = await connectDb(url, authToken);
  await runControlMigrations(db);
  return db;
}

export async function runControlMigrations(db: Db, dir = CONTROL_MIGRATIONS_DIR): Promise<number> {
  return await runMigrations(db, dir);
}

export async function getAccount(control: Db, accountId: string): Promise<AccountRow | undefined> {
  return (await control.prepare("SELECT * FROM account WHERE id = ?").get(accountId)) as AccountRow | undefined;
}

/** The default account always exists: it is the operator's own desk (billing exempt). */
export async function ensureDefaultAccount(control: Db, name = "My desk"): Promise<void> {
  const now = Date.now();
  await control
    .prepare(
      `INSERT OR IGNORE INTO account (id, name, db_file, status, billing_exempt, created_at, updated_at)
       VALUES (?, ?, NULL, 'active', 1, ?, ?)`
    )
    .run(DEFAULT_ACCOUNT_ID, name, now, now);
}

// ---------- where new account databases are created ----------

export interface TenantStorage {
  /** Create the (empty) database for a new account; returns what to store in account.db_file. */
  create(accountId: string): Promise<string>;
  /** Connection details for an account.db_file value (migrations are run by the registry). */
  locate(dbFile: string): { url: string; authToken?: string };
}

function tursoTenantToken(): string | undefined {
  return (process.env["TURSO_GROUP_AUTH_TOKEN"] || process.env["DATABASE_AUTH_TOKEN"])?.trim() || undefined;
}

/** Local SQLite files under `<dataDir>/tenants/` (VPS / own PC). */
export function localTenantStorage(dataDir: string): TenantStorage {
  return {
    async create(accountId) {
      const rel = join("tenants", `${accountId}.sqlite`);
      const abs = join(dataDir, rel);
      if (existsSync(abs)) throw new Error(`tenant database already exists for ${accountId}`);
      mkdirSync(dirname(abs), { recursive: true });
      return rel.replace(/\\/g, "/");
    },
    locate(dbFile) {
      return isRemoteUrl(dbFile) ? { url: dbFile, authToken: tursoTenantToken() } : { url: join(dataDir, dbFile) };
    },
  };
}

/**
 * One Turso database per account, created with the Turso Platform API.
 * Needs TURSO_API_TOKEN (`turso auth api-tokens mint leaddesk`) and TURSO_ORG, optionally
 * TURSO_GROUP (default "default"), plus a group token that opens every database in the group:
 * TURSO_GROUP_AUTH_TOKEN (`turso group tokens create default`), else DATABASE_AUTH_TOKEN.
 */
export function tursoTenantStorage(fetchImpl: typeof fetch = (...a) => fetch(...a)): TenantStorage {
  return {
    async create(accountId) {
      const apiToken = process.env["TURSO_API_TOKEN"]?.trim();
      const org = process.env["TURSO_ORG"]?.trim();
      const group = process.env["TURSO_GROUP"]?.trim() || "default";
      if (!apiToken || !org) {
        throw new Error("Creating client accounts on Turso needs TURSO_API_TOKEN and TURSO_ORG to be set.");
      }
      // Turso names: lowercase letters, digits and dashes.
      const name = `ld-${accountId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 60);
      const base = `https://api.turso.tech/v1/organizations/${encodeURIComponent(org)}/databases`;
      const headers = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
      let res = await fetchImpl(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, group }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 409) {
        // Created by an earlier, interrupted attempt (or a re-run transfer): reuse it.
        res = await fetchImpl(`${base}/${encodeURIComponent(name)}`, { headers, signal: AbortSignal.timeout(30_000) });
      }
      const data = (await res.json().catch(() => null)) as { database?: { Hostname?: string }; error?: string } | null;
      const host = data?.database?.Hostname;
      if (!res.ok || !host) {
        throw new Error(`Turso could not create the account database (${res.status}): ${data?.error ?? "no hostname returned"}`);
      }
      return `libsql://${host}`;
    },
    locate(dbFile) {
      return { url: dbFile, authToken: tursoTenantToken() };
    },
  };
}

// ---------- tenant databases ----------

export interface TenantRegistryOptions {
  control: Db;
  /** where new account databases are created */
  storage: TenantStorage;
  /** the default account's database (the existing single-desk database) */
  defaultDb: Db;
  /** run once on every tenant database when it is first opened (boot sweeps, seeding) */
  onOpen?: (accountId: string, db: Db) => Promise<unknown> | unknown;
}

export class TenantRegistry {
  private readonly open = new Map<string, Promise<Db>>();
  constructor(private readonly opts: TenantRegistryOptions) {
    this.open.set(DEFAULT_ACCOUNT_ID, Promise.resolve(opts.defaultDb));
  }

  get control(): Db {
    return this.opts.control;
  }

  /** Database of an account, opened (and migrated) on first use. Rejects for unknown accounts. */
  get(accountId: string): Promise<Db> {
    const cached = this.open.get(accountId);
    if (cached) return cached;
    const opening = this.openAccount(accountId);
    this.open.set(accountId, opening);
    // A failed open is not cached: the next request tries again.
    opening.catch(() => {
      if (this.open.get(accountId) === opening) this.open.delete(accountId);
    });
    return opening;
  }

  private async openAccount(accountId: string): Promise<Db> {
    const account = await getAccount(this.opts.control, accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    if (!account.db_file) throw new Error(`account ${accountId} has no database`);
    const { url, authToken } = this.opts.storage.locate(account.db_file);
    const db = await openDb({ url, authToken });
    try {
      await this.opts.onOpen?.(accountId, db);
    } catch {
      // boot helpers must never block access to the data
    }
    return db;
  }

  /** Create the database for a new account and return what to store in account.db_file. */
  async createTenantDb(accountId: string): Promise<string> {
    return await this.opts.storage.create(accountId);
  }

  /** Every account database (opening them as needed), for background jobs. */
  async all(): Promise<{ accountId: string; db: Db }[]> {
    const rows = (await this.opts.control.prepare("SELECT id FROM account ORDER BY created_at").all()) as { id: string }[];
    const out: { accountId: string; db: Db }[] = [];
    for (const { id } of rows) {
      try {
        out.push({ accountId: id, db: await this.get(id) });
      } catch {
        // a broken tenant database must not stop jobs for everyone else
      }
    }
    return out;
  }

  async closeAll(except?: Db): Promise<void> {
    for (const pending of this.open.values()) {
      try {
        const db = await pending;
        if (db !== except) await db.close();
      } catch {
        // ignore
      }
    }
    this.open.clear();
  }
}
