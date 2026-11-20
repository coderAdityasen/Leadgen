/**
 * SaaS account / billing / admin shapes. Mirrors docs/saas-billing-api.md exactly.
 * Kept in the web app on purpose (not imported from packages/shared).
 */

export type BillingState = "exempt" | "active" | "grace" | "expired" | "suspended";

export interface BillingSummary {
  state: BillingState;
  /** false => queued WhatsApp messages are not being sent */
  canSend: boolean;
  paidUntil: string | null;
  graceEndsAt: string | null;
  plan: { id: string; name: string; pricePaise: number } | null;
  /** Razorpay status: created|authenticated|active|pending|halted|cancelled|completed|paused */
  subscription: { id: string; status: string } | null;
}

export interface Plan {
  id: string;
  name: string;
  description: string;
  pricePaise: number;
  currency: "INR";
  features: string[];
  active: boolean;
  position: number;
  razorpayPlanId: string | null;
}

export interface Payment {
  id: string;
  amountPaise: number;
  status: string;
  paidAt: string;
  razorpayPaymentId: string;
}

export interface AdminAccount {
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
    invitePending: boolean;
    lastLoginAt: string | null;
  } | null;
  billing: BillingSummary;
  stats: { leads: number; sentLast30d: number; lastDeviceSeenAt: string | null };
}

export type Role = "superadmin" | "owner";

/** One entry of the admin activity feed (GET /admin/activity). */
export interface AdminActivity {
  id: string;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
  account: { id: string; name: string } | null;
  actor: { email: string; name: string } | null;
}

export interface Me {
  id: string;
  displayName: string;
  timezone: string;
  createdAt: string;
  email: string;
  role: Role;
  account: { id: string; name: string };
  billing: BillingSummary;
}


export interface BillingResponse {
  billing: BillingSummary;
  plans: Plan[];
  razorpayEnabled: boolean;
  keyId: string | null;
  payments: Payment[];
}

export interface SubscribeResponse {
  subscriptionId: string;
  keyId: string;
  planName: string;
  amountPaise: number;
  prefill: { name: string; email: string };
  startsAt: string | null;
}

export interface AdminOverview {
  accounts: { total: number; active: number; grace: number; expired: number; suspended: number; exempt: number };
  mrrPaise: number;
  razorpayEnabled: boolean;
  graceDays: number;
}

/** A login the admin just created or reset. The password is shown once; only its hash is stored. */
export interface LoginCredentials {
  email: string;
  password: string;
}
