import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { setRazorpayFetch } from "../src/billing.js";
import type { Db } from "../src/db.js";
import type { FastifyInstance } from "fastify";
import { setupAdmin } from "./helpers.js";

const WEB = { "x-leaddesk-client": "web" };
const DAY = 86_400_000;

type Call = { method: string; path: string; body: any };

describe("SaaS: accounts, isolation, invites, billing, admin", () => {
  let app: FastifyInstance;
  let db: Db;
  let admin: Record<string, string>;
  let calls: Call[];
  let rzResponses: Record<string, any>;

  const cookieOf = (res: any) => `leaddesk_session=${res.cookies.find((c: any) => c.name === "leaddesk_session")!.value}`;

  beforeEach(async () => {
    process.env["LEAD_DESK_BOOTSTRAP_SECRET"] = "secret-123456789";
    process.env["RAZORPAY_KEY_ID"] = "rzp_test_key";
    process.env["RAZORPAY_KEY_SECRET"] = "rz-secret";
    process.env["RAZORPAY_WEBHOOK_SECRET"] = "wh-secret";
    process.env["LEAD_DESK_PUBLIC_URL"] = "https://desk.example.com";
    calls = [];
    rzResponses = {};
    setRazorpayFetch((async (url: string, init: any) => {
      const path = String(url).replace("https://api.razorpay.com/v1", "");
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ method: init?.method ?? "GET", path, body });
      const key = `${init?.method ?? "GET"} ${path}`;
      const data = rzResponses[key] ?? { error: { description: `no mock for ${key}` } };
      return new Response(JSON.stringify(typeof data === "function" ? data(body) : data), {
        status: rzResponses[key] ? 200 : 400,
        headers: { "content-type": "application/json" },
      });
    }) as any);

    db = await openDb({ path: ":memory:" });
    app = await buildApp({ db, logLevel: "silent" });
    const setup = await setupAdmin(app, {
        bootstrapSecret: "secret-123456789",
        email: "Owner@Example.com",
        password: "supersecretpassword123",
        displayName: "Platform Owner",
        timezone: "Asia/Kolkata",
        defaultCountry: "IN",
      });
    expect(setup.statusCode).toBe(200);
    admin = { cookie: cookieOf(setup), ...WEB };
  });

  afterEach(async () => {
    await app.close();
    for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "LEAD_DESK_PUBLIC_URL"]) delete process.env[k];
  });

  async function newClient(email = "client@shop.in", trialDays = 0) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts",
      headers: admin,
      payload: { businessName: "Shop One", ownerName: "Riya", ownerEmail: email, timezone: "Asia/Kolkata", defaultCountry: "IN", trialDays },
    });
    expect(res.statusCode).toBe(201);
    const { account, login } = res.json();
    // The admin hands these credentials to the client, who signs in on the login screen.
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: WEB,
      payload: { email: login.email, password: login.password },
    });
    expect(signedIn.statusCode).toBe(200);
    return { accountId: account.id as string, headers: { cookie: cookieOf(signedIn), ...WEB }, login };
  }

  async function pairDevice(headers: Record<string, string>) {
    const code = (await app.inject({ method: "POST", url: "/api/v1/pairing-codes", headers })).json().code;
    const pair = await app.inject({ method: "POST", url: "/api/v1/extension/pair", payload: { code, label: "Chrome" } });
    expect(pair.statusCode).toBe(201);
    return { authorization: `Bearer ${pair.json().deviceToken}`, token: pair.json().deviceToken as string };
  }

  it("super admin: /me shows role, own exempt desk; email login works", async () => {
    const me = (await app.inject({ method: "GET", url: "/api/v1/me", headers: admin })).json();
    expect(me).toMatchObject({ email: "owner@example.com", role: "superadmin", account: { id: "acc_default" } });
    expect(me.billing).toMatchObject({ state: "exempt", canSend: true });
    const login = await app.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: { email: "owner@example.com", password: "supersecretpassword123" } });
    expect(login.statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: { email: "owner@example.com", password: "wrong-password-x" } });
    expect(bad.statusCode).toBe(401);
  });

  it("admin creates the client login (generated or typed password) and can reset it", async () => {
    const { accountId, headers, login } = await newClient();
    expect(login.email).toBe("client@shop.in");
    expect(login.password).toMatch(/^[A-Za-z0-9]{16}$/);
    const me = (await app.inject({ method: "GET", url: "/api/v1/me", headers })).json();
    expect(me).toMatchObject({ role: "owner", email: "client@shop.in", account: { id: accountId, name: "Shop One" } });
    expect(me.billing.state).toBe("expired");

    // Email is case-insensitive at login.
    const upper = await app.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: { email: "CLIENT@shop.in", password: login.password } });
    expect(upper.statusCode).toBe(200);

    // A typed first password is used as given; a short one is refused.
    const typed = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts",
      headers: admin,
      payload: { businessName: "Typed", ownerName: "T", ownerEmail: "typed@shop.in", password: "my-chosen-password", timezone: "UTC", defaultCountry: "IN" },
    });
    expect(typed.json().login).toEqual({ email: "typed@shop.in", password: "my-chosen-password" });
    const short = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts",
      headers: admin,
      payload: { businessName: "Short", ownerName: "S", ownerEmail: "short@shop.in", password: "abc", timezone: "UTC", defaultCountry: "IN" },
    });
    expect(short.statusCode).toBe(400);

    // Reset: new password works, the old one and the old session stop working.
    const reset = await app.inject({ method: "POST", url: `/api/v1/admin/accounts/${accountId}/reset-password`, headers: admin, payload: {} });
    expect(reset.statusCode).toBe(200);
    const fresh = reset.json().login as { email: string; password: string };
    expect(fresh.email).toBe("client@shop.in");
    expect(fresh.password).not.toBe(login.password);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers })).statusCode).toBe(401);
    const oldPw = await app.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: { email: "client@shop.in", password: login.password } });
    expect(oldPw.statusCode).toBe(401);
    const newPw = await app.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: fresh });
    expect(newPw.statusCode).toBe(200);

    // Only the admin can create logins or reset passwords.
    const clientHeaders = { cookie: cookieOf(newPw), ...WEB };
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/admin/accounts/${accountId}/reset-password`, headers: clientHeaders, payload: {} })).statusCode
    ).toBe(403);

    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts",
      headers: admin,
      payload: { businessName: "X", ownerName: "Y", ownerEmail: "client@shop.in", timezone: "UTC", defaultCountry: "IN" },
    });
    expect(dup.statusCode).toBe(409);
  });

  it("keeps every client's data in its own database", async () => {
    const a = await newClient("a@shop.in");
    const b = await newClient("b@shop.in");
    await app.inject({ method: "POST", url: "/api/v1/leads", headers: a.headers, payload: { displayName: "Lead of A", phoneE164: "+919000000001" } });
    // The same phone number may exist in two clients' CRMs.
    const sameNumber = await app.inject({ method: "POST", url: "/api/v1/leads", headers: b.headers, payload: { displayName: "Lead of B", phoneE164: "+919000000001" } });
    expect(sameNumber.statusCode).toBe(201);

    const names = async (h: Record<string, string>) =>
      (await app.inject({ method: "GET", url: "/api/v1/leads/board", headers: h })).json().items.map((l: any) => l.displayName);
    expect(await names(a.headers)).toEqual(["Lead of A"]);
    expect(await names(b.headers)).toEqual(["Lead of B"]);
    expect(await names(admin)).toEqual([]);

    // A's lead id is unknown inside B's database.
    const aLead = (await app.inject({ method: "GET", url: "/api/v1/leads/board", headers: a.headers })).json().items[0];
    expect((await app.inject({ method: "GET", url: `/api/v1/leads/${aLead.id}`, headers: b.headers })).statusCode).toBe(404);

    // Re-labelling a real token with another account id does not get you in anywhere.
    const forged = a.headers.cookie.replace(a.accountId, b.accountId);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: forged } })).statusCode).toBe(401);

    // Devices are routed by their token too.
    const devA = await pairDevice(a.headers);
    expect(devA.token.startsWith(`ld_dev_${a.accountId}.`)).toBe(true);
    const board = (await app.inject({ method: "GET", url: "/api/v1/extension/crm/board", headers: { authorization: devA.authorization } })).json();
    expect(board.items.map((l: any) => l.displayName)).toEqual(["Lead of A"]);

    // Clients cannot reach the admin API.
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/accounts", headers: a.headers })).statusCode).toBe(403);
  });

  it("stops handing out messages when unpaid, resumes when paid, blocks suspended accounts", async () => {
    const c = await newClient();
    const dev = await pairDevice(c.headers);
    const claim = async () => (await app.inject({ method: "POST", url: "/api/v1/extension/outbound/claim", headers: dev })).json();

    expect((await claim()).reason).toBe("billing_inactive");
    await app.inject({ method: "PATCH", url: `/api/v1/admin/accounts/${c.accountId}`, headers: admin, payload: { extendDays: 30 } });
    expect((await claim()).reason).not.toBe("billing_inactive");

    // Inside the grace period sending continues; after it, it stops.
    await app.inject({ method: "PATCH", url: `/api/v1/admin/accounts/${c.accountId}`, headers: admin, payload: { paidUntil: new Date(Date.now() - DAY).toISOString() } });
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: c.headers })).json().billing.state).toBe("grace");
    expect((await claim()).reason).not.toBe("billing_inactive");
    await app.inject({ method: "PATCH", url: `/api/v1/admin/accounts/${c.accountId}`, headers: admin, payload: { paidUntil: new Date(Date.now() - 10 * DAY).toISOString() } });
    expect((await claim()).reason).toBe("billing_inactive");

    await app.inject({ method: "PATCH", url: `/api/v1/admin/accounts/${c.accountId}`, headers: admin, payload: { status: "suspended" } });
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: c.headers })).statusCode).toBe(401); // sessions revoked
    const login = await app.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: c.login });
    expect(login.json().error.code).toBe("account_suspended");
    expect((await app.inject({ method: "POST", url: "/api/v1/extension/outbound/claim", headers: dev })).statusCode).toBe(403);

    const overview = (await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: admin })).json();
    expect(overview.accounts).toMatchObject({ total: 1, suspended: 1 });
  });

  async function makePlan(name: string, pricePaise: number, rzId: string) {
    rzResponses["POST /plans"] = { id: rzId };
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/plans", headers: admin, payload: { name, pricePaise, features: ["WhatsApp CRM"] } });
    expect(res.statusCode).toBe(201);
    return res.json().plan;
  }

  const checkoutSig = (paymentId: string, subId: string) => createHmac("sha256", "rz-secret").update(`${paymentId}|${subId}`).digest("hex");

  it("subscribes through Razorpay Checkout and activates on a verified payment", async () => {
    const plan = await makePlan("Starter", 49900, "plan_S1");
    expect(plan.razorpayPlanId).toBe("plan_S1");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/plans", body: { period: "monthly", interval: 1, item: { amount: 49900, currency: "INR" } } });

    const c = await newClient();
    const billing = (await app.inject({ method: "GET", url: "/api/v1/billing", headers: c.headers })).json();
    expect(billing).toMatchObject({ razorpayEnabled: true, keyId: "rzp_test_key" });
    expect(billing.plans.map((p: any) => p.name)).toEqual(["Starter"]);

    rzResponses["POST /subscriptions"] = { id: "sub_A", status: "created", plan_id: "plan_S1" };
    const sub = (await app.inject({ method: "POST", url: "/api/v1/billing/subscribe", headers: c.headers, payload: { planId: plan.id } })).json();
    expect(sub).toMatchObject({ subscriptionId: "sub_A", keyId: "rzp_test_key", amountPaise: 49900, startsAt: null });
    expect(calls.at(-1)!.body).toMatchObject({ plan_id: "plan_S1", total_count: 120, notes: { account_id: c.accountId } });

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/billing/verify",
      headers: c.headers,
      payload: { razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_A", razorpay_signature: "00" },
    });
    expect(bad.json().error.code).toBe("bad_signature");

    const periodEnd = Math.floor((Date.now() + 30 * DAY) / 1000);
    rzResponses["GET /subscriptions/sub_A"] = { id: "sub_A", status: "active", plan_id: "plan_S1", current_end: periodEnd };
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/billing/verify",
      headers: c.headers,
      payload: { razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_A", razorpay_signature: checkoutSig("pay_1", "sub_A") },
    });
    expect(ok.json().billing).toMatchObject({
      state: "active",
      canSend: true,
      plan: { name: "Starter" },
      subscription: { id: "sub_A", status: "active" },
      paidUntil: new Date(periodEnd * 1000).toISOString(),
    });

    // Another account cannot verify this subscription as its own.
    const other = await newClient("other@shop.in");
    const stolen = await app.inject({
      method: "POST",
      url: "/api/v1/billing/verify",
      headers: other.headers,
      payload: { razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_A", razorpay_signature: checkoutSig("pay_1", "sub_A") },
    });
    expect(stolen.statusCode).toBe(400);
  });

  async function webhook(event: any, eventId: string, secret = "wh-secret") {
    const raw = JSON.stringify(event);
    return app.inject({
      method: "POST",
      url: "/api/v1/billing/razorpay/webhook",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": createHmac("sha256", secret).update(raw).digest("hex"),
        "x-razorpay-event-id": eventId,
      },
      payload: raw,
    });
  }

  it("webhooks renew, record payments once, and never extend an unpaid cycle", async () => {
    const plan = await makePlan("Starter", 49900, "plan_S1");
    const c = await newClient();
    rzResponses["POST /subscriptions"] = { id: "sub_W", status: "created", plan_id: "plan_S1" };
    await app.inject({ method: "POST", url: "/api/v1/billing/subscribe", headers: c.headers, payload: { planId: plan.id } });

    const end1 = Math.floor((Date.now() + 30 * DAY) / 1000);
    const charged = (end: number, payId: string) => ({
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_W", status: "active", plan_id: "plan_S1", current_end: end, notes: { account_id: c.accountId } } },
        payment: { entity: { id: payId, amount: 49900, status: "captured", created_at: Math.floor(Date.now() / 1000) } },
      },
    });

    expect((await webhook(charged(end1, "pay_W1"), "evt_1", "wrong")).statusCode).toBe(400);
    expect((await webhook(charged(end1, "pay_W1"), "evt_1")).json()).toEqual({ ok: true });
    expect((await webhook(charged(end1, "pay_W1"), "evt_1")).json()).toMatchObject({ duplicate: true });

    let billing = (await app.inject({ method: "GET", url: "/api/v1/billing", headers: c.headers })).json();
    expect(billing.billing).toMatchObject({ state: "active", subscription: { id: "sub_W", status: "active" } });
    expect(billing.payments).toHaveLength(1);
    expect(billing.payments[0]).toMatchObject({ amountPaise: 49900, razorpayPaymentId: "pay_W1" });

    // Renewal fails: Razorpay marks it pending with the next cycle's dates -> paid_until unchanged.
    const end2 = end1 + 30 * 86400;
    await webhook(
      { event: "subscription.pending", payload: { subscription: { entity: { id: "sub_W", status: "pending", plan_id: "plan_S1", current_end: end2 } } } },
      "evt_2"
    );
    billing = (await app.inject({ method: "GET", url: "/api/v1/billing", headers: c.headers })).json();
    expect(billing.billing.paidUntil).toBe(new Date(end1 * 1000).toISOString());
    expect(billing.billing.subscription.status).toBe("pending");

    // Retry succeeds: extended.
    await webhook(charged(end2, "pay_W2"), "evt_3");
    billing = (await app.inject({ method: "GET", url: "/api/v1/billing", headers: c.headers })).json();
    expect(billing.billing.paidUntil).toBe(new Date(end2 * 1000).toISOString());
    expect(billing.payments).toHaveLength(2);

    // An old event replayed late cannot move paid time backwards.
    await webhook(charged(end1, "pay_W1"), "evt_4");
    billing = (await app.inject({ method: "GET", url: "/api/v1/billing", headers: c.headers })).json();
    expect(billing.billing.paidUntil).toBe(new Date(end2 * 1000).toISOString());
  });

  it("switching plan while paid starts the new plan at period end and cancels the old subscription", async () => {
    const starter = await makePlan("Starter", 49900, "plan_S1");
    const pro = await makePlan("Pro", 99900, "plan_P1");
    const c = await newClient();
    rzResponses["POST /subscriptions"] = { id: "sub_1", status: "created", plan_id: "plan_S1" };
    await app.inject({ method: "POST", url: "/api/v1/billing/subscribe", headers: c.headers, payload: { planId: starter.id } });
    const end = Math.floor((Date.now() + 20 * DAY) / 1000);
    rzResponses["GET /subscriptions/sub_1"] = { id: "sub_1", status: "active", plan_id: "plan_S1", current_end: end };
    await app.inject({
      method: "POST",
      url: "/api/v1/billing/verify",
      headers: c.headers,
      payload: { razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_1", razorpay_signature: checkoutSig("pay_1", "sub_1") },
    });

    const same = await app.inject({ method: "POST", url: "/api/v1/billing/subscribe", headers: c.headers, payload: { planId: starter.id } });
    expect(same.json().error.code).toBe("already_subscribed");

    rzResponses["POST /subscriptions"] = { id: "sub_2", status: "created", plan_id: "plan_P1" };
    const sw = (await app.inject({ method: "POST", url: "/api/v1/billing/subscribe", headers: c.headers, payload: { planId: pro.id } })).json();
    expect(sw.startsAt).toBe(new Date(end * 1000).toISOString());
    expect(calls.at(-1)!.body.start_at).toBe(end);

    rzResponses["GET /subscriptions/sub_2"] = { id: "sub_2", status: "authenticated", plan_id: "plan_P1", current_end: null };
    rzResponses["POST /subscriptions/sub_1/cancel"] = { id: "sub_1", status: "cancelled", plan_id: "plan_S1" };
    const v = (
      await app.inject({
        method: "POST",
        url: "/api/v1/billing/verify",
        headers: c.headers,
        payload: { razorpay_payment_id: "pay_2", razorpay_subscription_id: "sub_2", razorpay_signature: checkoutSig("pay_2", "sub_2") },
      })
    ).json();
    expect(v.billing).toMatchObject({ state: "active", plan: { name: "Pro" }, subscription: { id: "sub_2", status: "authenticated" } });
    expect(v.billing.paidUntil).toBe(new Date(end * 1000).toISOString()); // paid time kept
    expect(calls.some((x) => x.path === "/subscriptions/sub_1/cancel" && x.body.cancel_at_cycle_end === 0)).toBe(true);
  });

  it("has no self sign-up or invite links: only the admin creates logins", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/setup/status" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/invite/some-old-token-1234567890" })).statusCode).toBe(404);
    await expect(
      setupAdmin(app, { email: "x@y.in", password: "another-password-1", displayName: "X", timezone: "UTC", defaultCountry: "IN" })
    ).rejects.toThrow(/already exists/);
  });

  it("admin console: client list leaves out the admin's own desk; activity shows what admins did", async () => {
    const c = await newClient("act@shop.in");
    const list = (await app.inject({ method: "GET", url: "/api/v1/admin/accounts", headers: admin })).json();
    expect(list.items.map((a: any) => a.id)).toEqual([c.accountId]);
    const searched = (await app.inject({ method: "GET", url: "/api/v1/admin/accounts?q=desk", headers: admin })).json();
    expect(searched.items).toEqual([]);

    await app.inject({ method: "POST", url: `/api/v1/admin/accounts/${c.accountId}/reset-password`, headers: admin, payload: {} });
    const activity = (await app.inject({ method: "GET", url: "/api/v1/admin/activity?limit=10", headers: admin })).json();
    expect(activity.items.map((i: any) => i.action)).toEqual(["account.reset_password", "account.create"]);
    expect(activity.items[1]).toMatchObject({
      account: { id: c.accountId, name: "Shop One" },
      actor: { email: "owner@example.com" },
      detail: { ownerEmail: "act@shop.in" },
    });
    const forOne = (await app.inject({ method: "GET", url: `/api/v1/admin/activity?accountId=nope`, headers: admin })).json();
    expect(forOne.items).toEqual([]);

    const fresh = (await app.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: { email: "act@shop.in", password: (await app.inject({ method: "POST", url: `/api/v1/admin/accounts/${c.accountId}/reset-password`, headers: admin, payload: {} })).json().login.password } }));
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/activity", headers: { cookie: cookieOf(fresh), ...WEB } })).statusCode).toBe(403);
  });

  it("refuses payment setup when Razorpay keys are missing", async () => {
    const c = await newClient();
    delete process.env["RAZORPAY_KEY_ID"];
    const billing = (await app.inject({ method: "GET", url: "/api/v1/billing", headers: c.headers })).json();
    expect(billing.razorpayEnabled).toBe(false);
    const res = await app.inject({ method: "POST", url: "/api/v1/billing/subscribe", headers: c.headers, payload: { planId: "x" } });
    expect(res.json().error.code).toBe("billing_not_configured");
  });
});
