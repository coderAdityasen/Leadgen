# Lead Desk SaaS: accounts, billing (Razorpay) and admin — API contract

## Model

- **One server, one database file per client account** (`data/tenants/<accountId>.sqlite`) plus a
  small **control database** (`data/control.sqlite`) holding accounts, logins, plans, payments.
  Client data can never mix: each request is routed to exactly one account's file.
- Your own desk (the existing `data/leaddesk.sqlite`) becomes account `acc_default`, owned by the
  **super admin** (you). It is billing-exempt.
- No public sign-up and no setup page. The super admin creates a client account with a password
  (typed or generated) and hands the email and password to the client, who signs in on the login
  screen. **Reset password** in the admin panel issues a new one the same way.
- **Billing**: client picks a plan on **Plans & Billing** and pays with Razorpay Checkout. It is a
  Razorpay **Subscription** (monthly autopay: UPI AutoPay / card / e-mandate). Every successful
  charge moves the account's `paidUntil` forward. If a renewal fails, sending continues for a
  grace period (default 3 days, `LEAD_DESK_BILLING_GRACE_DAYS`), then **the server stops handing
  messages to the extension**. Dashboard, data and inbound capture keep working so the client can
  pay; sending resumes on payment without any manual step.
- Admin can also extend `paidUntil` by hand (cash/UPI/bank transfer, trials, discounts).

All routes are under `/api/v1`. Mutating requests need header `X-LeadDesk-Client: web` (the
existing `apiRequest` helper adds it). Errors: `{ error: { code, message, details } }`.

## Shared shapes

```ts
type BillingState = "exempt" | "active" | "grace" | "expired" | "suspended";

interface BillingSummary {
  state: BillingState;
  canSend: boolean;                 // false => queued WhatsApp messages are not being sent
  paidUntil: string | null;         // ISO
  graceEndsAt: string | null;       // ISO, paidUntil + grace
  plan: { id: string; name: string; pricePaise: number } | null;
  subscription: { id: string; status: string } | null; // Razorpay status: created|authenticated|active|pending|halted|cancelled|completed|paused
}

interface Plan {
  id: string;
  name: string;
  description: string;
  pricePaise: number;               // ₹499 = 49900
  currency: "INR";
  features: string[];
  active: boolean;
  position: number;
  razorpayPlanId: string | null;    // admin views only (null elsewhere is fine)
}

interface Payment {
  id: string;
  amountPaise: number;
  status: string;                   // "captured" | "failed" | ...
  paidAt: string;                   // ISO
  razorpayPaymentId: string;
}

interface AdminAccount {
  id: string;
  name: string;
  createdAt: string;
  notes: string;
  status: "active" | "suspended";
  billingExempt: boolean;
  owner: {
    id: string;
    email: string;
    displayName: string;
    invitePending: boolean;         // has not set a password yet
    lastLoginAt: string | null;
  } | null;
  billing: BillingSummary;
  stats: { leads: number; sentLast30d: number; lastDeviceSeenAt: string | null };
}
```

## Session

There is no setup or sign-up endpoint. The super admin is created in the database (from
`LEAD_DESK_ADMIN_EMAIL` / `LEAD_DESK_ADMIN_PASSWORD` on the first start of an empty database, or
with `npm run admin:create`); every other login is created by the admin.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/session` | `{ email, password }` | 200 `{ operator }`; 401 `not_authenticated`; 403 `account_suspended` |
| DELETE | `/session` | | 204 |
| GET | `/me` | | `{ id, displayName, timezone, createdAt, email, role: "superadmin" \| "owner", account: { id, name }, billing: BillingSummary }` |

## Billing (any logged-in account owner)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/billing` | | `{ billing: BillingSummary, plans: Plan[] (active only), razorpayEnabled: boolean, keyId: string \| null, payments: Payment[] }` |
| POST | `/billing/subscribe` | `{ planId }` | `{ subscriptionId, keyId, planName, amountPaise, prefill: { name, email }, startsAt: string \| null }` — open Razorpay Checkout with `subscription_id` |
| POST | `/billing/verify` | `{ razorpay_payment_id, razorpay_subscription_id, razorpay_signature }` (Checkout handler response, passed through as-is) | `{ billing: BillingSummary }` |
| POST | `/billing/cancel` | | `{ billing }` — stops renewal at the end of the paid period |

Errors: 503 `billing_not_configured`, 400 `plan_unavailable`, 409 `already_subscribed`,
403 `billing_exempt`, 400 `bad_signature`.

`startsAt` non-null means the client still has paid time left (plan change / re-subscribe): the
first charge happens on that date, so they are never charged twice for the same period.

Webhook (Razorpay → server, not called by the UI): `POST /billing/razorpay/webhook`.

## Admin (super admin only; others get 403 `forbidden`)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/admin/overview` | | `{ accounts: { total, active, grace, expired, suspended, exempt }, mrrPaise, razorpayEnabled, graceDays }` |
| GET | `/admin/accounts?q=` | | `{ items: AdminAccount[] }` |
| POST | `/admin/accounts` | `{ businessName, ownerName, ownerEmail, timezone, defaultCountry, planId?, trialDays? (0–90), password? (12+; generated when empty) }` | 201 `{ account: AdminAccount, login: { email, password } }` — the password is returned once; 409 `email_taken` |
| GET | `/admin/accounts/:id` | | `{ account: AdminAccount, payments: Payment[] }` |
| PATCH | `/admin/accounts/:id` | any of `{ name, notes, planId (string\|null), status: "active"\|"suspended", paidUntil (ISO\|null), extendDays (1–366), billingExempt }` | `{ account: AdminAccount }` |
| POST | `/admin/accounts/:id/reset-password` | `{ password? }` (12+; generated when empty) | `{ login: { email, password } }` — returned once; the login is signed out everywhere |
| GET | `/admin/plans` | | `{ items: Plan[] (incl. inactive), razorpayEnabled }` |
| POST | `/admin/plans` | `{ name, description?, pricePaise (≥ 100), features?: string[], razorpayPlanId? }` | 201 `{ plan }` — creates the monthly plan in Razorpay automatically when keys are set |
| PATCH | `/admin/plans/:id` | any of `{ name, description, features, active, position }` | `{ plan }` — price is fixed; make a new plan for a new price |

## Server configuration (`.env`)

```ini
RAZORPAY_KEY_ID=rzp_live_xxx          # rzp_test_xxx while testing
RAZORPAY_KEY_SECRET=xxx
RAZORPAY_WEBHOOK_SECRET=xxx           # set the same value in Razorpay Dashboard → Webhooks
LEAD_DESK_PUBLIC_URL=https://desk.example.com   # public dashboard address
LEAD_DESK_ADMIN_EMAIL=you@example.com # login email for the existing operator after upgrade
LEAD_DESK_BILLING_GRACE_DAYS=3
```

Razorpay webhook URL: `https://desk.example.com/api/v1/billing/razorpay/webhook`, events:
`subscription.authenticated, subscription.activated, subscription.charged, subscription.pending,
subscription.halted, subscription.cancelled, subscription.completed, subscription.paused,
subscription.resumed`.
