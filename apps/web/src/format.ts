import type { BillingState } from "./types.js";

const inrWhole = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const inrExact = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

/** 49900 paise -> "₹499"; 49950 -> "₹499.50". */
export function formatINR(paise: number): string {
  return paise % 100 === 0 ? inrWhole.format(paise / 100) : inrExact.format(paise / 100);
}

/** Date in the user's locale, e.g. "20 Nov 2026". */
export function formatDate(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const STATE_LABEL: Record<BillingState, string> = {
  exempt: "Not billed",
  active: "Active",
  grace: "Payment overdue",
  expired: "Expired",
  suspended: "Suspended",
};

export const STATE_BADGE: Record<BillingState, string> = {
  exempt: "badge-gray",
  active: "badge-success",
  grace: "badge-warning",
  expired: "badge-danger",
  suspended: "badge-danger",
};

const FRIENDLY: Record<string, string> = {
  account_suspended: "This account is suspended. Contact support.",
  invalid_invite: "This link is invalid or has expired — ask your admin for a new one.",
  billing_not_configured: "Online payment is not set up yet — contact your admin.",
  plan_unavailable: "That plan is no longer available. Please pick another one.",
  already_subscribed: "You already have an active subscription for this plan.",
  billing_exempt: "Your account is not billed.",
  bad_signature: "We could not verify the payment. If money was debited, it will be confirmed shortly — otherwise contact support.",
  email_taken: "A login with this email already exists.",
  forbidden: "You are not authorized to do that.",
};

/** Readable text for an ApiError thrown by apiRequest. */
export function apiErrorText(err: unknown, fallback = "Something went wrong."): string {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return fallback;
  if (e.code && FRIENDLY[e.code]) return FRIENDLY[e.code]!;
  return e.message || fallback;
}

export function apiErrorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}
