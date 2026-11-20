/** Super-admin panel API: clients (accounts), their billing, and plans. */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { generateUlid } from "@leaddesk/shared";
import { requireSuperAdmin, type AppUserRow } from "../auth.js";
import {
  RazorpayError,
  billingState,
  createRazorpayPlan,
  formatPayment,
  formatPlan,
  graceDays,
  razorpayConfig,
  DAY_MS,
  type PaymentRow,
  type PlanRow,
} from "../billing.js";
import {
  audit,
  createAccount,
  formatAdminAccount,
  generatePassword,
  normalizeEmail,
  passwordProblem,
  setUserPassword,
} from "../accounts.js";
import { DEFAULT_ACCOUNT_ID, getAccount, type AccountRow } from "../tenancy.js";
import { isValidTimezone } from "./session.js";

const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message, details: {} } });

function cleanText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function cleanFeatures(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  return value
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 20);
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const control = () => app.control;

  // GET /admin/overview
  app.get("/admin/overview", async (request, reply) => {
    await requireSuperAdmin(request, reply);
    const accounts = await control().prepare("SELECT * FROM account").all() as AccountRow[];
    const counts = { total: 0, active: 0, grace: 0, expired: 0, suspended: 0, exempt: 0 };
    let mrrPaise = 0;
    const now = Date.now();
    for (const account of accounts) {
      if (account.id === DEFAULT_ACCOUNT_ID) continue; // your own desk is not a client
      counts.total++;
      const { state } = billingState(account, now);
      counts[state]++;
      if (account.plan_id && (state === "active" || state === "grace") && account.rz_subscription_status === "active") {
        const plan = await control().prepare("SELECT price_paise FROM plan WHERE id = ?").get(account.plan_id) as { price_paise: number } | undefined;
        mrrPaise += plan?.price_paise ?? 0;
      }
    }
    return reply.send({ accounts: counts, mrrPaise, razorpayEnabled: Boolean(razorpayConfig()), graceDays: graceDays() });
  });

  // GET /admin/accounts?q= — client accounts only (the admin's own desk is not a client)
  app.get("/admin/accounts", async (request, reply) => {
    await requireSuperAdmin(request, reply);
    const q = typeof (request.query as { q?: unknown })?.q === "string" ? (request.query as { q: string }).q.trim().toLowerCase() : "";
    const rows = (
      q
        ? await control()
            .prepare(
              `SELECT DISTINCT a.* FROM account a LEFT JOIN app_user u ON u.account_id = a.id
               WHERE a.id != ? AND (lower(a.name) LIKE ? OR lower(u.email) LIKE ? OR lower(u.display_name) LIKE ?)
               ORDER BY a.created_at DESC LIMIT 500`
            )
            .all(DEFAULT_ACCOUNT_ID, `%${q}%`, `%${q}%`, `%${q}%`)
        : await control().prepare("SELECT * FROM account WHERE id != ? ORDER BY created_at DESC LIMIT 500").all(DEFAULT_ACCOUNT_ID)
    ) as AccountRow[];
    return reply.send({ items: await Promise.all(rows.map((a) => formatAdminAccount(app.tenants, a))) });
  });

  // GET /admin/activity?limit=&accountId= — what admins did (create, edit, reset password, plans)
  app.get("/admin/activity", async (request, reply) => {
    await requireSuperAdmin(request, reply);
    const query = (request.query ?? {}) as { limit?: unknown; accountId?: unknown };
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const accountId = typeof query.accountId === "string" && query.accountId ? query.accountId : null;
    const rows = (await control()
      .prepare(
        `SELECT au.id, au.action, au.detail_json, au.created_at, au.account_id,
                a.name AS account_name, u.email AS actor_email, u.display_name AS actor_name
         FROM admin_audit au
         LEFT JOIN account a ON a.id = au.account_id
         LEFT JOIN app_user u ON u.id = au.actor_user_id
         WHERE (? IS NULL OR au.account_id = ?)
         ORDER BY au.created_at DESC, au.id DESC LIMIT ?`
      )
      .all(accountId, accountId, limit)) as {
      id: string;
      action: string;
      detail_json: string;
      created_at: number;
      account_id: string | null;
      account_name: string | null;
      actor_email: string | null;
      actor_name: string | null;
    }[];
    return reply.send({
      items: rows.map((r) => {
        let detail: unknown = {};
        try {
          detail = JSON.parse(r.detail_json);
        } catch {
          detail = {};
        }
        return {
          id: r.id,
          action: r.action,
          detail,
          createdAt: new Date(r.created_at).toISOString(),
          account: r.account_id ? { id: r.account_id, name: r.account_name ?? r.account_id } : null,
          actor: r.actor_email ? { email: r.actor_email, name: r.actor_name ?? r.actor_email } : null,
        };
      }),
    });
  });

  // POST /admin/accounts
  app.post("/admin/accounts", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const businessName = cleanText(body["businessName"], 120);
    const ownerName = cleanText(body["ownerName"], 100);
    const ownerEmail = normalizeEmail(body["ownerEmail"]);
    const timezone = typeof body["timezone"] === "string" && isValidTimezone(body["timezone"]) ? body["timezone"] : null;
    const country = typeof body["defaultCountry"] === "string" && /^[A-Z]{2}$/i.test(body["defaultCountry"].trim())
      ? body["defaultCountry"].trim().toUpperCase()
      : null;
    const trialDays = body["trialDays"] === undefined ? 0 : Number(body["trialDays"]);
    if (!businessName || !ownerName) return fail(reply, 400, "validation", "Business name and owner name are required.");
    if (!ownerEmail) return fail(reply, 400, "validation", "Enter a valid owner email.");
    if (!timezone) return fail(reply, 400, "validation", "Invalid timezone.");
    if (!country) return fail(reply, 400, "validation", "Country must be a 2-letter code, e.g. IN.");
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90) return fail(reply, 400, "validation", "Trial days must be 0–90.");
    let planId: string | null = null;
    if (body["planId"] !== undefined && body["planId"] !== null && body["planId"] !== "") {
      const plan = await control().prepare("SELECT id FROM plan WHERE id = ?").get(body["planId"]) as { id: string } | undefined;
      if (!plan) return fail(reply, 400, "validation", "Unknown plan.");
      planId = plan.id;
    }
    if (await control().prepare("SELECT 1 FROM app_user WHERE email = ?").get(ownerEmail)) {
      return fail(reply, 409, "email_taken", "A login with this email already exists.");
    }
    // The admin may type the first password or leave it empty to get a generated one.
    const typed = typeof body["password"] === "string" ? body["password"] : "";
    const password = typed || generatePassword();
    const problem = passwordProblem(password);
    if (problem) return fail(reply, 400, "validation", problem);

    const { account } = await createAccount(app.tenants, {
      businessName,
      ownerName,
      ownerEmail,
      password,
      timezone,
      defaultCountry: country,
      planId,
      trialDays,
    });
    await audit(control(), admin.id, account.id, "account.create", { businessName, ownerEmail, planId, trialDays });
    // The password is returned once, for the admin to hand over. Only its hash is stored.
    return reply.code(201).send({
      account: await formatAdminAccount(app.tenants, account),
      login: { email: ownerEmail, password },
    });
  });

  async function loadAccount(id: string, reply: FastifyReply): Promise<AccountRow | null> {
    const account = await getAccount(control(), id);
    if (!account) {
      fail(reply, 404, "not_found", "Client not found.");
      return null;
    }
    return account;
  }

  // GET /admin/accounts/:id
  app.get("/admin/accounts/:id", async (request, reply) => {
    await requireSuperAdmin(request, reply);
    const account = await loadAccount((request.params as { id: string }).id, reply);
    if (!account) return reply;
    const payments = (
      await control().prepare("SELECT * FROM payment WHERE account_id = ? ORDER BY paid_at DESC LIMIT 100").all(account.id) as PaymentRow[]
    ).map(formatPayment);
    return reply.send({ account: await formatAdminAccount(app.tenants, account), payments });
  });

  // PATCH /admin/accounts/:id
  app.patch("/admin/accounts/:id", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    const account = await loadAccount((request.params as { id: string }).id, reply);
    if (!account) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const args: unknown[] = [];
    const now = Date.now();

    if (body["name"] !== undefined) {
      const name = cleanText(body["name"], 120);
      if (!name) return fail(reply, 400, "validation", "Name cannot be empty.");
      sets.push("name = ?");
      args.push(name);
    }
    if (body["notes"] !== undefined) {
      if (typeof body["notes"] !== "string") return fail(reply, 400, "validation", "Notes must be text.");
      sets.push("notes = ?");
      args.push(body["notes"].slice(0, 4000));
    }
    if (body["planId"] !== undefined) {
      if (body["planId"] === null || body["planId"] === "") {
        sets.push("plan_id = NULL");
      } else {
        const plan = await control().prepare("SELECT id FROM plan WHERE id = ?").get(body["planId"]) as { id: string } | undefined;
        if (!plan) return fail(reply, 400, "validation", "Unknown plan.");
        sets.push("plan_id = ?");
        args.push(plan.id);
      }
    }
    if (body["status"] !== undefined) {
      if (body["status"] !== "active" && body["status"] !== "suspended") return fail(reply, 400, "validation", "Invalid status.");
      if (account.id === DEFAULT_ACCOUNT_ID && body["status"] === "suspended") {
        return fail(reply, 400, "validation", "You cannot suspend your own desk.");
      }
      sets.push("status = ?");
      args.push(body["status"]);
    }
    if (body["billingExempt"] !== undefined) {
      if (typeof body["billingExempt"] !== "boolean") return fail(reply, 400, "validation", "billingExempt must be true or false.");
      sets.push("billing_exempt = ?");
      args.push(body["billingExempt"] ? 1 : 0);
    }
    let paidUntil: number | null | undefined;
    if (body["paidUntil"] !== undefined) {
      if (body["paidUntil"] === null) paidUntil = null;
      else {
        const t = typeof body["paidUntil"] === "string" ? Date.parse(body["paidUntil"]) : NaN;
        if (!Number.isFinite(t)) return fail(reply, 400, "validation", "paidUntil must be an ISO date.");
        paidUntil = t;
      }
    }
    if (body["extendDays"] !== undefined) {
      const days = Number(body["extendDays"]);
      if (!Number.isInteger(days) || days < 1 || days > 366) return fail(reply, 400, "validation", "extendDays must be 1–366.");
      const base = Math.max(paidUntil ?? account.paid_until ?? 0, now);
      paidUntil = base + days * DAY_MS;
    }
    if (paidUntil !== undefined) {
      sets.push("paid_until = ?");
      args.push(paidUntil);
    }
    if (!sets.length) return fail(reply, 400, "validation", "Nothing to change.");

    await control()
      .prepare(`UPDATE account SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...args, now, account.id);
    if (body["status"] === "suspended") {
      // Sign the client out everywhere right away (devices are refused on their next call).
      try {
        await (await app.tenants.get(account.id)).prepare("UPDATE operator_session SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
      } catch {
        // ignore
      }
    }
    await audit(control(), admin.id, account.id, "account.update", body);
    return reply.send({ account: await formatAdminAccount(app.tenants, (await getAccount(control(), account.id))!) });
  });

  // POST /admin/accounts/:id/reset-password { password? } — new password for the client's login.
  // Empty password: one is generated. Returned once for the admin to hand over; all of that
  // login's sessions are signed out.
  app.post("/admin/accounts/:id/reset-password", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    const account = await loadAccount((request.params as { id: string }).id, reply);
    if (!account) return reply;
    const owner = (await control()
      .prepare("SELECT * FROM app_user WHERE account_id = ? ORDER BY CASE role WHEN 'superadmin' THEN 0 ELSE 1 END, created_at LIMIT 1")
      .get(account.id)) as AppUserRow | undefined;
    if (!owner) return fail(reply, 404, "not_found", "This client has no login.");
    const body = (request.body ?? {}) as { password?: unknown };
    const password = typeof body.password === "string" && body.password ? body.password : generatePassword();
    const problem = passwordProblem(password);
    if (problem) return fail(reply, 400, "validation", problem);
    await setUserPassword(app.tenants, owner, password);
    await audit(control(), admin.id, account.id, "account.reset_password", {});
    return reply.send({ login: { email: owner.email, password } });
  });

  // ---------- plans ----------

  app.get("/admin/plans", async (request, reply) => {
    await requireSuperAdmin(request, reply);
    const items = (await control().prepare("SELECT * FROM plan ORDER BY position, price_paise").all() as PlanRow[]).map((p) =>
      formatPlan(p, true)
    );
    return reply.send({ items, razorpayEnabled: Boolean(razorpayConfig()) });
  });

  app.post("/admin/plans", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = cleanText(body["name"], 80);
    const description = typeof body["description"] === "string" ? body["description"].trim().slice(0, 500) : "";
    const pricePaise = Number(body["pricePaise"]);
    const features = cleanFeatures(body["features"] ?? []);
    if (!name) return fail(reply, 400, "validation", "Plan name is required.");
    if (!Number.isInteger(pricePaise) || pricePaise < 100 || pricePaise > 100_000_00) {
      return fail(reply, 400, "validation", "Price must be between ₹1 and ₹1,00,000.");
    }
    if (features === null) return fail(reply, 400, "validation", "Features must be a list of text lines.");

    let razorpayPlanId = cleanText(body["razorpayPlanId"], 64);
    if (razorpayPlanId && !/^plan_[A-Za-z0-9]+$/.test(razorpayPlanId)) {
      return fail(reply, 400, "validation", "Razorpay plan ids look like plan_XXXXXXXX.");
    }
    if (!razorpayPlanId && razorpayConfig()) {
      try {
        razorpayPlanId = (await createRazorpayPlan({ name, description, amountPaise: pricePaise })).id;
      } catch (err) {
        const message = err instanceof RazorpayError ? err.description : "Could not reach Razorpay.";
        return fail(reply, 502, "payment_provider_error", `Razorpay: ${message}`);
      }
    }
    if (razorpayPlanId && await control().prepare("SELECT 1 FROM plan WHERE razorpay_plan_id = ?").get(razorpayPlanId)) {
      return fail(reply, 409, "duplicate", "Another plan already uses this Razorpay plan.");
    }
    const now = Date.now();
    const id = generateUlid("pln");
    const position = (await control().prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM plan").get() as { p: number }).p;
    await control()
      .prepare(
        `INSERT INTO plan (id, name, description, price_paise, currency, features_json, razorpay_plan_id, active, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'INR', ?, ?, 1, ?, ?, ?)`
      )
      .run(id, name, description, pricePaise, JSON.stringify(features), razorpayPlanId, position, now, now);
    await audit(control(), admin.id, null, "plan.create", { id, name, pricePaise, razorpayPlanId });
    const plan = await control().prepare("SELECT * FROM plan WHERE id = ?").get(id) as PlanRow;
    return reply.code(201).send({ plan: formatPlan(plan, true) });
  });

  app.patch("/admin/plans/:id", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    const id = (request.params as { id: string }).id;
    const plan = await control().prepare("SELECT * FROM plan WHERE id = ?").get(id) as PlanRow | undefined;
    if (!plan) return fail(reply, 404, "not_found", "Plan not found.");
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body["pricePaise"] !== undefined) {
      return fail(reply, 400, "validation", "Price cannot change. Create a new plan and deactivate this one.");
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if (body["name"] !== undefined) {
      const name = cleanText(body["name"], 80);
      if (!name) return fail(reply, 400, "validation", "Plan name is required.");
      sets.push("name = ?");
      args.push(name);
    }
    if (body["description"] !== undefined) {
      if (typeof body["description"] !== "string") return fail(reply, 400, "validation", "Description must be text.");
      sets.push("description = ?");
      args.push(body["description"].trim().slice(0, 500));
    }
    if (body["features"] !== undefined) {
      const features = cleanFeatures(body["features"]);
      if (features === null) return fail(reply, 400, "validation", "Features must be a list of text lines.");
      sets.push("features_json = ?");
      args.push(JSON.stringify(features));
    }
    if (body["active"] !== undefined) {
      if (typeof body["active"] !== "boolean") return fail(reply, 400, "validation", "active must be true or false.");
      sets.push("active = ?");
      args.push(body["active"] ? 1 : 0);
    }
    if (body["position"] !== undefined) {
      const position = Number(body["position"]);
      if (!Number.isInteger(position) || position < 0 || position > 1000) return fail(reply, 400, "validation", "Invalid position.");
      sets.push("position = ?");
      args.push(position);
    }
    if (!sets.length) return fail(reply, 400, "validation", "Nothing to change.");
    await control()
      .prepare(`UPDATE plan SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...args, Date.now(), id);
    await audit(control(), admin.id, null, "plan.update", { id, ...body });
    return reply.send({ plan: formatPlan(await control().prepare("SELECT * FROM plan WHERE id = ?").get(id) as PlanRow, true) });
  });
};
