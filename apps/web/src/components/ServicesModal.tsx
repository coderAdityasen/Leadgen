import { useEffect, useState } from "react";
import { apiRequest } from "../api.js";
import { useRouter } from "../router.js";

interface StatusData {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  schemaVersion: number;
  dbWritable: boolean;
  connection: "sender" | "standby" | "grace" | "quiet" | "unpaired";
  sender: {
    deviceId: string;
    label: string;
    lastSeenAt: string;
    heartbeatAgeSeconds: number;
    leaseUntil: string | null;
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
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
  };
  killSwitch: {
    sending: boolean;
    ai: boolean;
  };
  red: string[];
}

export function ServicesModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { navigate } = useRouter();
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = async () => {
    try {
      const data = await apiRequest<StatusData>("/api/v1/status");
      setStatus(data);
    } catch {
      // Fallback
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      fetchStatus();
      const interval = setInterval(fetchStatus, 5000);

      // Keyboard Esc to close
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", handleKeyDown);

      return () => {
        clearInterval(interval);
        window.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleNavigate = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="services-modal-title"
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden animate-scale-in">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-7 py-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
              <h2 id="services-modal-title" className="text-xl font-bold text-slate-900 dark:text-white m-0">
                Services Control Center
              </h2>
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 font-mono font-bold">
                v{status?.version || "0.1.0"}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-0">
              Live background service governors, sender lease health, and rate limits
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-7 overflow-y-auto space-y-3.5">
          {loading && !status ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 py-8 text-center">Loading live telemetry...</p>
          ) : (
            <>
              {/* WhatsApp Extension Bridge */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 hover:bg-white dark:hover:bg-slate-800 transition-all flex items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <span
                    className={`w-3.5 h-3.5 rounded-full shrink-0 ${
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
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white m-0">
                      WhatsApp Web Extension Lease
                    </h3>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      State:{" "}
                      <strong className="text-slate-800 dark:text-slate-200 capitalize">
                        {status?.connection === "sender"
                          ? "Active Sender"
                          : status?.connection === "grace"
                          ? "Reconnecting"
                          : status?.connection === "standby"
                          ? "Standby"
                          : "Unpaired"}
                      </strong>
                      {status?.sender && (
                        <span className="ml-2 font-mono text-xs">
                          ({status.sender.label} · heartbeat {status.sender.heartbeatAgeSeconds}s ago)
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleNavigate("/connection")}
                  className="btn btn-secondary text-xs px-3.5 py-1.5 whitespace-nowrap"
                >
                  Manage →
                </button>
              </div>

              {/* SpaceXSI AI Engine */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 hover:bg-white dark:hover:bg-slate-800 transition-all flex items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <span
                    className={`w-3.5 h-3.5 rounded-full shrink-0 ${
                      status?.ai.keySet ? "bg-emerald-500" : "bg-slate-400"
                    }`}
                  />
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white m-0">
                      SpaceXSI Grok-4.7 Engine
                    </h3>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Key:{" "}
                      <strong className={status?.ai.keySet ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500"}>
                        {status?.ai.keySet ? "Configured (AES-256-GCM)" : "None"}
                      </strong>
                      {" · "}Usage:{" "}
                      <strong className="text-slate-800 dark:text-slate-200">
                        {status?.caps.aiThisHour} / {status?.caps.aiHourlyCap} calls/hr
                      </strong>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleNavigate("/ai")}
                  className="btn btn-secondary text-xs px-3.5 py-1.5 whitespace-nowrap"
                >
                  Configure →
                </button>
              </div>

              {/* Queue & Send Governor */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 hover:bg-white dark:hover:bg-slate-800 transition-all flex items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <span
                    className={`w-3.5 h-3.5 rounded-full shrink-0 ${
                      !status?.killSwitch.sending ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white m-0">
                      Outbound Queue &amp; Send Governor
                    </h3>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Today:{" "}
                      <strong className="text-slate-800 dark:text-slate-200">
                        {status?.caps.automatedToday} / {status?.caps.automatedCap}
                      </strong>
                      {" · "}Due Now: <strong className="text-slate-800 dark:text-slate-200">{status?.queue.dueNow}</strong>
                      {" · "}Pending Review:{" "}
                      <strong className="text-slate-800 dark:text-slate-200">{status?.queue.needsApproval}</strong>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleNavigate("/queue")}
                  className="btn btn-secondary text-xs px-3.5 py-1.5 whitespace-nowrap"
                >
                  Queue →
                </button>
              </div>

              {/* Drip Sequences */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 hover:bg-white dark:hover:bg-slate-800 transition-all flex items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <span className="w-3.5 h-3.5 rounded-full bg-emerald-500 shrink-0" />
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white m-0">
                      Follow-up Sequence Automation
                    </h3>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Advancement: <strong className="text-slate-800 dark:text-slate-200">Delivery-Triggered</strong>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleNavigate("/sequences")}
                  className="btn btn-secondary text-xs px-3.5 py-1.5 whitespace-nowrap"
                >
                  Sequences →
                </button>
              </div>

              {/* Database & Backups */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 hover:bg-white dark:hover:bg-slate-800 transition-all flex items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <span
                    className={`w-3.5 h-3.5 rounded-full shrink-0 ${
                      status?.dbWritable ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white m-0">
                      SQLite WAL &amp; Daily Backup Engine
                    </h3>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      State:{" "}
                      <strong className="text-emerald-600 dark:text-emerald-400">Healthy &amp; Writable</strong> · 14-day retention
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleNavigate("/settings")}
                  className="btn btn-secondary text-xs px-3.5 py-1.5 whitespace-nowrap"
                >
                  Settings →
                </button>
              </div>
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-7 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <div>Server Uptime: {Math.floor((status?.uptimeSeconds ?? 0) / 60)} minutes</div>
          <button
            onClick={onClose}
            className="btn btn-primary text-sm px-5 py-2 font-semibold"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
