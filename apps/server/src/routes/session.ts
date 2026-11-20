import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import type { Db } from "../db.js";
import { generateUlid } from "@leaddesk/shared";
import {
  ARGON2_OPTIONS,
  sha256,
  generateToken,
  setSessionCookie,
  clearSessionCookie,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  requireOperatorSession,
  sessionUser,
  HARD_STOP_TTL_MS,
  type AppUserRow,
  type AuthedRequest,
  type OperatorRecord,
} from "../auth.js";
import { DEFAULT_ACCOUNT_ID, getAccount, sessionTokenPrefix } from "../tenancy.js";
import { billingSummary } from "../billing.js";
import { normalizeEmail } from "../accounts.js";

export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function webOnly(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.headers["x-leaddesk-client"] !== "web") {
    reply.code(403).send({
      error: { code: "forbidden", message: "Missing or invalid X-LeadDesk-Client header.", details: {} },
    });
    return false;
  }
  return true;
}

const invalidCredentials = (reply: FastifyReply) =>
  reply.code(401).send({ error: { code: "not_authenticated", message: "Invalid credentials.", details: {} } });

/** New login session in the account's own database; the cookie carries the account for routing. */
export async function createSession(db: Db, accountId: string, userId: string | null, reply: FastifyReply): Promise<void> {
  const now = Date.now();
  const token = generateToken(sessionTokenPrefix(accountId));
  await db.prepare(
    `INSERT INTO operator_session (id, token_hash, created_at, last_seen_at, hard_expires_at, revoked_at, user_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(generateUlid("ses"), sha256(token), now, now, now + HARD_STOP_TTL_MS, userId);
  setSessionCookie(reply, token);
}

function operatorPayload(operator: OperatorRecord) {
  return { id: operator.id, displayName: operator.display_name, timezone: operator.timezone, defaultCountry: operator.default_country };
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  // There is no sign-up and no first-run setup page. The super admin login is created from the
  // environment (LEAD_DESK_ADMIN_EMAIL / LEAD_DESK_ADMIN_PASSWORD) or with `npm run admin:create`;
  // every other login is created by the admin in the admin panel (see src/accounts.ts).

  // POST /session (Login) — { email, password }
  app.post("/session", async (request, reply) => {
    if (!webOnly(request, reply)) return reply;
    const ip = request.ip || "127.0.0.1";
    if (!checkLoginRateLimit(ip)) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: "Too many login attempts. Please try again later.", details: {} },
      });
    }

    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof body.password !== "string" || !body.password) {
      recordLoginFailure(ip);
      return invalidCredentials(reply);
    }
    const control = app.control;
    let user: AppUserRow | undefined;
    if (body.email === undefined || body.email === "") {
      // Single-operator clients (and old bookmarks) sign in without an email: that is the
      // platform owner's login.
      user = await control
        .prepare("SELECT * FROM app_user WHERE role = 'superadmin' AND disabled_at IS NULL ORDER BY created_at LIMIT 1")
        .get() as AppUserRow | undefined;
    } else {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      user = await control.prepare("SELECT * FROM app_user WHERE email = ?").get(email) as AppUserRow | undefined;
    }

    const valid = user?.password_hash && !user.disabled_at ? await argon2.verify(user.password_hash, body.password) : false;
    if (!user || !valid) {
      recordLoginFailure(ip);
      return invalidCredentials(reply);
    }
    clearLoginFailures(ip);

    const account = await getAccount(control, user.account_id);
    if (!account || account.status === "suspended") {
      return reply.code(403).send({
        error: { code: "account_suspended", message: "This account is suspended. Contact support.", details: {} },
      });
    }
    const db = await app.tenants.get(account.id);
    const operator = await db.prepare("SELECT * FROM operator LIMIT 1").get() as OperatorRecord | undefined;
    if (!operator) return invalidCredentials(reply);

    const now = Date.now();
    await control.prepare("UPDATE app_user SET last_login_at = ? WHERE id = ?").run(now, user.id);
    await createSession(db, account.id, user.id, reply);
    return reply.code(200).send({ operator: operatorPayload(operator) });
  });

  // DELETE /session (Logout)
  app.delete("/session", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const sessionId = (request as unknown as AuthedRequest).sessionId;
    await app.db.prepare("UPDATE operator_session SET revoked_at = ? WHERE id = ?").run(Date.now(), sessionId);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  // GET /me
  app.get("/me", async (request, reply) => {
    const operator = await requireOperatorSession(request, reply);
    const req = request as unknown as AuthedRequest;
    const user = await sessionUser(request);
    const account = (await getAccount(app.control, req.accountId))!;
    return reply.code(200).send({
      id: operator.id,
      displayName: operator.display_name,
      timezone: operator.timezone,
      createdAt: new Date(operator.created_at).toISOString(),
      email: user?.email ?? null,
      role: user?.role ?? "owner",
      account: { id: account.id, name: account.name },
      billing: await billingSummary(app.control, account),
    });
  });

  // PATCH /me
  app.patch("/me", async (request, reply) => {
    const operator = await requireOperatorSession(request, reply);
    const body = (request.body ?? {}) as { displayName?: unknown; timezone?: unknown };

    if (body.displayName !== undefined && (typeof body.displayName !== "string" || !body.displayName.trim())) {
      return reply.code(400).send({
        error: { code: "validation", message: "displayName must be a non-empty string.", details: {} },
      });
    }
    if (body.timezone !== undefined && (typeof body.timezone !== "string" || !isValidTimezone(body.timezone))) {
      return reply.code(400).send({ error: { code: "validation", message: "Invalid IANA timezone.", details: {} } });
    }

    const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 100) : operator.display_name;
    const timezone = typeof body.timezone === "string" ? body.timezone.trim() : operator.timezone;
    const now = Date.now();
    await app.db
      .prepare("UPDATE operator SET display_name = ?, timezone = ?, updated_at = ? WHERE id = ?")
      .run(displayName, timezone, now, operator.id);
    const user = await sessionUser(request);
    if (user) await app.control.prepare("UPDATE app_user SET display_name = ?, updated_at = ? WHERE id = ?").run(displayName, now, user.id);

    return reply.code(200).send({
      id: operator.id,
      displayName,
      timezone,
      createdAt: new Date(operator.created_at).toISOString(),
    });
  });

  // POST /me/password
  app.post("/me/password", async (request, reply) => {
    const operator = await requireOperatorSession(request, reply);
    const sessionId = (request as unknown as AuthedRequest).sessionId;
    const body = (request.body ?? {}) as { currentPassword?: unknown; nextPassword?: unknown };

    if (typeof body.currentPassword !== "string" || typeof body.nextPassword !== "string" || !body.currentPassword || !body.nextPassword) {
      return reply.code(400).send({
        error: { code: "validation", message: "currentPassword and nextPassword are required.", details: {} },
      });
    }
    if (body.nextPassword.length < 12) {
      return reply.code(400).send({
        error: { code: "validation", message: "nextPassword must be at least 12 characters.", details: {} },
      });
    }

    const user = await sessionUser(request);
    const currentHash = user?.password_hash ?? operator.password_hash;
    if (!currentHash || !(await argon2.verify(currentHash, body.currentPassword))) {
      return reply.code(401).send({ error: { code: "not_authenticated", message: "Current password invalid.", details: {} } });
    }

    const now = Date.now();
    const newHash = await argon2.hash(body.nextPassword, ARGON2_OPTIONS);
    await app.db.transaction(async () => {
      await app.db.prepare("UPDATE operator SET password_hash = ?, updated_at = ? WHERE id = ?").run(newHash, now, operator.id);
      // Revoke every session except the caller
      await app.db.prepare("UPDATE operator_session SET revoked_at = ? WHERE id != ? AND revoked_at IS NULL").run(now, sessionId);
    });
    if (user) await app.control.prepare("UPDATE app_user SET password_hash = ?, updated_at = ? WHERE id = ?").run(newHash, now, user.id);

    return reply.code(204).send();
  });
};
