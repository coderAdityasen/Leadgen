import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Db } from "./db.js";
import { generateUlid } from "@leaddesk/shared";
import { DEFAULT_ACCOUNT_ID, currentAccountId, getAccount } from "./tenancy.js";

export const ARGON2_OPTIONS = {
  type: 2 as const, // argon2id
  memoryCost: 19 * 1024, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export const SESSION_COOKIE = "leaddesk_session";
export const SLIDING_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const HARD_STOP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function safeCompare(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function generateToken(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

export interface OperatorRecord {
  id: string;
  password_hash: string;
  display_name: string;
  timezone: string;
  default_country: string | null;
  created_at: number;
  updated_at: number;
}

export interface OperatorSessionRecord {
  id: string;
  user_id: string | null;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  hard_expires_at: number;
  revoked_at: number | null;
}

export interface ExtensionDeviceRecord {
  id: string;
  label: string;
  token_hash: string;
  paired_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  user_agent?: string | null;
  wa_pushname?: string | null;
  wa_jid?: string | null;
  stream_mode?: string | null;
  authenticated: number;
  extension_version?: string | null;
  bridge_version?: string | null;
}

export async function requireExtensionDevice(request: FastifyRequest, reply: FastifyReply): Promise<ExtensionDeviceRecord> {
  const authHeader = request.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.code(401).send({
      error: { code: "not_authenticated", message: "Device authorization required.", details: {} },
    });
    throw new Error("not_authenticated");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const tokenHash = sha256(token);
  const db = request.server.db;

  const device = await db
    .prepare("SELECT * FROM extension_device WHERE token_hash = ? AND revoked_at IS NULL")
    .get(tokenHash) as ExtensionDeviceRecord | undefined;

  if (!device) {
    reply.code(401).send({
      error: { code: "not_authenticated", message: "Invalid or revoked device token.", details: {} },
    });
    throw new Error("not_authenticated");
  }

  const account = await getAccount(request.server.control, currentAccountId());
  if (!account || account.status === "suspended") {
    reply.code(403).send({
      error: { code: "account_suspended", message: "This account is suspended.", details: {} },
    });
    throw new Error("account_suspended");
  }

  (request as unknown as { device: ExtensionDeviceRecord }).device = device;
  return device;
}

// In-memory limiter for FAILED login attempts: 5 failures per IP per 15 minutes.
// A successful login clears the counter, so normal use never locks the operator out.
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const loginFailures = new Map<string, RateLimitEntry>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

/** Returns false when this IP has too many recent failures and must wait. */
export function checkLoginRateLimit(ip: string): boolean {
  const entry = loginFailures.get(ip);
  if (!entry) return true;
  if (Date.now() > entry.resetAt) {
    loginFailures.delete(ip);
    return true;
  }
  return entry.count < LOGIN_MAX_FAILURES;
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count++;
  }
}

export function clearLoginFailures(ip: string): void {
  loginFailures.delete(ip);
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const isSecure = process.env["LEAD_DESK_COOKIE_SECURE"] === "true";
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecure,
    maxAge: Math.floor(SLIDING_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
  });
}

export async function requireOperatorSession(request: FastifyRequest, reply: FastifyReply): Promise<OperatorRecord> {
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  if (isMutating) {
    const clientHeader = request.headers["x-leaddesk-client"];
    if (clientHeader !== "web") {
      reply.code(403).send({
        error: { code: "forbidden", message: "Missing or invalid X-LeadDesk-Client header.", details: {} },
      });
      throw new Error("forbidden");
    }
  }

  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    clearSessionCookie(reply);
    reply.code(401).send({
      error: { code: "not_authenticated", message: "Session expired.", details: {} },
    });
    throw new Error("not_authenticated");
  }

  const tokenHash = sha256(token);
  const now = Date.now();
  const db = request.server.db;

  const session = await db
    .prepare("SELECT * FROM operator_session WHERE token_hash = ? AND revoked_at IS NULL")
    .get(tokenHash) as OperatorSessionRecord | undefined;

  if (!session) {
    clearSessionCookie(reply);
    reply.code(401).send({
      error: { code: "not_authenticated", message: "Session expired.", details: {} },
    });
    throw new Error("not_authenticated");
  }

  // Check TTLs
  const isHardExpired = now >= session.hard_expires_at;
  const isSlidingExpired = now >= session.last_seen_at + SLIDING_TTL_MS;

  if (isHardExpired || isSlidingExpired) {
    await db.prepare("UPDATE operator_session SET revoked_at = ? WHERE id = ?").run(now, session.id);
    clearSessionCookie(reply);
    reply.code(401).send({
      error: { code: "not_authenticated", message: "Session expired.", details: {} },
    });
    throw new Error("not_authenticated");
  }

  // Update sliding last_seen_at
  await db.prepare("UPDATE operator_session SET last_seen_at = ? WHERE id = ?").run(now, session.id);

  const operator = await db.prepare("SELECT * FROM operator LIMIT 1").get() as OperatorRecord | undefined;
  if (!operator) {
    clearSessionCookie(reply);
    reply.code(401).send({
      error: { code: "not_authenticated", message: "Session expired.", details: {} },
    });
    throw new Error("not_authenticated");
  }

  const accountId = currentAccountId();
  const account = await getAccount(request.server.control, accountId);
  if (!account || account.status === "suspended") {
    await db.prepare("UPDATE operator_session SET revoked_at = ? WHERE id = ?").run(now, session.id);
    clearSessionCookie(reply);
    reply.code(403).send({
      error: { code: "account_suspended", message: "This account is suspended. Contact support.", details: {} },
    });
    throw new Error("account_suspended");
  }

  // Attach session info to request
  const req = request as unknown as AuthedRequest;
  req.operator = operator;
  req.sessionId = session.id;
  req.accountId = accountId;
  req.userId = session.user_id;

  return operator;
}

export interface AuthedRequest {
  operator: OperatorRecord;
  sessionId: string;
  accountId: string;
  userId: string | null;
}

export interface AppUserRow {
  id: string;
  account_id: string;
  email: string;
  display_name: string;
  role: "superadmin" | "owner";
  password_hash: string | null;
  invite_token_hash: string | null;
  invite_expires_at: number | null;
  disabled_at: number | null;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * The login behind a session. Sessions from before multi-tenancy have no user id; on the
 * default account they belong to its super admin (the original single operator).
 */
export async function sessionUser(request: FastifyRequest): Promise<AppUserRow | undefined> {
  const req = request as unknown as AuthedRequest;
  const control = request.server.control;
  if (req.userId) {
    const user = await control.prepare("SELECT * FROM app_user WHERE id = ?").get(req.userId) as AppUserRow | undefined;
    return user && user.account_id === req.accountId && !user.disabled_at ? user : undefined;
  }
  if (req.accountId !== DEFAULT_ACCOUNT_ID) return undefined;
  return await control
    .prepare("SELECT * FROM app_user WHERE account_id = ? AND role = 'superadmin' AND disabled_at IS NULL ORDER BY created_at LIMIT 1")
    .get(DEFAULT_ACCOUNT_ID) as AppUserRow | undefined;
}

/** Operator session whose login is the platform super admin. */
export async function requireSuperAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AppUserRow> {
  await requireOperatorSession(request, reply);
  const user = await sessionUser(request);
  if (!user || user.role !== "superadmin") {
    reply.code(403).send({ error: { code: "forbidden", message: "Admins only.", details: {} } });
    throw new Error("forbidden");
  }
  return user;
}
