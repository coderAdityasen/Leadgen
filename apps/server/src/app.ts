import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { createSuperAdmin } from "./accounts.js";
import { isValidTimezone } from "./routes/session.js";
import { generateUlid } from "@leaddesk/shared";
import fastifyCookie from "@fastify/cookie";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { openDb, defaultDatabaseUrl, isRemoteUrl, localPathOf, type Db } from "./db.js";
import {
  DEFAULT_ACCOUNT_ID,
  TenantRegistry,
  accountFromDeviceToken,
  accountFromSessionToken,
  ensureDefaultAccount,
  localTenantStorage,
  openControlDb,
  tenantStore,
  tursoTenantStorage,
  type TenantStorage,
} from "./tenancy.js";
import { SESSION_COOKIE, sha256 } from "./auth.js";
import { canonicalizeCrockford } from "./routes/pairing.js";
import { billingRoutes } from "./routes/billing.js";
import { adminRoutes } from "./routes/admin.js";
import { sweepExpiredQueueRows } from "./sweeper.js";
import { performDbBackup } from "./backup.js";
import { healthRoute } from "./routes/health.js";
import { sessionRoutes } from "./routes/session.js";
import { leadsRoutes } from "./routes/leads.js";
import { policyRoutes } from "./routes/policy.js";
import { extensionOutboundRoutes } from "./routes/extensionOutbound.js";
import { outboundRoutes } from "./routes/outbound.js";
import { pairingRoutes } from "./routes/pairing.js";
import { extensionDeviceRoutes } from "./routes/extensionDevice.js";
import { sequencesRoutes } from "./routes/sequences.js";
import { inboundRoutes } from "./routes/inbound.js";
import { messagesRoutes } from "./routes/messages.js";
import { aiSettingsRoutes } from "./routes/aiSettings.js";
import { statusRoutes } from "./routes/status.js";
import { extensionCrmRoutes } from "./routes/extensionCrm.js";
import { seedApiKeyIfEmpty, sweepStaleAiPending, usingFallbackDataKey } from "./ai.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Database of the account the current request belongs to. Throws outside a request. */
    db: Db;
    /** Control database: accounts, logins, plans, payments. */
    control: Db;
    tenants: TenantRegistry;
  }
}

export interface AppOptions {
  /** the default account's database (tests pass an in-memory one) */
  db?: Db;
  controlDb?: Db;
  /** where control.sqlite, tenants/, backups/ live; defaults next to the default database */
  dataDir?: string;
  /** where new client account databases are created (default: Turso when the main db is on Turso) */
  tenantStorage?: TenantStorage;
  logLevel?: string;
  startBackgroundServices?: boolean;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? process.env["LOG_LEVEL"] ?? "info" },
    // Behind Render / Netlify the client address arrives in X-Forwarded-For: set TRUST_PROXY=true.
    trustProxy: process.env["TRUST_PROXY"] === "true" ? true : ["127.0.0.1", "::1"],
    bodyLimit: 256 * 1024,
  });

  await app.register(fastifyCookie);

  const db = options.db ?? (await openDb());
  const defaultUrl = defaultDatabaseUrl();
  const dataDir =
    options.dataDir ??
    (options.db
      ? mkdtempSync(join(tmpdir(), "leaddesk-"))
      : process.env["DATA_DIR"]?.trim()
        ? resolve(process.env["DATA_DIR"]!.trim())
        : isRemoteUrl(defaultUrl)
          ? join(process.cwd(), "data")
          : dirname(localPathOf(defaultUrl)));
  const control = options.controlDb ?? (await openControlDbFor(db, dataDir, Boolean(options.db)));
  await bootstrapControl(control, db, app.log);

  const tenants = new TenantRegistry({
    control,
    // Client account databases go to Turso when the server itself runs on Turso (DATABASE_URL).
    storage:
      options.tenantStorage ??
      (!options.db && isRemoteUrl(defaultUrl) ? tursoTenantStorage() : localTenantStorage(dataDir)),
    defaultDb: db,
    onOpen: async (_accountId, tenantDb) => await sweepStaleAiPending(tenantDb),
  });
  app.decorate("control", control);
  app.decorate("tenants", tenants);
  app.decorate("db", {
    getter() {
      const tenant = tenantStore.getStore();
      // Never fall back to some other account's data: a missing context is a bug to surface.
      if (!tenant) throw new Error("app.db used outside a request; pass the tenant database explicitly");
      return tenant.db;
    },
  });

  // Route every request to exactly one account's database (see src/tenancy.ts).
  async function resolveTenant(request: import("fastify").FastifyRequest): Promise<{ accountId: string; db: Db }> {
    let accountId: string | null = null;
    const auth = request.headers["authorization"];
    if (typeof auth === "string" && auth.startsWith("Bearer ")) accountId = accountFromDeviceToken(auth.slice(7).trim());
    if (!accountId) accountId = accountFromSessionToken(request.cookies?.[SESSION_COOKIE]);
    if (!accountId && request.method === "POST" && request.routeOptions.url === "/api/v1/extension/pair") {
      const code = (request.body as { code?: unknown } | undefined)?.code;
      if (typeof code === "string") {
        const row = (await control
          .prepare("SELECT account_id FROM pairing_route WHERE code_hash = ? AND expires_at > ?")
          .get(sha256(canonicalizeCrockford(code)), Date.now())) as { account_id: string } | undefined;
        accountId = row?.account_id ?? null;
      }
    }
    try {
      return { accountId: accountId ?? DEFAULT_ACCOUNT_ID, db: await tenants.get(accountId ?? DEFAULT_ACCOUNT_ID) };
    } catch {
      // Unknown account: route to the default desk, where the token cannot verify (-> 401).
      return { accountId: DEFAULT_ACCOUNT_ID, db };
    }
  }

  // Route every request to exactly one account database (see src/tenancy.ts). Callback style on
  // purpose: `done` runs inside tenantStore.run, so the handler and everything it awaits see it.
  app.addHook("preHandler", (request, _reply, done) => {
    resolveTenant(request).then(
      (tenant) => tenantStore.run(tenant, done),
      (err: Error) => done(err)
    );
  });

  if (usingFallbackDataKey()) {
    app.log.warn(
      "LEAD_DESK_DATA_KEY is not set: the stored AI key is encrypted with a built-in default key. Set it in .env."
    );
  }
  // Boot seed and stale pending sweep. The env AI key only seeds the operator's own desk:
  // client accounts bring their own key, never the platform's.
  await seedApiKeyIfEmpty(db);
  await sweepStaleAiPending(db);

  if (options.startBackgroundServices) {
    const sweeperTimer = setInterval(() => void runSweeps(tenants), 60_000);
    const backupTimer = startBackups(tenants, dataDir);
    app.addHook("onClose", async () => {
      clearInterval(sweeperTimer);
      clearInterval(backupTimer);
    });
  }

  app.addHook("onClose", async () => {
    await tenants.closeAll(options.db);
    if (!options.controlDb) await control.close();
    // Close db on app shutdown only if created internally
    if (!options.db) await db.close();
  });
 
  await app.register(healthRoute, { prefix: "/api/v1" });
  await app.register(sessionRoutes, { prefix: "/api/v1" });
  await app.register(leadsRoutes, { prefix: "/api/v1" });
  await app.register(policyRoutes, { prefix: "/api/v1" });
  await app.register(extensionOutboundRoutes, { prefix: "/api/v1" });
  await app.register(outboundRoutes, { prefix: "/api/v1" });
  await app.register(pairingRoutes, { prefix: "/api/v1" });
  await app.register(extensionDeviceRoutes, { prefix: "/api/v1" });
  await app.register(sequencesRoutes, { prefix: "/api/v1" });
  await app.register(inboundRoutes, { prefix: "/api/v1" });
  await app.register(messagesRoutes, { prefix: "/api/v1" });
  await app.register(aiSettingsRoutes, { prefix: "/api/v1" });
  await app.register(statusRoutes, { prefix: "/api/v1" });
  await app.register(extensionCrmRoutes, { prefix: "/api/v1" });
  await app.register(billingRoutes, { prefix: "/api/v1" });
  await app.register(adminRoutes, { prefix: "/api/v1" });

  // Static dashboard (built by Vite into ./public) + SPA fallback — registered last,
  // GET/HEAD only, never for /api/*.
  const publicDir = join(process.cwd(), "public");
  const CSP =
    // Razorpay Checkout loads its script and opens its own frames (cards, UPI, net banking).
    "default-src 'self'; script-src 'self' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; base-uri 'self'; frame-ancestors 'none'";

  app.setNotFoundHandler(async (request, reply) => {
    const isRead = request.method === "GET" || request.method === "HEAD";
    if (!isRead || request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Not found.", details: {} },
      });
    }

    // Serve a real file from public/ when the path names one (JS, CSS, fonts, images).
    const pathname = decodeURIComponentSafe(request.url.split("?")[0] ?? "/");
    if (pathname && pathname !== "/") {
      const filePath = normalize(join(publicDir, pathname));
      if (filePath.startsWith(publicDir + sep) && existsSync(filePath) && statSync(filePath).isFile()) {
        const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
        // Vite fingerprints everything under /assets/, so it can be cached forever.
        const cache = pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
        return reply.type(type).header("Cache-Control", cache).send(readFileSync(filePath));
      }
      // A missing asset must 404, not return index.html (which would be parsed as JS/CSS).
      if (extname(pathname)) {
        return reply.code(404).send({ error: { code: "not_found", message: "Not found.", details: {} } });
      }
    }

    const indexPath = join(publicDir, "index.html");
    if (!existsSync(indexPath)) {
      return reply.code(404).send({
        error: { code: "not_found", message: "SPA not built.", details: {} },
      });
    }
    reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-cache")
      .header("Content-Security-Policy", CSP);
    return reply.send(readFileSync(indexPath));
  });

  return app;
}

/**
 * Control database bootstrap:
 *  - the default account always exists;
 *  - an install upgraded from the single-operator version gets its operator as the super admin
 *    (same password);
 *  - an empty install gets its super admin from LEAD_DESK_ADMIN_EMAIL + LEAD_DESK_ADMIN_PASSWORD.
 *    There is no setup page: without those variables nobody can sign in until an admin is
 *    created (here, or with `npm run admin:create`).
 */
async function bootstrapControl(control: Db, defaultDb: Db, log: FastifyBaseLogger) {
  await ensureDefaultAccount(control);
  const users = ((await control.prepare("SELECT COUNT(*) AS c FROM app_user").get()) as { c: number }).c;
  if (users > 0) return;
  const operator = (await defaultDb.prepare("SELECT * FROM operator LIMIT 1").get()) as
    | { password_hash: string; display_name: string; created_at: number }
    | undefined;
  if (!operator) {
    const email = process.env["LEAD_DESK_ADMIN_EMAIL"]?.trim();
    const password = process.env["LEAD_DESK_ADMIN_PASSWORD"];
    if (!email || !password) {
      log.warn(
        "No admin login exists yet. Set LEAD_DESK_ADMIN_EMAIL and LEAD_DESK_ADMIN_PASSWORD and restart, or run `npm run admin:create`."
      );
      return;
    }
    try {
      await createSuperAdmin(control, defaultDb, {
        email,
        password,
        displayName: process.env["LEAD_DESK_ADMIN_NAME"]?.trim() || "Admin",
        timezone: validTimezoneOr(process.env["LEAD_DESK_ADMIN_TIMEZONE"]?.trim(), "Asia/Kolkata"),
        defaultCountry: /^[A-Za-z]{2}$/.test(process.env["LEAD_DESK_ADMIN_COUNTRY"]?.trim() ?? "")
          ? process.env["LEAD_DESK_ADMIN_COUNTRY"]!.trim().toUpperCase()
          : "IN",
      });
      log.info({ email }, "Created the admin login from LEAD_DESK_ADMIN_EMAIL / LEAD_DESK_ADMIN_PASSWORD.");
    } catch (err) {
      log.error({ err: (err as Error).message }, "Could not create the admin login from the environment.");
    }
    return;
  }
  const email = (process.env["LEAD_DESK_ADMIN_EMAIL"] ?? "admin").trim().toLowerCase() || "admin";
  const now = Date.now();
  await control
    .prepare(
      `INSERT INTO app_user (id, account_id, email, display_name, role, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'superadmin', ?, ?, ?)`
    )
    .run(generateUlid("usr"), DEFAULT_ACCOUNT_ID, email, operator.display_name, operator.password_hash, now, now);
}

/**
 * Control database location:
 *   CONTROL_DATABASE_URL (+ CONTROL_DATABASE_AUTH_TOKEN, else DATABASE_AUTH_TOKEN) when set;
 *   otherwise control.sqlite next to the default database. On Turso it must be set explicitly,
 *   because a local file on a free cloud host is wiped on every restart.
 */
async function openControlDbFor(db: Db, dataDir: string, inMemory: boolean): Promise<Db> {
  const url = process.env["CONTROL_DATABASE_URL"]?.trim();
  if (url && !inMemory) {
    const token = (process.env["CONTROL_DATABASE_AUTH_TOKEN"] || process.env["DATABASE_AUTH_TOKEN"])?.trim();
    return await openControlDb(url, token || undefined);
  }
  if (db.kind === "remote" && !inMemory) {
    throw new Error(
      "DATABASE_URL points at Turso, so CONTROL_DATABASE_URL must point at a second Turso database (see docs/deploy-free.md)."
    );
  }
  return await openControlDb(inMemory ? ":memory:" : join(dataDir, "control.sqlite"));
}

let sweeping = false;
async function runSweeps(tenants: TenantRegistry) {
  if (sweeping) return; // a slow (remote) sweep must not pile up
  sweeping = true;
  const now = Date.now();
  try {
    for (const { db } of await tenants.all()) {
      try {
        await sweepExpiredQueueRows(db);
        // Prune bookkeeping that only grows: consumed/expired pairing codes and old sessions.
        await db.prepare("DELETE FROM pairing_code WHERE expires_at < ?").run(now - 24 * 3600_000);
        await db
          .prepare("DELETE FROM operator_session WHERE hard_expires_at < ? OR revoked_at < ?")
          .run(now, now - 7 * 24 * 3600_000);
      } catch {
        // one account failing must not stop the others
      }
    }
    await tenants.control.prepare("DELETE FROM pairing_route WHERE expires_at < ?").run(now - 3600_000);
  } catch {
    // ignore
  } finally {
    sweeping = false;
  }
}

/** Daily online backups: the control database and every account (default desk keeps data/backups). */
function startBackups(tenants: TenantRegistry, dataDir: string): NodeJS.Timeout {
  const run = async () => {
    // Turso databases have their own point-in-time restore; only local files are copied.
    if (tenants.control.kind === "remote") return;
    const root = join(dataDir, "backups");
    await performDbBackup(tenants.control, join(root, "control")).catch(() => {});
    for (const { accountId, db } of await tenants.all()) {
      const dir = accountId === DEFAULT_ACCOUNT_ID ? root : join(root, accountId);
      await performDbBackup(db, dir).catch(() => {});
    }
  };
  void run().catch(() => {});
  return setInterval(() => void run().catch(() => {}), 24 * 3600_000);
}

const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function decodeURIComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function validTimezoneOr(tz: string | undefined, fallback: string): string {
  return tz && isValidTimezone(tz) ? tz : fallback;
}
