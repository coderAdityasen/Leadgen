/**
 * Billing: plan/price data, the account's billing state, and a minimal Razorpay client.
 *
 * Access rule (the only thing the rest of the server needs): an account can send WhatsApp
 * messages while `paid_until + grace` is in the future, unless it is suspended. Exempt accounts
 * (the operator's own desk) can always send. Razorpay only ever moves `paid_until` forward.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import { getAccount, type AccountRow } from "./tenancy.js";

export const DAY_MS = 86_400_000;

export function graceDays(): number {
  const raw = Number(process.env["LEAD_DESK_BILLING_GRACE_DAYS"] ?? 3);
  return Number.isFinite(raw) && raw >= 0 && raw <= 30 ? raw : 3;
}

export type BillingState = "exempt" | "active" | "grace" | "expired" | "suspended";

export interface PlanRow {
  id: string;
  name: string;
  description: string;
  price_paise: number;
  currency: string;
  features_json: string;
  razorpay_plan_id: string | null;
  active: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface PaymentRow {
  id: string;
  account_id: string;
  rz_payment_id: string;
  rz_subscription_id: string | null;
  amount_paise: number;
  status: string;
  paid_at: number;
}

export function billingState(account: AccountRow, now = Date.now()): { state: BillingState; canSend: boolean; graceEndsAt: number | null } {
  if (account.status === "suspended") return { state: "suspended", canSend: false, graceEndsAt: null };
  if (account.billing_exempt) return { state: "exempt", canSend: true, graceEndsAt: null };
  const paid = account.paid_until ?? 0;
  const graceEndsAt = account.paid_until ? paid + graceDays() * DAY_MS : null;
  if (paid > now) return { state: "active", canSend: true, graceEndsAt };
  if (graceEndsAt && graceEndsAt > now) return { state: "grace", canSend: true, graceEndsAt };
  return { state: "expired", canSend: false, graceEndsAt };
}

/** Can this account's extension be given messages to send right now? */
export async function accountCanSend(control: Db, accountId: string, now = Date.now()): Promise<boolean> {
  const account = await getAccount(control, accountId);
  return account ? billingState(account, now).canSend : false;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export function formatPlan(row: PlanRow, includeRazorpay = false) {
  let features: string[] = [];
  try {
    const parsed = JSON.parse(row.features_json);
    if (Array.isArray(parsed)) features = parsed.filter((f) => typeof f === "string");
  } catch {
    features = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    pricePaise: row.price_paise,
    currency: row.currency as "INR",
    features,
    active: Boolean(row.active),
    position: row.position,
    razorpayPlanId: includeRazorpay ? row.razorpay_plan_id : null,
  };
}

export function formatPayment(row: PaymentRow) {
  return {
    id: row.id,
    amountPaise: row.amount_paise,
    status: row.status,
    paidAt: new Date(row.paid_at).toISOString(),
    razorpayPaymentId: row.rz_payment_id,
  };
}

export async function billingSummary(control: Db, account: AccountRow, now = Date.now()) {
  const { state, canSend, graceEndsAt } = billingState(account, now);
  const plan = account.plan_id
    ? (await control.prepare("SELECT * FROM plan WHERE id = ?").get(account.plan_id) as PlanRow | undefined)
    : undefined;
  return {
    state,
    canSend,
    paidUntil: iso(account.paid_until),
    graceEndsAt: iso(graceEndsAt),
    plan: plan ? { id: plan.id, name: plan.name, pricePaise: plan.price_paise } : null,
    subscription: account.rz_subscription_id
      ? { id: account.rz_subscription_id, status: account.rz_subscription_status ?? "unknown" }
      : null,
  };
}

// ---------- Razorpay ----------

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string | null;
}

export function razorpayConfig(): RazorpayConfig | null {
  // RAZORPAY_API / RAZORPAY_SECRET are accepted as aliases (common naming in .env files).
  const keyId = (process.env["RAZORPAY_KEY_ID"] || process.env["RAZORPAY_API"])?.trim();
  const keySecret = (process.env["RAZORPAY_KEY_SECRET"] || process.env["RAZORPAY_SECRET"])?.trim();
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret, webhookSecret: process.env["RAZORPAY_WEBHOOK_SECRET"]?.trim() || null };
}

/** Replaceable in tests. */
export let razorpayFetch: typeof fetch = (...args) => fetch(...args);
export function setRazorpayFetch(impl: typeof fetch) {
  razorpayFetch = impl;
}

export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    readonly description: string
  ) {
    super(`Razorpay ${status}: ${description}`);
  }
}

async function rz<T>(method: string, path: string, body?: unknown): Promise<T> {
  const cfg = razorpayConfig();
  if (!cfg) throw new RazorpayError(0, "Razorpay keys are not configured");
  const res = await razorpayFetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64")}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const description = typeof data?.error?.description === "string" ? data.error.description : res.statusText;
    throw new RazorpayError(res.status, String(description).slice(0, 300));
  }
  return data as T;
}

export interface RzSubscription {
  id: string;
  plan_id: string;
  status: string;
  current_start?: number | null;
  current_end?: number | null;
  charge_at?: number | null;
  start_at?: number | null;
  notes?: Record<string, string> | unknown[];
}

export function createRazorpayPlan(input: { name: string; description: string; amountPaise: number }) {
  return rz<{ id: string }>("POST", "/plans", {
    period: "monthly",
    interval: 1,
    item: { name: input.name, amount: input.amountPaise, currency: "INR", description: input.description || input.name },
  });
}

export function createRazorpaySubscription(input: { planId: string; accountId: string; startAt?: number }) {
  return rz<RzSubscription & { short_url?: string }>("POST", "/subscriptions", {
    plan_id: input.planId,
    // Razorpay needs a fixed number of cycles; 10 years of monthly renewals is "until cancelled".
    total_count: 120,
    quantity: 1,
    customer_notify: 1,
    ...(input.startAt ? { start_at: Math.floor(input.startAt / 1000) } : {}),
    notes: { account_id: input.accountId },
  });
}

export function fetchRazorpaySubscription(id: string) {
  return rz<RzSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
}

export function cancelRazorpaySubscription(id: string, atCycleEnd: boolean) {
  return rz<RzSubscription>("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, {
    cancel_at_cycle_end: atCycleEnd ? 1 : 0,
  });
}

function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Checkout handler signature for subscriptions: HMAC(payment_id|subscription_id). */
export function verifyCheckoutSignature(paymentId: string, subscriptionId: string, signature: string): boolean {
  const cfg = razorpayConfig();
  if (!cfg) return false;
  return sameHex(hmacHex(cfg.keySecret, `${paymentId}|${subscriptionId}`), signature);
}

/** Webhook signature: HMAC of the exact raw request body with the webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const cfg = razorpayConfig();
  if (!cfg?.webhookSecret) return false;
  return sameHex(hmacHex(cfg.webhookSecret, rawBody), signature);
}

/** Subscription statuses in which Razorpay will (or did) charge the customer. */
const LIVE_STATUSES = new Set(["authenticated", "active", "pending"]);

/**
 * Apply what Razorpay says about a subscription to the account that owns it. Idempotent and
 * order-independent: `paid_until` only ever moves forward, so a late or replayed event can
 * never take paid time away.
 */
export async function applySubscription(control: Db, sub: RzSubscription, now = Date.now()): Promise<AccountRow | null> {
  const notes = sub.notes && !Array.isArray(sub.notes) ? (sub.notes as Record<string, string>) : {};
  const account =
    (await control
      .prepare("SELECT * FROM account WHERE rz_subscription_id = ? OR rz_pending_subscription_id = ?")
      .get(sub.id, sub.id) as AccountRow | undefined) ??
    (notes["account_id"] ? await getAccount(control, notes["account_id"]) : undefined);
  if (!account) return null;
  // A subscription id that belongs to a different account (stale notes) is ignored.
  if (
    account.rz_subscription_id !== sub.id &&
    account.rz_pending_subscription_id !== sub.id &&
    notes["account_id"] !== account.id
  ) {
    return null;
  }

  const plan = await control.prepare("SELECT id FROM plan WHERE razorpay_plan_id = ?").get(sub.plan_id) as { id: string } | undefined;
  const currentEndMs = sub.current_end ? sub.current_end * 1000 : null;
  const isCurrent = account.rz_subscription_id === sub.id;
  const becomesCurrent = !isCurrent && LIVE_STATUSES.has(sub.status);

  await control.transaction(async () => {
    if (becomesCurrent) {
      await control
        .prepare(
          `UPDATE account SET rz_subscription_id = ?, rz_pending_subscription_id =
             CASE WHEN rz_pending_subscription_id = ? THEN NULL ELSE rz_pending_subscription_id END,
           updated_at = ? WHERE id = ?`
        )
        .run(sub.id, sub.id, now, account.id);
    }
    if (isCurrent || becomesCurrent) {
      await control
        .prepare(
          `UPDATE account SET rz_subscription_status = ?,
             plan_id = COALESCE(?, plan_id),
             -- Only a subscription Razorpay reports as 'active' has paid for its current cycle.
             -- 'pending'/'halted' may already carry the next cycle's dates for an unpaid renewal.
             paid_until = CASE WHEN ? IS NOT NULL AND ? = 'active'
                               AND (paid_until IS NULL OR paid_until < ?) THEN ? ELSE paid_until END,
             updated_at = ?
           WHERE id = ?`
        )
        .run(sub.status, plan?.id ?? null, currentEndMs, sub.status, currentEndMs, currentEndMs, now, account.id);
    }
  });
  return await getAccount(control, account.id) ?? null;
}
