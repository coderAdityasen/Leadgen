import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../api.js";
import { useRouter } from "../../router.js";
import { useSession } from "../../session.js";
import { apiErrorText, formatDate, formatDateTime, formatINR, STATE_LABEL } from "../../format.js";
import type { AdminAccount, AdminOverview, BillingState, LoginCredentials, Plan } from "../../types.js";
import { IconPlus, IconSearch } from "../../components/icons.js";
import {
  ErrorBox,
  CredentialsPanel,
  Modal,
  NotAuthorized,
  PageLoading,
  StateBadge,
  cardClass,
  fieldClass,
} from "../../components/BillingParts.js";

const FILTERS: Array<"all" | BillingState> = ["all", "active", "grace", "expired", "suspended", "exempt"];

export function AdminClientsView() {
  const { me } = useSession();
  if (!me) return <PageLoading />;
  if (me.role !== "superadmin") return <NotAuthorized />;
  return <AdminClients />;
}

function AdminClients() {
  const { navigate } = useRouter();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [items, setItems] = useState<AdminAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | BillingState>("all");
  const [showNew, setShowNew] = useState(() => new URLSearchParams(window.location.search).get("new") === "1");
  const seq = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const loadOverview = useCallback(() => {
    apiRequest<AdminOverview>("/api/v1/admin/overview")
      .then(setOverview)
      .catch((err) => setError(apiErrorText(err, "Could not load the overview.")));
  }, []);

  const loadAccounts = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await apiRequest<{ items: AdminAccount[] }>(
        `/api/v1/admin/accounts${q ? `?q=${encodeURIComponent(q)}` : ""}`
      );
      if (mine !== seq.current) return;
      setItems(res.items);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(apiErrorText(err, "Could not load clients."));
    }
  }, [q]);

  useEffect(loadOverview, [loadOverview]);
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const visible = useMemo(
    () => (items ?? []).filter((a) => filter === "all" || a.billing.state === filter),
    [items, filter]
  );

  return (
    <div className="view-container animate-fade-in space-y-6">
      <div className="view-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">Clients</h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1">Every client login, its billing state and usage.</p>
        </div>
        <button type="button" className="btn btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => setShowNew(true)}>
          <IconPlus size={14} /> New client
        </button>
      </div>

      {overview && !overview.razorpayEnabled && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200 text-sm">
          Razorpay is not configured. Clients cannot pay online until <code className="font-mono">RAZORPAY_KEY_ID</code>,{" "}
          <code className="font-mono">RAZORPAY_KEY_SECRET</code> and <code className="font-mono">RAZORPAY_WEBHOOK_SECRET</code>{" "}
          are set on the server. You can still extend paid time by hand.
        </div>
      )}

      {error && <ErrorBox onRetry={() => { loadOverview(); void loadAccounts(); }}>{error}</ErrorBox>}

      {overview && (
        <p className="text-sm text-slate-500 dark:text-slate-400 m-0">
          {overview.accounts.total} client{overview.accounts.total === 1 ? "" : "s"} · grace period {overview.graceDays} day
          {overview.graceDays === 1 ? "" : "s"} after a missed payment
        </p>
      )}

      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative lg:w-80">
          <IconSearch size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            className="crm-search"
            placeholder="Search business or email"
            aria-label="Search clients"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by state">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                filter === f
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600"
              }`}
            >
              {f === "all" ? "All" : STATE_LABEL[f]}
            </button>
          ))}
        </div>
      </div>

      {items === null ? (
        !error && <PageLoading text="Loading clients…" />
      ) : visible.length === 0 ? (
        <div className="empty-state">{q || filter !== "all" ? "No clients match." : "No clients yet. Create the first one."}</div>
      ) : (
        <div className="table-responsive">
          <table className="table">
            <thead>
              <tr>
                <th>Business</th>
                <th>Owner email</th>
                <th>Plan</th>
                <th>State</th>
                <th>Paid until</th>
                <th className="text-right">Leads</th>
                <th className="text-right">Sent 30d</th>
                <th>Extension seen</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr
                  key={a.id}
                  className="clickable-row"
                  tabIndex={0}
                  onClick={() => navigate(`/admin/clients/${encodeURIComponent(a.id)}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") navigate(`/admin/clients/${encodeURIComponent(a.id)}`);
                  }}
                >
                  <td className="font-semibold">{a.name}</td>
                  <td>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all">{a.owner?.email ?? "—"}</span>
                      
                    </div>
                  </td>
                  <td>{a.billing.plan?.name ?? "—"}</td>
                  <td>
                    <StateBadge state={a.billing.state} />
                  </td>
                  <td className="whitespace-nowrap">{formatDate(a.billing.paidUntil)}</td>
                  <td className="text-right tabular-nums">{a.stats.leads}</td>
                  <td className="text-right tabular-nums">{a.stats.sentLast30d}</td>
                  <td className="whitespace-nowrap text-xs">{formatDateTime(a.stats.lastDeviceSeenAt, "Never")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <NewClientModal
          onClose={() => setShowNew(false)}
          onCreated={() => {
            loadOverview();
            void loadAccounts();
          }}
        />
      )}
    </div>
  );
}

function NewClientModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata");
  const [defaultCountry, setDefaultCountry] = useState("IN");
  const [planId, setPlanId] = useState("");
  const [trialDays, setTrialDays] = useState(7);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ login: LoginCredentials; account: AdminAccount } | null>(null);

  useEffect(() => {
    apiRequest<{ items: Plan[] }>("/api/v1/admin/plans")
      .then((res) => setPlans(res.items.filter((p) => p.active).sort((a, b) => a.position - b.position)))
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90) {
      setError("Trial days must be a whole number from 0 to 90.");
      return;
    }
    if (password && password.length < 12) {
      setError("The password must be at least 12 characters, or leave it empty to generate one.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest<{ account: AdminAccount; login: LoginCredentials }>(
        "/api/v1/admin/accounts",
        {
          method: "POST",
          body: JSON.stringify({
            businessName: businessName.trim(),
            ownerName: ownerName.trim(),
            ownerEmail: ownerEmail.trim(),
            timezone: timezone.trim(),
            defaultCountry: defaultCountry.trim().toUpperCase(),
            planId: planId || undefined,
            trialDays,
            password: password || undefined,
          }),
        }
      );
      setResult(res);
      onCreated();
    } catch (err) {
      setError(apiErrorText(err, "Could not create the client."));
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    return (
      <Modal title="Client created" onClose={onClose}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300 m-0">
            <strong>{result.account.name}</strong> is ready. Give these login details to{" "}
            {result.account.owner?.displayName || ownerName}; they sign in on the login page.
          </p>
          <CredentialsPanel
            email={result.login.email}
            password={result.login.password}
            recipientName={ownerName.trim()}
            businessName={result.account.name}
          />
          <div className="flex justify-end">
            <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="New client" onClose={onClose}>
      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className={fieldClass}>
          Business name *
          <input type="text" required autoFocus value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
        </label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={fieldClass}>
            Owner name *
            <input type="text" required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <label className={fieldClass}>
            Owner email * (their login)
            <input type="email" required value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
          </label>
          <label className={`${fieldClass} sm:col-span-2`}>
            Password (optional)
            <input
              type="text"
              autoComplete="new-password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="font-mono"
              placeholder="Leave empty to generate a strong password"
            />
          </label>
          <label className={fieldClass}>
            Timezone
            <input type="text" required value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </label>
          <label className={fieldClass}>
            Default country
            <input
              type="text"
              required
              maxLength={2}
              value={defaultCountry}
              onChange={(e) => setDefaultCountry(e.target.value.toUpperCase())}
              className="font-mono"
            />
          </label>
          <label className={fieldClass}>
            Plan (optional)
            <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">No plan yet</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {formatINR(p.pricePaise)}/month
                </option>
              ))}
            </select>
          </label>
          <label className={fieldClass}>
            Trial days
            <input
              type="number"
              min={0}
              max={90}
              value={trialDays}
              onChange={(e) => setTrialDays(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
            {submitting ? "Creating…" : "Create client"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
