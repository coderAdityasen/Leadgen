import { useEffect, useState } from "react";
import { apiRequest } from "../api.js";

interface PolicyData {
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  dailyAutomatedCap: number;
  dailyManualCap: number;
  minAutomatedGapSeconds: number;
  minSameLeadGapSeconds: number;
  aiHourlyCap: number;
  maxCatchupAgeSeconds: number;
  sendingKillSwitch: boolean;
  aiKillSwitch: boolean;
}

export function SettingsView() {
  const [policy, setPolicy] = useState<PolicyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [pwdMsg, setPwdMsg] = useState<string | null>(null);
  const [pwdErr, setPwdErr] = useState<string | null>(null);
  const [pwdSubmitting, setPwdSubmitting] = useState(false);

  const loadPolicy = async () => {
    setLoading(true);
    try {
      const res = await apiRequest<PolicyData>("/api/v1/desk-policy");
      setPolicy(res);
    } catch (err: unknown) {
      setError((err as { message?: string }).message || "Failed to load desk policy");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPolicy();
  }, []);

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!policy) return;
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const res = await apiRequest<PolicyData>("/api/v1/desk-policy", {
        method: "PUT",
        // Kill switches are env-driven on the server and ignored on PUT.
        body: JSON.stringify({ ...policy, sendingKillSwitch: undefined, aiKillSwitch: undefined }),
      });
      setPolicy(res);
      setSuccess("Desk policy and safety guardrails saved successfully.");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: unknown) {
      setError((err as { message?: string }).message || "Failed to save policy");
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdMsg(null);
    setPwdErr(null);
    setPwdSubmitting(true);
    try {
      await apiRequest("/api/v1/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, nextPassword }),
      });
      setPwdMsg("Password updated successfully. Other active sessions have been revoked.");
      setCurrentPassword("");
      setNextPassword("");
      setTimeout(() => setPwdMsg(null), 4000);
    } catch (err: unknown) {
      setPwdErr((err as { message?: string }).message || "Failed to update password");
    } finally {
      setPwdSubmitting(false);
    }
  };

  if (!loading && !policy) {
    return (
      <div className="view-container animate-fade-in space-y-4">
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
          {error || "Failed to load desk policy"}
        </div>
        <button type="button" onClick={() => { setError(null); loadPolicy(); }} className="btn btn-secondary text-sm px-5 py-2.5 font-medium rounded-lg">
          Retry
        </button>
      </div>
    );
  }

  if (loading || !policy) {
    return (
      <div className="py-24 text-center text-slate-400 dark:text-slate-500">
        <div className="inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-2" />
        <p className="text-sm">Loading policy settings...</p>
      </div>
    );
  }

  return (
    <div className="view-container animate-fade-in space-y-6">
      {/* View Header */}
      <div className="view-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">
            System Settings &amp; Desk Policy
          </h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1">
            Configure anti-ban guardrails, quiet hours, rate limits, kill switches, and operator security.
          </p>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
          {error}
        </div>
      )}

      {success && (
        <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300 text-sm">
          {success}
        </div>
      )}

      <form onSubmit={handleSavePolicy} className="space-y-6">
        {/* Anti-Ban & Quiet Hours Card */}
        <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-5">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">
            Quiet Hours Protection
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Prevents messages from dispatching during overnight hours. Messages are rolled to the start of active hours.
          </p>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={policy.quietHoursEnabled}
              onChange={(e) => setPolicy({ ...policy, quietHoursEnabled: e.target.checked })}
              className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500"
            />
            <span className="font-semibold text-sm text-slate-900 dark:text-white">
              Enable Quiet Hours Enforcer
            </span>
          </label>

          {policy.quietHoursEnabled && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div>
                <label className="text-xs font-bold text-slate-500 dark:text-slate-400 block mb-1.5 uppercase tracking-wider">
                  Quiet Window Start (Local Time)
                </label>
                <input
                  type="text"
                  placeholder="22:00"
                  value={policy.quietStart}
                  onChange={(e) => setPolicy({ ...policy, quietStart: e.target.value })}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
                />
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 dark:text-slate-400 block mb-1.5 uppercase tracking-wider">
                  Quiet Window End (Local Time)
                </label>
                <input
                  type="text"
                  placeholder="08:00"
                  value={policy.quietEnd}
                  onChange={(e) => setPolicy({ ...policy, quietEnd: e.target.value })}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
                />
              </div>
            </div>
          )}
        </div>

        {/* Rate Limiting & Delays Card */}
        <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-5">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">
            Dispatch Caps &amp; Pacing Intervals
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-500 dark:text-slate-400 block mb-1.5 uppercase tracking-wider">
                Daily Automated Cap (Messages / Day)
              </label>
              <input
                type="number"
                min={1}
                value={policy.dailyAutomatedCap}
                onChange={(e) => setPolicy({ ...policy, dailyAutomatedCap: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-500 dark:text-slate-400 block mb-1.5 uppercase tracking-wider">
                Daily Manual Cap (Messages / Day)
              </label>
              <input
                type="number"
                min={1}
                value={policy.dailyManualCap}
                onChange={(e) => setPolicy({ ...policy, dailyManualCap: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-500 dark:text-slate-400 block mb-1.5 uppercase tracking-wider">
                Min Automated Gap (Seconds between sends)
              </label>
              <input
                type="number"
                min={1}
                value={policy.minAutomatedGapSeconds}
                onChange={(e) => setPolicy({ ...policy, minAutomatedGapSeconds: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-500 dark:text-slate-400 block mb-1.5 uppercase tracking-wider">
                Min Same-Lead Gap (Seconds between same contact)
              </label>
              <input
                type="number"
                min={1}
                value={policy.minSameLeadGapSeconds}
                onChange={(e) => setPolicy({ ...policy, minSameLeadGapSeconds: Number(e.target.value) })}
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
              />
            </div>
          </div>
        </div>

        {/* Emergency Kill Switches Card */}
        <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">
            Emergency Kill Switches
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Instant circuit breakers that halt operations immediately across all workers and extension senders.
          </p>

          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-3 p-3.5 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/40 dark:bg-rose-950/20">
              <span
                className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider border ${
                  policy.sendingKillSwitch
                    ? "bg-rose-600 text-white border-rose-600"
                    : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700"
                }`}
              >
                {policy.sendingKillSwitch ? "Engaged" : "Off"}
              </span>
              <div>
                <span className="font-bold text-sm text-rose-600 dark:text-rose-400 block">
                  Global Sending Kill Switch
                </span>
                <span className="text-xs text-rose-500/80 dark:text-rose-400/70">
                  Blocks all outgoing message dispatches across manual, sequence, and AI flows.
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3 p-3.5 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/40 dark:bg-amber-950/20">
              <span
                className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider border ${
                  policy.aiKillSwitch
                    ? "bg-amber-600 text-white border-amber-600"
                    : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700"
                }`}
              >
                {policy.aiKillSwitch ? "Engaged" : "Off"}
              </span>
              <div>
                <span className="font-bold text-sm text-amber-600 dark:text-amber-400 block">
                  AI Generation Kill Switch
                </span>
                <span className="text-xs text-amber-500/80 dark:text-amber-400/70">
                  Prevents AI reply generation, forcing fallback to the human operator.
                </span>
              </div>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">
              Read-only. These switches are set via the{" "}
              <code className="font-mono">LEAD_DESK_SENDING_ENABLED</code> /{" "}
              <code className="font-mono">LEAD_DESK_AI_ENABLED</code> environment variables on the server
              (set to <code className="font-mono">false</code> to engage) and take effect after a restart.
            </p>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={saving}
            className="btn btn-primary text-sm px-6 py-2.5 font-bold rounded-lg"
          >
            {saving ? "Saving Policy..." : "Save Desk Policy"}
          </button>
        </div>
      </form>

      {/* Operator Security Card */}
      <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
        <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">
          Operator Account Security
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Update the master operator password. All other active sessions and cookies will be revoked immediately.
        </p>

        {pwdMsg && (
          <div className="p-3.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300 text-sm">
            {pwdMsg}
          </div>
        )}

        {pwdErr && (
          <div className="p-3.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
            {pwdErr}
          </div>
        )}

        <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
          <div>
            <label className="text-xs font-bold text-slate-500 dark:text-slate-400 block mb-1.5 uppercase tracking-wider">
              Current Password
            </label>
            <input
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-slate-500 dark:text-slate-400 block mb-1.5 uppercase tracking-wider">
              New Password (minimum 12 characters)
            </label>
            <input
              type="password"
              required
              minLength={12}
              value={nextPassword}
              onChange={(e) => setNextPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={pwdSubmitting}
            className="btn btn-secondary text-sm px-5 py-2.5 font-medium rounded-lg"
          >
            {pwdSubmitting ? "Updating..." : "Update Password"}
          </button>
        </form>
      </div>
    </div>
  );
}
