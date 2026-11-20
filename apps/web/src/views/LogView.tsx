import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../api.js";
import { Link } from "../router.js";

interface MessageItem {
  id: string;
  leadId: string | null;
  direction: "inbound" | "outbound";
  waMessageId: string | null;
  body: string;
  fromMe: boolean;
  waTimestamp: string;
  aiState: "pending" | "drafted" | "skipped" | "failed" | null;
  aiReason: string | null;
  outboundId: string | null;
  createdAt: string;
}

export function LogView() {
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [leadFilter, setLeadFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Monotonic id so slow, out-of-order responses never overwrite newer results.
  const requestSeq = useRef(0);

  const buildUrl = (leadId: string, cursor?: string | null) => {
    const params = new URLSearchParams();
    if (leadId) params.set("leadId", leadId);
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    return `/api/v1/messages${qs ? `?${qs}` : ""}`;
  };

  const fetchMessages = async (leadId: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ items: MessageItem[]; nextCursor?: string | null }>(buildUrl(leadId));
      if (seq !== requestSeq.current) return;
      setMessages(res.items);
      setNextCursor(res.nextCursor ?? null);
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      setError((err as { message?: string }).message || "Failed to load message log");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!nextCursor) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const res = await apiRequest<{ items: MessageItem[]; nextCursor?: string | null }>(
        buildUrl(debouncedFilter, nextCursor)
      );
      if (seq !== requestSeq.current) return;
      setMessages((prev) => [...prev, ...res.items.filter((r) => !prev.some((p) => p.id === r.id))]);
      setNextCursor(res.nextCursor ?? null);
    } catch (err: unknown) {
      if (seq === requestSeq.current) {
        setError((err as { message?: string }).message || "Failed to load more messages");
      }
    } finally {
      setLoadingMore(false);
    }
  };

  // Debounce the lead filter (~300ms).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilter(leadFilter.trim()), 300);
    return () => clearTimeout(t);
  }, [leadFilter]);

  useEffect(() => {
    fetchMessages(debouncedFilter);
  }, [debouncedFilter]);

  return (
    <div className="view-container animate-fade-in space-y-6">
      {/* Header & Filter */}
      <div className="view-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">
            Message Audit Log
          </h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1">
            Real-time audit transcript of WhatsApp inbound and outbound dispatches with AI reasoning.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <input
              type="text"
              placeholder="Filter by Lead ID (led_...)"
              value={leadFilter}
              onChange={(e) => setLeadFilter(e.target.value)}
              className="w-64 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-mono transition-colors"
            />
          </div>
          {leadFilter && (
            <button
              className="btn btn-secondary text-xs px-3 py-2 rounded-lg"
              onClick={() => setLeadFilter("")}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
          {error}
        </div>
      )}

      {/* Messages Table Card */}
      <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-0 shadow-sm overflow-hidden">
        {loading && messages.length === 0 ? (
          <div className="py-16 text-center text-slate-400 dark:text-slate-500">
            <div className="inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-2" />
            <p className="text-sm">Loading message log...</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="py-16 text-center text-slate-400 dark:text-slate-500">
            <p className="text-sm">No messages recorded in the audit log yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-xs uppercase font-semibold text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-5 py-3.5">Time</th>
                  <th className="px-5 py-3.5">Direction</th>
                  <th className="px-5 py-3.5">Lead</th>
                  <th className="px-5 py-3.5">Message Body</th>
                  <th className="px-5 py-3.5">AI State</th>
                  <th className="px-5 py-3.5">WA Message ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {messages.map((m) => (
                  <tr
                    key={m.id}
                    className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="px-5 py-4 text-xs font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {new Date(m.waTimestamp).toLocaleString()}
                    </td>
                    <td className="px-5 py-4 whitespace-nowrap">
                      {m.direction === "inbound" ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                          Inbound
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300">
                          {m.fromMe ? "Outbound (typed)" : "Outbound (desk)"}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4 whitespace-nowrap">
                      {m.leadId ? (
                        <Link
                          href={`/leads/${m.leadId}`}
                          className="font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          {m.leadId}
                        </Link>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-sm font-mono text-slate-800 dark:text-slate-200 whitespace-pre-wrap max-w-md leading-relaxed">
                      {m.body}
                    </td>
                    <td className="px-5 py-4 whitespace-nowrap">
                      {m.aiState ? (
                        <div>
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                              m.aiState === "drafted"
                                ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                                : m.aiState === "skipped"
                                ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                : "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
                            }`}
                          >
                            {m.aiState}
                          </span>
                          {m.aiReason && (
                            <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-0.5">
                              {m.aiReason}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td
                      className="px-5 py-4 font-mono text-xs text-slate-400 dark:text-slate-500 max-w-xs truncate"
                      title={m.waMessageId || ""}
                    >
                      {m.waMessageId || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {nextCursor && (
              <div className="flex justify-center py-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  className="btn btn-secondary text-sm px-4 py-2 rounded-lg"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
