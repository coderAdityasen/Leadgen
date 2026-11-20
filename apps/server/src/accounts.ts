/**
 * Logins and client accounts.
 *
 * There is no sign-up and no first-run setup page. The super admin login comes from the
 * database: it is created once from the environment (LEAD_DESK_ADMIN_EMAIL +
 * LEAD_DESK_ADMIN_PASSWORD) or with `npm run admin:create`. The admin then creates every other
 * login in the admin panel and hands the email and password to the person.
 */
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { Db } from "./db.js";
import { generateUlid } from "@leaddesk/shared";
import { ARGON2_OPTIONS, type AppUserRow } from "./auth.js";
import { billingSummary, DAY_MS } from "./billing.js";
import { DEFAULT_ACCOUNT_ID, getAccount, type AccountRow, type TenantRegistry } from "./tenancy.js";

export const MIN_PASSWORD_LENGTH = 12;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

/** A random password that is easy to read out or type: no 0/O, 1/l/I. */
export function generatePassword(length = 16): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  // Rejection sampling keeps every character equally likely.
  const out: string[] = [];
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 256 - (256 % alphabet.length)) out.push(alphabet[b % alphabet.length]!);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

/** null when the password is acceptable, else the reason. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return "Password is too long.";
  return null;
}

export interface SuperAdminInput {
  email: string;
  password: string;
  displayName: string;
  timezone: string;
  defaultCountry: string;
}

/**
 * Create the platform super admin and the operator profile of their own desk. Only on an empty
 * install: refuses when any login (or the desk profile) already exists.
 */
export async function createSuperAdmin(control: Db, defaultDb: Db, input: SuperAdminInput): Promise<string> {
  const users = ((await control.prepare("SELECT COUNT(*) AS c FROM app_user").get()) as { c: number }).c;
  const operators = ((await defaultDb.prepare("SELECT COUNT(*) AS c FROM operator").get()) as { c: number }).c;
  if (users > 0 || operators > 0) throw new Error("An admin login already exists.");
  const problem = passwordProblem(input.password);
  if (problem) throw new Error(problem);
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("The admin email is not a valid email address.");

  const now = Date.now();
  const hash = await argon2.hash(input.password, ARGON2_OPTIONS);
  const userId = generateUlid("usr");
  await defaultDb
    .prepare(
      `INSERT INTO operator (id, password_hash, display_name, timezone, default_country, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(generateUlid("opr"), hash, input.displayName.trim().slice(0, 100), input.timezone, input.defaultCountry.toUpperCase(), now, now);
  await control
    .prepare(
      `INSERT INTO app_user (id, account_id, email, display_name, role, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'superadmin', ?, ?, ?)`
    )
    .run(userId, DEFAULT_ACCOUNT_ID, email, input.displayName.trim().slice(0, 100), hash, now, now);
  return userId;
}

/** Give a login a new password and sign out all of its sessions. */
export async function setUserPassword(tenants: TenantRegistry, user: AppUserRow, password: string): Promise<void> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const now = Date.now();
  const hash = await argon2.hash(password, ARGON2_OPTIONS);
  await tenants.control
    .prepare(
      "UPDATE app_user SET password_hash = ?, invite_token_hash = NULL, invite_expires_at = NULL, updated_at = ? WHERE id = ?"
    )
    .run(hash, now, user.id);
  try {
    const db = await tenants.get(user.account_id);
    await db.prepare("UPDATE operator_session SET revoked_at = ? WHERE revoked_at IS NULL AND user_id = ?").run(now, user.id);
    if (user.role === "superadmin") {
      // Sessions from before multi-tenancy have no user id; they belong to the super admin.
      await db.prepare("UPDATE operator_session SET revoked_at = ? WHERE revoked_at IS NULL AND user_id IS NULL").run(now);
      await db.prepare("UPDATE operator SET password_hash = ?, updated_at = ?").run(hash, now);
    }
  } catch {
    // the password is changed even if the account database is unreachable right now
  }
}

export interface NewAccountInput {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  /** the owner's first password; the admin hands it over */
  password: string;
  timezone: string;
  defaultCountry: string;
  planId: string | null;
  trialDays: number;
}

/** Create the account row, its own database (with the owner's operator profile) and the login. */
export async function createAccount(tenants: TenantRegistry, input: NewAccountInput): Promise<{ account: AccountRow; ownerId: string }> {
  const control = tenants.control;
  const problem = passwordProblem(input.password);
  if (problem) throw new Error(problem);
  const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);
  const now = Date.now();
  const accountId = generateUlid("acc");
  const ownerId = generateUlid("usr");
  const dbFile = await tenants.createTenantDb(accountId);
  const paidUntil = input.trialDays > 0 ? now + input.trialDays * DAY_MS : null;

  await control.transaction(async () => {
    await control
      .prepare(
        `INSERT INTO account (id, name, db_file, status, billing_exempt, plan_id, paid_until, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, ?, ?, ?, ?)`
      )
      .run(accountId, input.businessName, dbFile, input.planId, paidUntil, now, now);
    await control
      .prepare(
        `INSERT INTO app_user (id, account_id, email, display_name, role, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)`
      )
      .run(ownerId, accountId, input.ownerEmail, input.ownerName, passwordHash, now, now);
  });

  // Opening runs the tenant migrations (stages, policy, AI defaults); then add the profile.
  const db = await tenants.get(accountId);
  await db.prepare(
    `INSERT INTO operator (id, password_hash, display_name, timezone, default_country, created_at, updated_at)
     VALUES (?, '', ?, ?, ?, ?, ?)`
  ).run(generateUlid("opr"), input.ownerName, input.timezone, input.defaultCountry, now, now);

  return { account: (await getAccount(control, accountId))!, ownerId };
}

async function tenantStats(tenants: TenantRegistry, accountId: string) {
  try {
    const db = await tenants.get(accountId);
    const leads = (await db.prepare("SELECT COUNT(*) AS c FROM lead WHERE archived_at IS NULL").get() as { c: number }).c;
    const sentLast30d = (
      await db.prepare("SELECT COUNT(*) AS c FROM outbound_queue WHERE status = 'sent' AND sent_at > ?").get(Date.now() - 30 * DAY_MS) as {
        c: number;
      }
    ).c;
    const seen = (await db.prepare("SELECT MAX(last_seen_at) AS t FROM extension_device WHERE revoked_at IS NULL").get() as {
      t: number | null;
    }).t;
    return { leads, sentLast30d, lastDeviceSeenAt: seen ? new Date(seen).toISOString() : null };
  } catch {
    return { leads: 0, sentLast30d: 0, lastDeviceSeenAt: null };
  }
}

export async function formatAdminAccount(tenants: TenantRegistry, account: AccountRow) {
  const control = tenants.control;
  const owner = await control
    .prepare("SELECT * FROM app_user WHERE account_id = ? ORDER BY CASE role WHEN 'superadmin' THEN 0 ELSE 1 END, created_at LIMIT 1")
    .get(account.id) as AppUserRow | undefined;
  return {
    id: account.id,
    name: account.name,
    createdAt: new Date(account.created_at).toISOString(),
    notes: account.notes,
    status: account.status,
    billingExempt: Boolean(account.billing_exempt),
    owner: owner
      ? {
          id: owner.id,
          email: owner.email,
          displayName: owner.display_name,
          invitePending: !owner.password_hash,
          lastLoginAt: owner.last_login_at ? new Date(owner.last_login_at).toISOString() : null,
        }
      : null,
    billing: await billingSummary(control, account),
    stats: await tenantStats(tenants, account.id),
  };
}

export async function audit(control: Db, actorUserId: string | null, accountId: string | null, action: string, detail: unknown = {}) {
  try {
    await control
      .prepare("INSERT INTO admin_audit (id, actor_user_id, account_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(generateUlid("aud"), actorUserId, accountId, action, JSON.stringify(detail).slice(0, 4000), Date.now());
  } catch {
    // auditing must never break the action itself
  }
}
