import { useEffect, useState } from "react";
import { apiRequest } from "../api.js";

export type ConnectionStatus = "sender" | "standby" | "grace" | "quiet" | "unpaired";

interface StatusResponse {
  connection?: ConnectionStatus;
  sender?: {
    label?: string;
  };
}

/**
 * Polls /status once for the whole layout. Call this a single time (in the
 * layout) and pass the result to every <HeaderChip status=...> instance so we
 * don't run one poller per rendered chip.
 */
export function useConnectionStatus(enabled = true): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>("unpaired");

  useEffect(() => {
    let active = true;
    const fetchStatus = async () => {
      try {
        const res = await apiRequest<StatusResponse>("/api/v1/status");
        if (active && res.connection) {
          setStatus(res.connection);
        }
      } catch {
        if (active) setStatus("unpaired");
      }
    };

    if (!enabled) return;
    fetchStatus();
    const timer = setInterval(fetchStatus, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled]);

  return status;
}

export function HeaderChip({ status }: { status: ConnectionStatus }) {

  const labelMap: Record<ConnectionStatus, string> = {
    sender: "Sender Active",
    grace: "Reconnecting",
    standby: "Standby",
    quiet: "Extension Quiet",
    unpaired: "Not Paired",
  };

  const styleMap: Record<ConnectionStatus, { bg: string; dot: string; text: string; border: string }> = {
    sender: {
      bg: "bg-emerald-50 dark:bg-emerald-950/60",
      border: "border-emerald-200 dark:border-emerald-800",
      text: "text-emerald-700 dark:text-emerald-400",
      dot: "bg-emerald-500 animate-pulse",
    },
    grace: {
      bg: "bg-amber-50 dark:bg-amber-950/60",
      border: "border-amber-200 dark:border-amber-800",
      text: "text-amber-700 dark:text-amber-400",
      dot: "bg-amber-500 animate-pulse",
    },
    standby: {
      bg: "bg-blue-50 dark:bg-blue-950/60",
      border: "border-blue-200 dark:border-blue-800",
      text: "text-blue-700 dark:text-blue-400",
      dot: "bg-blue-500",
    },
    quiet: {
      bg: "bg-orange-50 dark:bg-orange-950/60",
      border: "border-orange-200 dark:border-orange-800",
      text: "text-orange-700 dark:text-orange-400",
      dot: "bg-orange-500",
    },
    unpaired: {
      bg: "bg-slate-100 dark:bg-slate-800",
      border: "border-slate-200 dark:border-slate-700",
      text: "text-slate-600 dark:text-slate-400",
      dot: "bg-slate-400",
    },
  };

  const current = styleMap[status];

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold border transition-all ${current.bg} ${current.border} ${current.text}`}
      role="status"
      aria-label={`Connection state: ${labelMap[status]}`}
    >
      <span className={`w-2 h-2 rounded-full ${current.dot}`} />
      <span>{labelMap[status]}</span>
    </div>
  );
}
