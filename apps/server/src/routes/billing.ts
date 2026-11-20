/**
 * Plans & Billing for account owners, and the Razorpay webhook.
 *
 * Flow: owner picks a plan -> POST /billing/subscribe creates a Razorpay subscription ->
 * the browser opens Razorpay Checkout -> POST /billing/verify (signature check + fetch the
 * subscription from Razorpay) unlocks immediately; the webhook is the source of truth for every
 * later renewal, failure, halt and cancellation.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { generateUlid } from "@leaddesk/shared";
import { requireOperatorSession, sessionUser, type AuthedRequest } from "../auth.js";
import {
  RazorpayError,
  applySubscription,
  billingSummary,
  cancelRazorpaySubscription,
  createRazorpaySubscription,
  fetchRazorpaySubscription,
  formatPayment,
  formatPlan,
  razorpayConfig,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type PaymentRow,
  type PlanRow,
  type RzSubscription,
} from "../billing.js";
import { getAccount } from "../tenancy.js";

const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message, details: {} } });

/** Subscription statuses that mean "this account already has a working subscription". */
const LIVE = new Set(["authenticated", "active", "pending"]);

function providerFailure(reply: FastifyReply, err: unknown) {
  if (err instanceof RazorpayError) {
    return fail(reply, 502, "payment_provider_error", `Razorpay: ${err.description}`);
  }
  return fail(reply, 502, "payment_provider_error", "Could not reach Razorpay. Try again.");
}

export const billingRoutes: FastifyPluginAsync = async (app) => {
  // GET /billing
  app.get("/billing", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { accountId } = request as unknown as AuthedRequest;
    const account = (await getAccount(app.control, accountId))!;
    const plans = (await app.control.prepare("SELECT * FROM plan WHERE active = 1 ORDER BY position, price_paise").all() as PlanRow[]).map(
      (p) => formatPlan(p)
    );
    const payments = (
      await app.control.prepare("SELECT * FROM payment WHERE account_id = ? ORDER BY paid_at DESC LIMIT 50").all(accountId) as PaymentRow[]
    ).map(formatPayment);
    const cfg = razorpayConfig();
    return reply.send({
      billing: await billingSummary(app.control, account),
      plans,
      razorpayEnabled: Boolean(cfg),
      keyId: cfg?.keyId ?? null,
      payments,
    });
  });

  // POST /billing/subscribe { planId }
  app.post("/billing/subscribe", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { accountId } = request as unknown as AuthedRequest;
    const cfg = razorpayConfig();
    if (!cfg) return fail(reply, 503, "billing_not_configured", "Online payment is not set up yet. Contact your admin.");
    const account = (await getAccount(app.control, accountId))!;
    if (account.billing_exempt) return fail(reply, 403, "billing_exempt", "This account is not billed.");

    const planId = (request.body as { planId?: unknown } | undefined)?.planId;
    const plan =
      typeof planId === "string"
        ? (await app.control.prepare("SELECT * FROM plan WHERE id = ? AND active = 1").get(planId) as PlanRow | undefined)
        : undefined;
    if (!plan || !plan.razorpay_plan_id) return fail(reply, 400, "plan_unavailable", "This plan is not available.");

    if (account.rz_subscription_id && LIVE.has(account.rz_subscription_status ?? "") && account.plan_id === plan.id) {
      return fail(reply, 409, "already_subscribed", "You are already subscribed to this plan.");
    }

    // Still paid up (plan change, or re-subscribing after cancelling): the new subscription's
    // first charge waits for the end of the paid period, so nobody pays twice for the same days.
    const now = Date.now();
    const startAt = account.paid_until && account.paid_until > now + 10 * 60_000 ? account.paid_until : undefined;

    let sub: RzSubscription;
    try {
      sub = await createRazorpaySubscription({ planId: plan.razorpay_plan_id, accountId, startAt });
    } catch (err) {
      request.log.warn({ err }, "razorpay subscription create failed");
      return providerFailure(reply, err);
    }
    // A checkout abandoned earlier leaves a 'created' subscription; it simply expires at Razorpay.
    await app.control
      .prepare("UPDATE account SET rz_pending_subscription_id = ?, updated_at = ? WHERE id = ?")
      .run(sub.id, now, accountId);

    const user = await sessionUser(request);
    return reply.send({
      subscriptionId: sub.id,
      keyId: cfg.keyId,
      planName: plan.name,
      amountPaise: plan.price_paise,
      prefill: { name: user?.display_name ?? account.name, email: user?.email && user.email.includes("@") ? user.email : "" },
      startsAt: startAt ? new Date(startAt).toISOString() : null,
    });
  });

  // POST /billing/verify — Checkout handler response, passed through as-is
  app.post("/billing/verify", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { accountId } = request as unknown as AuthedRequest;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const paymentId = body["razorpay_payment_id"];
    const subscriptionId = body["razorpay_subscription_id"];
    const signature = body["razorpay_signature"];
    if (typeof paymentId !== "string" || typeof subscriptionId !== "string" || typeof signature !== "string") {
      return fail(reply, 400, "validation", "Missing Razorpay payment details.");
    }
    const account = (await getAccount(app.control, accountId))!;
    if (account.rz_pending_subscription_id !== subscriptionId && account.rz_subscription_id !== subscriptionId) {
      return fail(reply, 400, "bad_signature", "This payment does not belong to your account.");
    }
    if (!verifyCheckoutSignature(paymentId, subscriptionId, signature)) {
      return fail(reply, 400, "bad_signature", "Payment could not be verified.");
    }
    try {
      const sub = await fetchRazorpaySubscription(subscriptionId);
      await switchToSubscription(sub);
    } catch (err) {
      // Signature was valid: the webhook will finish activation. Report the current state.
      request.log.warn({ err }, "razorpay subscription fetch after checkout failed");
    }
    return reply.send({ billing: await billingSummary(app.control, (await getAccount(app.control, accountId))!) });
  });

  // POST /billing/cancel — stop renewing at the end of the paid period
  app.post("/billing/cancel", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { accountId } = request as unknown as AuthedRequest;
    const account = (await getAccount(app.control, accountId))!;
    if (!account.rz_subscription_id || !LIVE.has(account.rz_subscription_status ?? "")) {
      return fail(reply, 409, "no_subscription", "There is no active subscription to cancel.");
    }
    try {
      const sub = await cancelRazorpaySubscription(account.rz_subscription_id, true);
      await applySubscription(app.control, sub);
    } catch (err) {
      return providerFailure(reply, err);
    }
    return reply.send({ billing: await billingSummary(app.control, (await getAccount(app.control, accountId))!) });
  });

  /**
   * Make an authorised subscription the account's current one. The previous subscription (plan
   * change) is cancelled at Razorpay so the customer is never billed by both.
   */
  async function switchToSubscription(sub: RzSubscription) {
    const before = await app.control
      .prepare("SELECT id, rz_subscription_id, rz_subscription_status FROM account WHERE rz_pending_subscription_id = ?")
      .get(sub.id) as { id: string; rz_subscription_id: string | null; rz_subscription_status: string | null } | undefined;
    const updated = await applySubscription(app.control, sub);
    const old = before?.rz_subscription_id;
    if (updated && old && old !== sub.id && updated.rz_subscription_id === sub.id && LIVE.has(before?.rz_subscription_status ?? "")) {
      try {
        await cancelRazorpaySubscription(old, false);
      } catch (err) {
        app.log.error({ err, subscription: old }, "could not cancel the replaced subscription; cancel it in the Razorpay dashboard");
      }
    }
  }

  // ---------- webhook (Razorpay -> us). Needs the exact raw body for the signature. ----------
  await app.register(async (hook) => {
    hook.removeAllContentTypeParsers();
    hook.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    hook.post("/billing/razorpay/webhook", async (request, reply) => {
      const raw = request.body as Buffer | undefined;
      const signature = request.headers["x-razorpay-signature"];
      if (!Buffer.isBuffer(raw) || typeof signature !== "string" || !verifyWebhookSignature(raw, signature)) {
        return fail(reply, 400, "bad_signature", "Invalid webhook signature.");
      }
      let event: any;
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        return fail(reply, 400, "validation", "Invalid JSON.");
      }
      const type = typeof event?.event === "string" ? event.event : "";
      const eventIdHeader = request.headers["x-razorpay-event-id"];
      const eventId = typeof eventIdHeader === "string" && eventIdHeader ? eventIdHeader : null;
      const now = Date.now();

      if (eventId) {
        const fresh = await app.control
          .prepare("INSERT OR IGNORE INTO webhook_event (id, type, received_at) VALUES (?, ?, ?)")
          .run(eventId, type, now);
        if (fresh.changes === 0) return reply.send({ ok: true, duplicate: true });
      }

      const sub = event?.payload?.subscription?.entity as RzSubscription | undefined;
      if (type.startsWith("subscription.") && sub && typeof sub.id === "string") {
        await switchToSubscription(sub);
        const payment = event?.payload?.payment?.entity;
        if (type === "subscription.charged" && payment && typeof payment.id === "string") {
          const account = await app.control
            .prepare("SELECT id FROM account WHERE rz_subscription_id = ?")
            .get(sub.id) as { id: string } | undefined;
          if (account) {
            await app.control
              .prepare(
                `INSERT OR IGNORE INTO payment (id, account_id, rz_payment_id, rz_subscription_id, amount_paise, status, paid_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                generateUlid("pay"),
                account.id,
                payment.id,
                sub.id,
                Number(payment.amount) || 0,
                String(payment.status ?? "captured"),
                Number(payment.created_at) > 0 ? Number(payment.created_at) * 1000 : now,
                now
              );
          }
        }
      }
      // Always 200 for valid, signed events (even ones we do not use) so Razorpay stops retrying.
      return reply.send({ ok: true });
    });
  });
};
