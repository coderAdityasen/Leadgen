import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../api.js";
import { Link } from "../../router.js";
import { useSession } from "../../session.js";
import { apiErrorText, formatDate, formatDateTime, formatINR } from "../../format.js";
import type { AdminAccount, LoginCredentials, Payment, Plan } from "../../types.js";
import { Toggle } from "../../components/Toggle.js";
import { useToasts, ToastStack } from "../../components/Toast.js";
import {
  ConfirmModal,
  ErrorBox,
  CredentialsPanel,
  NotAuthorized,
  PageLoading,
  PaymentsTable,
  StateBadge,
  cardClass,
} from "../../components/BillingParts.js";

type Patch = Partial<{
  name: string;
  notes: string;
  planId: string | null;
  status: "active" | "suspended";
  paidUntil: string | null;
  extendDays: number;
  billingExempt: boolean;
}>;

export function AdminClientDetailView({ accountId }: { accountId: string }) {
  const { me } = useSession();
  if (!me) return <PageLoading />;
  if (me.role !== "superadmin") return <NotAuthorized />;
  return <ClientDetail accountId={accountId} />;
}

/** yyyy-mm-dd (local) for a date input. */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** yyyy-mm-dd -> ISO of the end of that day in the browser's local time. */
function endOfLocalDayIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).toISOString();
}

function ClientDetail({ accountId }: { accountId: string }) {
  const { toasts, push, dismiss } = useToasts();
  const [account, setAccount] = useState<AdminAccount | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [paidUntilInput, setPaidUntilInput] = useState("");
  const [notes, setNotes] = useState("");
  const [name, setName] = useState("");
  const [credentials, setCredentials] = useState<LoginCredentials | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);

  const applyAccount = (a: AdminAccount) => {
    setAccount(a);
    setPaidUntilInput(toDateInput(a.billing.paidUntil));
    setNotes(a.notes);
    setName(a.name);
  };

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<{ account: AdminAccount; payments: Payment[] }>(
        `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`
      );
      applyAccount(res.account);
      setPayments(res.payments);
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorText(err, "Could not load this client."));
    }
  }, [accountId]);

  useEffect(() => {
    void load();
    apiRequest<{ items: Plan[] }>("/api/v1/admin/plans")
      .then((res) => setPlans([...res.items].sort((a, b) => a.position - b.position)))
      .catch(() => {});
  }, [load]);

  const patch = async (key: string, body: Patch, successText: string) => {
    setBusy(key);
    try {
      const res = await apiRequest<{ account: AdminAccount }>(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      applyAccount(res.account);
      push("success", successText);
      return true;
    } catch (err) {
      push("error", apiErrorText(err, "Update failed."));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const resetPassword = async () => {
    setBusy("reset");
    try {
      const res = await apiRequest<{ login: LoginCredentials }>(
        `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/reset-password`,
        { method: "POST", body: JSON.stringify({}) }
      );
      setCredentials(res.login);
      setConfirmReset(false);
      push("success", "Password reset. The client was signed out everywhere.");
    } catch (err) {
      push("error", apiErrorText(err, "Could not reset the password."));
    } finally {
      setBusy(null);
    }
  };

  if (!account && loadError) {
    return (
      <div className="view-container animate-fade-in space-y-4">
        <Link href="/admin/clients" className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
          ← All clients
        </Link>
        <ErrorBox onRetry={() => void load()}>{loadError}</ErrorBox>
      </div>
    );
  }
  if (!account) return <PageLoading text="Loading client…" />;

  const b = account.billing;
  const suspended = account.status === "suspended";
  const exempt = account.billingExempt;
  const anyBusy = busy !== null;

  return (
    <div className="view-container animate-fade-in space-y-6">
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <div className="space-y-2">
        <Link href="/admin/clients" className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
          ← All clients
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">{account.name}</h1>
          <StateBadge state={b.state} />
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 m-0">
          Created {formatDate(account.createdAt)} · <span className="font-mono text-xs">{account.id}</span>
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Owner */}
        <section className={`${cardClass} p-6 space-y-4`}>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Owner</h2>
          {account.owner ? (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 m-0">
              <Stat label="Name" value={account.owner.displayName || "—"} />
              <Stat
                label="Email"
                value={
                  <span className="inline-flex flex-wrap items-center gap-2 break-all">
                    {account.owner.email}
                  </span>
                }
              />
              <Stat label="Last login" value={formatDateTime(account.owner.lastLoginAt, "Never")} />
              <Stat label="Extension last seen" value={formatDateTime(account.stats.lastDeviceSeenAt, "Never")} />
              <Stat label="Leads" value={String(account.stats.leads)} />
              <Stat label="Sent (30 days)" value={String(account.stats.sentLast30d)} />
            </dl>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400 m-0">No owner login.</p>
          )}
          <div className="space-y-3 pt-1">
            {account.owner && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={anyBusy} onClick={() => setConfirmReset(true)}>
                {busy === "reset" ? "Resetting…" : "Reset password"}
              </button>
            )}
            {credentials && (
              <CredentialsPanel
                email={credentials.email}
                password={credentials.password}
                recipientName={account.owner?.displayName}
                businessName={account.name}
                isReset
              />
            )}
            {confirmReset && (
              <ConfirmModal
                title="Reset this client's password?"
                message="A new password is generated and shown once. The client is signed out everywhere and must use the new password."
                confirmLabel="Reset password"
                busy={busy === "reset"}
                onConfirm={() => void resetPassword()}
                onCancel={() => setConfirmReset(false)}
              />
            )}
          </div>
        </section>

        {/* Billing */}
        <section className={`${cardClass} p-6 space-y-4`}>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Billing</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 m-0">
            <Stat label="Plan" value={b.plan ? `${b.plan.name} · ${formatINR(b.plan.pricePaise)}/month` : "No plan"} />
            <Stat label="Paid until" value={formatDate(b.paidUntil)} />
            <Stat label="Grace ends" value={formatDate(b.graceEndsAt)} />
            <Stat label="Subscription" value={b.subscription ? b.subscription.status : "None"} />
            <Stat label="Sending" value={b.canSend ? "On" : "Stopped"} />
          </dl>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={anyBusy}
              onClick={() => void patch("extend30", { extendDays: 30 }, "Extended by 30 days.")}
            >
              {busy === "extend30" ? "Saving…" : "+30 days"}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={anyBusy}
              onClick={() => void patch("extend7", { extendDays: 7 }, "Extended by 7 days.")}
            >
              {busy === "extend7" ? "Saving…" : "+7 days"}
            </button>
          </div>

          <form
            className="flex flex-col sm:flex-row sm:items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const iso = endOfLocalDayIso(paidUntilInput);
              if (!iso) {
                push("error", "Pick a valid date.");
                return;
              }
              void patch("paidUntil", { paidUntil: iso }, `Paid until set to ${formatDate(iso)}.`);
            }}
          >
            <label className="flex flex-col gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300 sm:w-56">
              Set paid until
              <input
                type="date"
                value={paidUntilInput}
                onChange={(e) => setPaidUntilInput(e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm"
              />
            </label>
            <button type="submit" className="btn btn-secondary btn-sm" disabled={anyBusy || !paidUntilInput}>
              {busy === "paidUntil" ? "Saving…" : "Save date"}
            </button>
          </form>

          <label className="flex flex-col gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300 sm:w-80">
            Plan
            <select
              value={b.plan?.id ?? ""}
              disabled={anyBusy}
              onChange={(e) => {
                const v = e.target.value || null;
                void patch("plan", { planId: v }, v ? "Plan changed." : "Plan removed.");
              }}
            >
              <option value="">No plan</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {formatINR(p.pricePaise)}/month{p.active ? "" : " (inactive)"}
                </option>
              ))}
              {b.plan && !plans.some((p) => p.id === b.plan?.id) && <option value={b.plan.id}>{b.plan.name}</option>}
            </select>
          </label>

          <div className="sm:w-80">
            <Toggle
              label="Billing exempt (never billed)"
              checked={exempt}
              disabled={anyBusy}
              onChange={(next) =>
                void patch("exempt", { billingExempt: next }, next ? "Account is now billing exempt." : "Account is billed again.")
              }
            />
          </div>

          <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              className={`btn btn-sm mt-3 ${suspended ? "btn-primary" : "btn-danger"}`}
              disabled={anyBusy}
              onClick={() => setConfirmStatus(true)}
            >
              {suspended ? "Resume account" : "Suspend account"}
            </button>
          </div>
        </section>
      </div>

      {/* Name + notes */}
      <section className={`${cardClass} p-6 space-y-4`}>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Details &amp; notes</h2>
        <form
          className="flex flex-col sm:flex-row sm:items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void patch("name", { name: name.trim() }, "Business name saved.");
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300 flex-1 sm:max-w-md">
            Business name
            <input type="text" required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={anyBusy || name.trim() === account.name}>
            {busy === "name" ? "Saving…" : "Save name"}
          </button>
        </form>
        <label className="flex flex-col gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300">
          Internal notes
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Payment arrangements, contacts, reminders…" />
        </label>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={anyBusy || notes === account.notes}
          onClick={() => void patch("notes", { notes }, "Notes saved.")}
        >
          {busy === "notes" ? "Saving…" : "Save notes"}
        </button>
      </section>

      <section className={`${cardClass} p-6 space-y-4`}>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Payments</h2>
        <PaymentsTable payments={payments} />
      </section>

      {confirmStatus && (
        <ConfirmModal
          title={suspended ? "Resume this account?" : "Suspend this account?"}
          danger={!suspended}
          busy={busy === "status"}
          confirmLabel={suspended ? "Resume" : "Suspend"}
          message={
            suspended ? (
              <p className="m-0">The owner can sign in again and sending follows the normal billing rules.</p>
            ) : (
              <p className="m-0">
                The owner of <strong>{account.name}</strong> will be refused at login and no WhatsApp messages will be sent. Data is
                kept.
              </p>
            )
          }
          onCancel={() => setConfirmStatus(false)}
          onConfirm={async () => {
            await patch("status", { status: suspended ? "active" : "suspended" }, suspended ? "Account resumed." : "Account suspended.");
            setConfirmStatus(false);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{label}</dt>
      <dd className="m-0 mt-1 text-sm font-semibold text-slate-900 dark:text-white">{value}</dd>
    </div>
  );
}
