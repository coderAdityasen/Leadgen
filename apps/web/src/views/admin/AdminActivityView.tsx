import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../api.js";
import { Link } from "../../router.js";
import { apiErrorText, formatDateTime } from "../../format.js";
import type { AdminActivity } from "../../types.js";
import { ErrorBox, PageLoading } from "../../components/BillingParts.js";

const LABELS: Record<string, string> = {
  "account.create": "Created client",
  "account.update": "Updated client",
  "account.reset_password": "Reset password",
  "plan.create": "Created plan",
  "plan.update": "Updated plan",
};

export function activityLabel(action: string): string {
  return LABELS[action] ?? action;
}

/** Short, human summary of what changed. Never shows passwords (they are not logged). */
function summary(item: AdminActivity): string {
  const d = item.detail ?? {};
  switch (item.action) {
    case "account.create": {
      const parts = [d["ownerEmail"] ? `login ${String(d["ownerEmail"])}` : null];
      if (typeof d["trialDays"] === "number" && d["trialDays"] > 0) parts.push(`${d["trialDays"]}-day trial`);
      return parts.filter(Boolean).join(" · ");
    }
    case "account.update": {
      const keys = Object.keys(d);
      const names: Record<string, string> = {
        name: "name",
        notes: "notes",
        planId: "plan",
        status: "status",
        paidUntil: "paid until",
        extendDays: "extended paid time",
        billingExempt: "billing exempt",
      };
      const changed = keys.map((k) => names[k] ?? k);
      const status = typeof d["status"] === "string" ? ` (${d["status"]})` : "";
      return changed.length ? `Changed ${changed.join(", ")}${status}` : "";
    }
    case "account.reset_password":
      return "New password issued; client signed out";
    case "plan.create":
    case "plan.update":
      return typeof d["name"] === "string" ? String(d["name"]) : "";
    default:
      return "";
  }
}

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All" },
  { key: "account", label: "Clients" },
  { key: "account.reset_password", label: "Password resets" },
  { key: "plan", label: "Plans" },
];

export function AdminActivityView() {
  const [items, setItems] = useState<AdminActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<{ items: AdminActivity[] }>("/api/v1/admin/activity?limit=200");
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "Could not load activity."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () =>
      (items ?? []).filter((i) =>
        filter === "all" ? true : filter.includes(".") ? i.action === filter : i.action.startsWith(`${filter}.`)
      ),
    [items, filter]
  );

  return (
    <div className="view-container animate-fade-in space-y-6">
      <div className="view-header">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">Activity</h1>
        <p className="text-base text-slate-500 dark:text-slate-400 mt-1">
          Every change made in the admin console, newest first (last 200).
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              filter === f.key
                ? "bg-violet-600 border-violet-600 text-white"
                : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <ErrorBox onRetry={() => void load()}>{error}</ErrorBox>}

      {items === null ? (
        !error && <PageLoading text="Loading activity…" />
      ) : visible.length === 0 ? (
        <div className="empty-state">No activity yet.</div>
      ) : (
        <div className="table-responsive">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Client</th>
                <th>Details</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <td className="whitespace-nowrap text-xs">{formatDateTime(item.createdAt)}</td>
                  <td className="font-semibold whitespace-nowrap">{activityLabel(item.action)}</td>
                  <td>
                    {item.account ? (
                      <Link
                        href={`/admin/clients/${encodeURIComponent(item.account.id)}`}
                        className="text-violet-600 dark:text-violet-400 hover:underline"
                      >
                        {item.account.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="text-sm text-slate-600 dark:text-slate-300">{summary(item) || "—"}</td>
                  <td className="text-xs break-all">{item.actor?.email ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
