import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../api.js";
import { useSession } from "../session.js";
import { apiErrorText, formatDate, formatINR } from "../format.js";
import { loadRazorpay, primaryColor, type RazorpaySuccess } from "../razorpay.js";
import type { BillingResponse, BillingSummary, Plan, SubscribeResponse } from "../types.js";
import { useToasts, ToastStack } from "../components/Toast.js";
import {
  ConfirmModal,
  ErrorBox,
  PageLoading,
  PaymentsTable,
  StateBadge,
  cardClass,
} from "../components/BillingParts.js";

const POLL_MS = 3000;
const POLL_MAX = 20; // ~60s
const CANCELLABLE = new Set(["active", "authenticated"]);
// Subscriptions that are already paying (or about to): the current plan button is locked for these.
const LIVE_SUB = CANCELLABLE;

function isPaidUp(b: BillingSummary) {
  return b.state === "active" || b.state === "exempt";
}

export function BillingView() {
  const { reloadMe } = useSession();
  const { toasts, push, dismiss } = useToasts();
  const [data, setData] = useState<BillingResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [activationTimedOut, setActivationTimedOut] = useState(false);
  const [pendingStart, setPendingStart] = useState<{ sub: SubscribeResponse; planId: string } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<BillingResponse>("/api/v1/billing");
      if (!mounted.current) return null;
      setData(res);
      setLoadError(null);
      return res;
    } catch (err) {
      if (mounted.current) setLoadError(apiErrorText(err, "Could not load billing."));
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
  }, [load]);

  const stopPolling = () => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
  };

  const startPolling = () => {
    stopPolling();
    setActivating(true);
    setActivationTimedOut(false);
    let tries = 0;
    const tick = async () => {
      tries += 1;
      const res = await load();
      if (!mounted.current) return;
      if (res && isPaidUp(res.billing)) {
        setActivating(false);
        push("success", "Your plan is active. WhatsApp sending is on.");
        void reloadMe();
        return;
      }
      if (tries >= POLL_MAX) {
        setActivating(false);
        setActivationTimedOut(true);
        void reloadMe();
        return;
      }
      pollTimer.current = window.setTimeout(tick, POLL_MS);
    };
    pollTimer.current = window.setTimeout(tick, POLL_MS);
  };

  const onPaid = async (resp: RazorpaySuccess) => {
    setActionError(null);
    try {
      const verified = await apiRequest<{ billing: BillingSummary }>("/api/v1/billing/verify", {
        method: "POST",
        body: JSON.stringify(resp),
      });
      if (mounted.current) setData((d) => (d ? { ...d, billing: verified.billing } : d));
    } catch (err) {
      if (mounted.current) setActionError(apiErrorText(err, "Could not verify the payment."));
    }
    const fresh = await load();
    void reloadMe();
    if (!mounted.current) return;
    setBusyPlanId(null);
    if (fresh && isPaidUp(fresh.billing)) {
      push("success", "Payment successful. Your plan is active.");
    } else {
      startPolling();
    }
  };

  const openCheckout = async (sub: SubscribeResponse) => {
    try {
      await loadRazorpay();
    } catch (err) {
      setBusyPlanId(null);
      setActionError((err as Error).message);
      return;
    }
    const Razorpay = window.Razorpay;
    if (!Razorpay) {
      setBusyPlanId(null);
      setActionError("Could not load Razorpay Checkout.");
      return;
    }
    const rzp = new Razorpay({
      key: sub.keyId,
      subscription_id: sub.subscriptionId,
      name: "Lead Desk",
      description: sub.planName,
      prefill: sub.prefill,
      theme: { color: primaryColor() },
      handler: async (resp) => {
        await onPaid(resp);
      },
      modal: {
        ondismiss: () => {
          if (!mounted.current) return;
          setBusyPlanId(null);
          push("info", "Checkout closed — no payment was made.");
        },
      },
    });
    rzp.open();
  };

  const subscribe = async (plan: Plan) => {
    setActionError(null);
    setActivationTimedOut(false);
    setBusyPlanId(plan.id);
    try {
      // Warm the script while the server creates the subscription.
      void loadRazorpay().catch(() => {});
      const sub = await apiRequest<SubscribeResponse>("/api/v1/billing/subscribe", {
        method: "POST",
        body: JSON.stringify({ planId: plan.id }),
      });
      if (sub.startsAt) {
        setPendingStart({ sub, planId: plan.id });
        return;
      }
      await openCheckout(sub);
    } catch (err) {
      setBusyPlanId(null);
      setActionError(apiErrorText(err, "Could not start the subscription."));
    }
  };

  const cancelRenewal = async () => {
    setCancelling(true);
    setActionError(null);
    try {
      const res = await apiRequest<{ billing: BillingSummary }>("/api/v1/billing/cancel", { method: "POST" });
      setData((d) => (d ? { ...d, billing: res.billing } : d));
      push("success", "Auto-renewal cancelled. Your plan stays active until the end of the paid period.");
      void reloadMe();
    } catch (err) {
      setActionError(apiErrorText(err, "Could not cancel the renewal."));
    } finally {
      setCancelling(false);
      setConfirmCancel(false);
    }
  };

  if (!data && loadError) {
    return (
      <div className="view-container animate-fade-in space-y-4">
        <ErrorBox onRetry={() => void load()}>{loadError}</ErrorBox>
      </div>
    );
  }
  if (!data) return <PageLoading text="Loading billing…" />;

  const { billing, plans, razorpayEnabled, payments } = data;
  const sortedPlans = [...plans].sort((a, b) => a.position - b.position);
  const subStatus = billing.subscription?.status ?? null;
  const hasLiveSub = !!subStatus && LIVE_SUB.has(subStatus);

  return (
    <div className="view-container animate-fade-in space-y-6">
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <div className="view-header">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">Plans &amp; Billing</h1>
        <p className="text-base text-slate-500 dark:text-slate-400 mt-1">
          Your plan, renewal and payment history. Payments are handled securely by Razorpay.
        </p>
      </div>

      {actionError && <ErrorBox>{actionError}</ErrorBox>}

      {activating && (
        <div className="p-4 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900 text-indigo-800 dark:text-indigo-200 text-sm flex items-center gap-3" role="status">
          <span className="inline-block w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          Payment received — activating…
        </div>
      )}
      {activationTimedOut && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200 text-sm" role="status">
          Payment received, but activation is taking longer than usual. It will switch on automatically — refresh this page in a
          few minutes. If it doesn't, contact support.
        </div>
      )}

      {/* Current status */}
      <section className={`${cardClass} p-6 space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Current status</h2>
          <StateBadge state={billing.state} />
        </div>
        {billing.state === "exempt" ? (
          <p className="text-sm text-slate-600 dark:text-slate-300 m-0">Your account is not billed. Nothing to pay.</p>
        ) : (
          <>
            <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 m-0">
              <Stat label="Plan" value={billing.plan ? `${billing.plan.name} · ${formatINR(billing.plan.pricePaise)}/month` : "No plan"} />
              <Stat label="Paid until" value={formatDate(billing.paidUntil)} />
              {(billing.state === "grace" || billing.state === "expired") && (
                <Stat label={billing.state === "grace" ? "Sending stops on" : "Grace ended"} value={formatDate(billing.graceEndsAt)} />
              )}
              <Stat label="Auto-renewal" value={subStatus ? subStatusLabel(subStatus) : "Not set up"} />
            </dl>
            {!billing.canSend && (
              <p className="text-sm text-rose-600 dark:text-rose-400 m-0">
                WhatsApp messages are not being sent until a payment is made.
              </p>
            )}
            {subStatus && CANCELLABLE.has(subStatus) && (
              <div>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmCancel(true)}>
                  Cancel renewal
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {/* Plans */}
      {billing.state === "exempt" ? null : (
        <section className="space-y-4">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Plans</h2>
          {!razorpayEnabled && (
            <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200 text-sm">
              Online payment is not set up yet — contact your admin.
            </div>
          )}
          {sortedPlans.length === 0 ? (
            <div className="empty-state">No plans are available right now. Contact your admin.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {sortedPlans.map((p) => {
                const isCurrent = billing.plan?.id === p.id;
                const isLockedCurrent = isCurrent && hasLiveSub;
                const label = isLockedCurrent
                  ? "Current plan"
                  : billing.plan && !isCurrent && hasLiveSub
                    ? "Switch to this plan"
                    : "Subscribe";
                return (
                  <div
                    key={p.id}
                    className={`${cardClass} p-6 flex flex-col gap-4 ${
                      isCurrent ? "ring-2 ring-indigo-500 border-indigo-300 dark:border-indigo-700" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-lg font-bold text-slate-900 dark:text-white m-0">{p.name}</h3>
                      {isCurrent && <span className="badge badge-stage">Current plan</span>}
                    </div>
                    <div>
                      <span className="text-3xl font-extrabold text-slate-900 dark:text-white">{formatINR(p.pricePaise)}</span>
                      <span className="text-sm text-slate-500 dark:text-slate-400"> /month</span>
                    </div>
                    {p.description && <p className="text-sm text-slate-600 dark:text-slate-300 m-0">{p.description}</p>}
                    {p.features.length > 0 && (
                      <ul className="text-sm text-slate-700 dark:text-slate-300 space-y-1.5 m-0 p-0 list-none">
                        {p.features.map((f, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="text-emerald-600 dark:text-emerald-400" aria-hidden>
                              ✓
                            </span>
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-auto pt-2">
                      <button
                        type="button"
                        className={`btn w-full ${isLockedCurrent ? "btn-secondary" : "btn-primary"}`}
                        disabled={isLockedCurrent || !razorpayEnabled || busyPlanId !== null || activating}
                        onClick={() => void subscribe(p)}
                      >
                        {busyPlanId === p.id ? "Opening checkout…" : label}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Payment history */}
      <section className={`${cardClass} p-6 space-y-4`}>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Payment history</h2>
        <PaymentsTable payments={payments} />
      </section>

      {pendingStart && (
        <ConfirmModal
          title="Continue to payment"
          confirmLabel="Continue to payment"
          message={
            <>
              <p className="m-0">
                You still have paid time left, so billing for <strong>{pendingStart.sub.planName}</strong> (
                {formatINR(pendingStart.sub.amountPaise)}/month) starts on{" "}
                <strong>{formatDate(pendingStart.sub.startsAt)}</strong>.
              </p>
              <p className="m-0">You will not be charged twice for the same period.</p>
            </>
          }
          onCancel={() => {
            setPendingStart(null);
            setBusyPlanId(null);
          }}
          onConfirm={() => {
            const sub = pendingStart.sub;
            setPendingStart(null);
            void openCheckout(sub);
          }}
        />
      )}

      {confirmCancel && (
        <ConfirmModal
          title="Cancel auto-renewal?"
          danger
          busy={cancelling}
          confirmLabel="Cancel renewal"
          message={
            <p className="m-0">
              Your plan stays active until <strong>{formatDate(billing.paidUntil)}</strong>. After that WhatsApp sending stops
              unless you subscribe again.
            </p>
          }
          onCancel={() => setConfirmCancel(false)}
          onConfirm={() => void cancelRenewal()}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{label}</dt>
      <dd className="m-0 mt-1 text-sm font-semibold text-slate-900 dark:text-white">{value}</dd>
    </div>
  );
}

function subStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "On (autopay active)";
    case "authenticated":
      return "On (first charge scheduled)";
    case "created":
      return "Awaiting payment";
    case "pending":
      return "Retrying failed charge";
    case "halted":
      return "Stopped (charges failed)";
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Completed";
    case "paused":
      return "Paused";
    default:
      return status;
  }
}
