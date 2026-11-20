import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../api.js";
import { Link, useRouter } from "../../router.js";
import { apiErrorText, formatDate, formatDateTime, formatINR } from "../../format.js";
import type { AdminAccount, AdminActivity, AdminOverview } from "../../types.js";
import { IconPlus } from "../../components/icons.js";
import { ErrorBox, PageLoading, StateBadge, cardClass } from "../../components/BillingParts.js";
import { activityLabel } from "./AdminActivityView.js";

const ONLINE_MS = 10 * 60_000;

export function AdminOverviewView() {
  const { navigate } = useRouter();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [activity, setActivity] = useState<AdminActivity[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, a, act] = await Promise.all([
        apiRequest<AdminOverview>("/api/v1/admin/overview"),
        apiRequest<{ items: AdminAccount[] }>("/api/v1/admin/accounts"),
        apiRequest<{ items: AdminActivity[] }>("/api/v1/admin/activity?limit=8"),
      ]);
      setOverview(o);
      setAccounts(a.items);
      setActivity(act.items);
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "Could not load the overview."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !overview) return <ErrorBox onRetry={() => void load()}>{error}</ErrorBox>;
  if (!overview || !accounts) return <PageLoading text="Loading overview…" />;

  const now = Date.now();
  const totals = accounts.reduce(
    (t, a) => ({
      leads: t.leads + a.stats.leads,
      sent: t.sent + a.stats.sentLast30d,
      online: t.online + (a.stats.lastDeviceSeenAt && now - Date.parse(a.stats.lastDeviceSeenAt) < ONLINE_MS ? 1 : 0),
    }),
    { leads: 0, sent: 0, online: 0 }
  );
  const attention = accounts
    .filter((a) => a.billing.state === "grace" || a.billing.state === "expired" || a.billing.state === "suspended")
    .slice(0, 8);
  const newest = accounts.slice(0, 5);

  const tiles: Array<{ label: string; value: string; tone?: string; hint?: string }> = [
    { label: "Clients", value: String(overview.accounts.total) },
    { label: "Active", value: String(overview.accounts.active), tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "In grace", value: String(overview.accounts.grace), tone: "text-amber-600 dark:text-amber-400" },
    { label: "Expired", value: String(overview.accounts.expired), tone: "text-rose-600 dark:text-rose-400" },
    { label: "Suspended", value: String(overview.accounts.suspended), tone: "text-rose-600 dark:text-rose-400" },
    { label: "Monthly revenue", value: formatINR(overview.mrrPaise), tone: "text-violet-600 dark:text-violet-400", hint: "active subscriptions" },
  ];

  return (
    <div className="view-container animate-fade-in space-y-6">
      <div className="view-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">Overview</h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1">Your clients, revenue and recent admin activity.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm inline-flex items-center gap-1.5"
          onClick={() => navigate("/admin/clients?new=1")}
        >
          <IconPlus size={14} /> New client
        </button>
      </div>

      {!overview.razorpayEnabled && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200 text-sm">
          Razorpay is not configured, so clients cannot pay online yet. You can still extend paid time by hand on a
          client's page.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className={`${cardClass} p-4`}>
            <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{t.label}</div>
            <div className={`mt-1 text-2xl font-extrabold tabular-nums ${t.tone ?? "text-slate-900 dark:text-white"}`}>{t.value}</div>
            {t.hint && <div className="text-[11px] text-slate-400 mt-0.5">{t.hint}</div>}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Usage label="Leads across clients" value={totals.leads} />
        <Usage label="Messages sent (30 days)" value={totals.sent} />
        <Usage label="Extensions online now" value={totals.online} hint={`of ${accounts.length} client${accounts.length === 1 ? "" : "s"}`} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className={`${cardClass} p-5 space-y-3`}>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Needs attention</h2>
            <span className="text-xs text-slate-500">grace · expired · suspended</span>
          </div>
          {attention.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 m-0">Every client is paid up. Nothing to do.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800 m-0 p-0 list-none">
              {attention.map((a) => (
                <li key={a.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/admin/clients/${encodeURIComponent(a.id)}`} className="font-semibold text-slate-900 dark:text-white hover:underline">
                      {a.name}
                    </Link>
                    <div className="text-xs text-slate-500 truncate">
                      {a.billing.state === "grace"
                        ? `Sending stops ${formatDate(a.billing.graceEndsAt)}`
                        : a.billing.state === "expired"
                          ? `Paid until ${formatDate(a.billing.paidUntil, "never")}`
                          : "Suspended by admin"}
                    </div>
                  </div>
                  <StateBadge state={a.billing.state} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${cardClass} p-5 space-y-3`}>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Recent activity</h2>
            <Link href="/admin/activity" className="text-sm font-semibold text-violet-600 dark:text-violet-400">
              View all
            </Link>
          </div>
          {activity.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 m-0">No admin actions yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800 m-0 p-0 list-none">
              {activity.map((item) => (
                <li key={item.id} className="py-2.5 flex items-start justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="font-semibold text-slate-900 dark:text-white">{activityLabel(item.action)}</span>
                    {item.account && <span className="text-slate-500"> · {item.account.name}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500 whitespace-nowrap">{formatDateTime(item.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={`${cardClass} p-5 space-y-3`}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Newest clients</h2>
          <Link href="/admin/clients" className="text-sm font-semibold text-violet-600 dark:text-violet-400">
            All clients
          </Link>
        </div>
        {newest.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400 m-0">
            No clients yet. Use <strong>New client</strong> to create the first login.
          </p>
        ) : (
          <div className="table-responsive">
            <table className="table">
              <thead>
                <tr>
                  <th>Business</th>
                  <th>Owner</th>
                  <th>State</th>
                  <th>Created</th>
                  <th>Last login</th>
                </tr>
              </thead>
              <tbody>
                {newest.map((a) => (
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
                    <td className="break-all">{a.owner?.email ?? "—"}</td>
                    <td>
                      <StateBadge state={a.billing.state} />
                    </td>
                    <td className="whitespace-nowrap">{formatDate(a.createdAt)}</td>
                    <td className="whitespace-nowrap text-xs">{formatDateTime(a.owner?.lastLoginAt, "Never")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Usage({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className={`${cardClass} p-4 flex items-baseline justify-between gap-3`}>
      <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">{label}</span>
      <span className="text-right">
        <span className="text-xl font-extrabold tabular-nums text-slate-900 dark:text-white">{value.toLocaleString("en-IN")}</span>
        {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
      </span>
    </div>
  );
}
