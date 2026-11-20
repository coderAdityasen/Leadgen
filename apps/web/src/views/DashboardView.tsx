import { useEffect, useState } from "react";
import { apiRequest } from "../api.js";
import { useRouter } from "../router.js";
import { ServicesModal } from "../components/ServicesModal.js";

interface StatusOverview {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  connection: "sender" | "standby" | "grace" | "quiet" | "unpaired";
  sender: {
    label: string;
    heartbeatAgeSeconds: number;
    role: string;
  } | null;
  queue: {
    queued: number;
    claimed: number;
    needsApproval: number;
    needsReview: number;
    failed: number;
    dueNow: number;
  };
  caps: {
    automatedToday: number;
    automatedCap: number;
    manualToday: number;
    manualCap: number;
    aiThisHour: number;
    aiHourlyCap: number;
  };
  ai: {
    keySet: boolean;
    consecutiveFailures: number;
  };
  killSwitch: {
    sending: boolean;
    ai: boolean;
  };
  red: string[];
}

export function DashboardView() {
  const { navigate } = useRouter();
  const [status, setStatus] = useState<StatusOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [servicesModalOpen, setServicesModalOpen] = useState(false);

  const fetchStatus = async () => {
    try {
      const data = await apiRequest<StatusOverview>("/api/v1/status");
      setStatus(data);
    } catch {
      // Fallback
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="view-container animate-fade-in space-y-8">
      {/* Top Welcome Header */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-7 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-5 transition-colors">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white m-0 tracking-tight">
              Operator Command Center
            </h1>
            <span className="px-3 py-1 rounded-full text-xs font-bold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
              Single-Operator Desk
            </span>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5 mb-0 leading-relaxed">
            WhatsApp integration, outbound queue approvals, Grok AI assistant, and drip nurture sequences.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => setServicesModalOpen(true)}
            className="px-4 py-2.5 rounded-xl bg-slate-900 dark:bg-slate-800 text-white font-semibold text-sm hover:bg-slate-800 dark:hover:bg-slate-700 transition-all shadow-sm flex items-center gap-2.5 active:scale-95 border border-slate-800 dark:border-slate-700"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Manage Services</span>
          </button>

          <button
            onClick={() => navigate("/leads?new=1")}
            className="btn btn-primary text-sm px-4.5 py-2.5 flex items-center gap-2 active:scale-95"
          >
            <span>+</span>
            <span>Add New Lead</span>
          </button>
        </div>
      </div>

      {/* Services Modal Drawer */}
      <ServicesModal isOpen={servicesModalOpen} onClose={() => setServicesModalOpen(false)} />

      {/* Metric Cards Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Card 1: WhatsApp Extension */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md transition-all flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Extension Lease
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500 font-medium">Single Sender</span>
          </div>

          <div className="my-4 flex items-center gap-3">
            <span
              className={`w-4 h-4 rounded-full shrink-0 ${
                status?.connection === "sender"
                  ? "bg-emerald-500 animate-pulse"
                  : status?.connection === "grace"
                  ? "bg-amber-500 animate-pulse"
                  : status?.connection === "standby"
                  ? "bg-blue-500"
                  : "bg-slate-400"
              }`}
            />
            <div>
              <div className="text-lg font-bold text-slate-900 dark:text-white capitalize">
                {status?.connection === "sender"
                  ? "Connected (Sender)"
                  : status?.connection === "grace"
                  ? "Grace Recovery"
                  : status?.connection === "standby"
                  ? "Standby Mode"
                  : status?.connection === "quiet"
                  ? "Extension Quiet"
                  : "Not Paired"}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {status?.sender ? `${status.sender.label} · active` : "Open WhatsApp Web"}
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-between items-center text-xs">
            <span className="text-slate-500 dark:text-slate-400">
              Heartbeat: {status?.sender?.heartbeatAgeSeconds ?? "—"}s
            </span>
            <button
              onClick={() => navigate("/connection")}
              className="text-indigo-600 dark:text-indigo-400 hover:underline font-bold text-xs transition-colors"
            >
              Connection Settings →
            </button>
          </div>
        </div>

        {/* Card 2: AI Reply Engine */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md transition-all flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              AI Assistant
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500 font-medium">Grok-4.7</span>
          </div>

          <div className="my-4 flex items-center gap-3">
            <span
              className={`w-4 h-4 rounded-full shrink-0 ${
                status?.ai.keySet ? "bg-emerald-500" : "bg-slate-400"
              }`}
            />
            <div>
              <div className="text-lg font-bold text-slate-900 dark:text-white">
                {status?.ai.keySet ? "Grok-4.7 Ready" : "Key Required"}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                This Hour: {status?.caps.aiThisHour ?? 0} / {status?.caps.aiHourlyCap ?? 30} calls
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-between items-center text-xs">
            <span className="text-slate-500 dark:text-slate-400">
              {status?.killSwitch.ai ? "Kill Switch Active" : "Operational"}
            </span>
            <button
              onClick={() => navigate("/ai")}
              className="text-indigo-600 dark:text-indigo-400 hover:underline font-bold text-xs transition-colors"
            >
              AI Settings →
            </button>
          </div>
        </div>

        {/* Card 3: Outbound Queue & Approval */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md transition-all flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Approval Queue
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500 font-medium">Human Review</span>
          </div>

          <div className="my-3 flex items-center gap-3">
            <div className="text-3xl font-extrabold text-slate-900 dark:text-white">
              {status?.queue.needsApproval ?? 0}
            </div>
            <div>
              <div className="text-sm font-bold text-slate-900 dark:text-white">Drafts Pending Review</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {status?.queue.queued ?? 0} queued · {status?.queue.dueNow ?? 0} due now
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-between items-center text-xs">
            <span className="text-slate-500 dark:text-slate-400">{status?.queue.failed ?? 0} failed / review</span>
            <button
              onClick={() => navigate("/queue")}
              className="text-indigo-600 dark:text-indigo-400 hover:underline font-bold text-xs transition-colors"
            >
              Open Queue →
            </button>
          </div>
        </div>

        {/* Card 4: Daily Guardrail Caps */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 border border-slate-200 dark:border-slate-800 shadow-sm hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md transition-all flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Daily Send Caps
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500 font-medium">Anti-Ban</span>
          </div>

          <div className="my-2 space-y-2.5">
            <div>
              <div className="flex justify-between items-center text-xs mb-1">
                <span className="text-slate-500 dark:text-slate-400 font-medium">Automated:</span>
                <span className="font-bold text-slate-900 dark:text-white">
                  {status?.caps.automatedToday ?? 0} / {status?.caps.automatedCap ?? 80}
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-indigo-600 dark:bg-indigo-500 rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.min(
                      100,
                      ((status?.caps.automatedToday ?? 0) / (status?.caps.automatedCap || 80)) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center text-xs mb-1">
                <span className="text-slate-500 dark:text-slate-400 font-medium">Manual:</span>
                <span className="font-bold text-slate-900 dark:text-white">
                  {status?.caps.manualToday ?? 0} / {status?.caps.manualCap ?? 200}
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-slate-600 dark:bg-slate-400 rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.min(
                      100,
                      ((status?.caps.manualToday ?? 0) / (status?.caps.manualCap || 200)) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-between items-center text-xs">
            <span className="text-slate-500 dark:text-slate-400">Resets midnight</span>
            <button
              onClick={() => navigate("/settings")}
              className="text-indigo-600 dark:text-indigo-400 hover:underline font-bold text-xs transition-colors"
            >
              Policy →
            </button>
          </div>
        </div>
      </div>

      {/* Core Features Hub */}
      <div>
        <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4 tracking-tight">
          Core Workspaces
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Workspace 1: Leads & Conversations */}
          <div
            onClick={() => navigate("/leads")}
            className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md hover:border-indigo-500/60 cursor-pointer transition-all duration-200 group"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-2xl group-hover:scale-105 transition-transform">
                👥
              </div>
              <span className="text-xs text-indigo-600 dark:text-indigo-400 font-bold group-hover:translate-x-1 transition-transform">
                Open Leads →
              </span>
            </div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white m-0 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
              Leads &amp; Pipelines
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed m-0">
              Manage contacts across custom pipeline stages, normalize national phone numbers, take notes, and enroll in sequences.
            </p>
          </div>

          {/* Workspace 2: Drip Sequences */}
          <div
            onClick={() => navigate("/sequences")}
            className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md hover:border-emerald-500/60 cursor-pointer transition-all duration-200 group"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center text-emerald-600 dark:text-emerald-400 text-2xl group-hover:scale-105 transition-transform">
                ⚡
              </div>
              <span className="text-xs text-emerald-600 dark:text-emerald-400 font-bold group-hover:translate-x-1 transition-transform">
                Open Sequences →
              </span>
            </div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white m-0 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
              Follow-up Sequences
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed m-0">
              Automated WhatsApp nurture workflows. Steps advance strictly after delivery acknowledgment from WhatsApp.
            </p>
          </div>

          {/* Workspace 3: Message Audit Log */}
          <div
            onClick={() => navigate("/log")}
            className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md hover:border-blue-500/60 cursor-pointer transition-all duration-200 group"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 rounded-xl bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 flex items-center justify-center text-blue-600 dark:text-blue-400 text-2xl group-hover:scale-105 transition-transform">
                📜
              </div>
              <span className="text-xs text-blue-600 dark:text-blue-400 font-bold group-hover:translate-x-1 transition-transform">
                Open Audit Log →
              </span>
            </div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white m-0 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
              Message Audit Log
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed m-0">
              Audit trail of all direct WhatsApp messages with deduplication hashes, LID mappings, and AI states.
            </p>
          </div>
        </div>
      </div>

      {/* Safety Guardrails */}
      <div className="bg-slate-50 dark:bg-slate-900/60 rounded-2xl p-7 border border-slate-200 dark:border-slate-800 space-y-4 transition-colors">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-indigo-600 dark:text-indigo-400 text-xl">🛡️</span>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white m-0 uppercase tracking-wider">
              Safety Guardrails &amp; Anti-Ban Protections
            </h3>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Automatic system enforcements</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          <div className="p-4 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm space-y-1">
            <div className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-1.5">
              <span>⏱️</span> 45s Automated Spacing
            </div>
            <p className="text-slate-500 dark:text-slate-400 m-0 leading-relaxed text-xs">
              Server enforces a 45s minimum delay between automated messages and 180s for the same lead.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm space-y-1">
            <div className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-1.5">
              <span>🌙</span> Quiet Hours Roll
            </div>
            <p className="text-slate-500 dark:text-slate-400 m-0 leading-relaxed text-xs">
              Scheduled messages roll forward to opening minute. AI drafts hitting quiet hours are discarded.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm space-y-1">
            <div className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-1.5">
              <span>🔒</span> Zero Duplicate Bubbles
            </div>
            <p className="text-slate-500 dark:text-slate-400 m-0 leading-relaxed text-xs">
              Outbox mirror state machine tracks sending, submitted, and uncertain phases to eliminate duplicate sends.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm space-y-1">
            <div className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-1.5">
              <span>💾</span> Online SQLite Backups
            </div>
            <p className="text-slate-500 dark:text-slate-400 m-0 leading-relaxed text-xs">
              Native SQLite backup API snapshots to <code>data/backups/</code> with 14-day rolling retention.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
