import { useEffect, useState } from "react";
import { apiRequest } from "../api.js";

interface OutboundItem {
  id: string;
  leadId: string;
  toE164: string;
  toJid: string | null;
  body: string;
  kind: string;
  status: string;
  dueAt: string;
  attemptCount: number;
  lastError: string | null;
  waMessageId: string | null;
  createdAt: string;
  sentAt: string | null;
}

const TABS = [
  { id: "queued", label: "Queued" },
  { id: "needs_approval", label: "Needs Approval" },
  { id: "needs_review", label: "Needs Review" },
  { id: "failed", label: "Failed" },
  { id: "sent", label: "Sent" },
  { id: "expired", label: "Expired" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function QueueView() {
  const [activeTab, setActiveTab] = useState<TabId>("queued");
  const [items, setItems] = useState<OutboundItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Edit / Approve modal state
  const [editingItem, setEditingItem] = useState<OutboundItem | null>(null);
  const [editBody, setEditBody] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalSubmitting, setModalSubmitting] = useState(false);

  const loadItems = async (status: TabId) => {
    setLoading(true);
    setActionError(null);
    try {
      const res = await apiRequest<{ items: OutboundItem[]; nextCursor?: string | null }>(
        `/api/v1/outbound?status=${encodeURIComponent(status)}`
      );
      setItems(res.items);
      setNextCursor(res.nextCursor ?? null);
    } catch (err: any) {
      setActionError(err.message || "Failed to load queue items.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadItems(activeTab);
  }, [activeTab]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setActionError(null);
    try {
      const res = await apiRequest<{ items: OutboundItem[]; nextCursor?: string | null }>(
        `/api/v1/outbound?status=${encodeURIComponent(activeTab)}&cursor=${encodeURIComponent(nextCursor)}`
      );
      setItems((prev) => [...prev, ...res.items.filter((r) => !prev.some((p) => p.id === r.id))]);
      setNextCursor(res.nextCursor ?? null);
    } catch (err: any) {
      setActionError(err.message || "Failed to load more queue items.");
    } finally {
      setLoadingMore(false);
    }
  };

  const handleApprove = async (id: string, customBody?: string) => {
    const fromModal = customBody !== undefined;
    setActionError(null);
    if (fromModal) {
      setModalError(null);
      setModalSubmitting(true);
    }
    try {
      await apiRequest(`/api/v1/outbound/${id}/approve`, {
        method: "POST",
        body: JSON.stringify(customBody ? { body: customBody } : {}),
      });
      setEditingItem(null);
      loadItems(activeTab);
    } catch (err: any) {
      const msg = err.message || "Failed to approve message.";
      // Errors from the Edit & Approve modal are shown inside the modal so they
      // aren't hidden behind the overlay.
      if (fromModal) setModalError(msg);
      else setActionError(msg);
    } finally {
      if (fromModal) setModalSubmitting(false);
    }
  };

  const handleDiscard = async (id: string) => {
    if (!window.confirm("Are you sure you want to discard this draft?")) return;
    setActionError(null);
    try {
      await apiRequest(`/api/v1/outbound/${id}/discard`, { method: "POST" });
      loadItems(activeTab);
    } catch (err: any) {
      setActionError(err.message || "Failed to discard message.");
    }
  };

  const handleCancel = async (id: string) => {
    if (!window.confirm("Are you sure you want to cancel this message?")) return;
    setActionError(null);
    try {
      await apiRequest(`/api/v1/outbound/${id}/cancel`, { method: "POST" });
      loadItems(activeTab);
    } catch (err: any) {
      setActionError(err.message || "Failed to cancel message.");
    }
  };

  const handleRetry = async (id: string) => {
    setActionError(null);
    try {
      await apiRequest(`/api/v1/outbound/${id}/retry`, { method: "POST" });
      loadItems(activeTab);
    } catch (err: any) {
      setActionError(err.message || "Failed to retry message.");
    }
  };

  return (
    <div className="view-container animate-fade-in space-y-6">
      {/* View Header */}
      <div className="view-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">
            Outbound Queue
          </h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1">
            Manage, approve, and monitor outgoing WhatsApp dispatches with anti-ban rate limiting.
          </p>
        </div>
        <button
          className="btn btn-secondary text-sm px-4 py-2.5 rounded-lg"
          onClick={() => loadItems(activeTab)}
        >
          Refresh Queue
        </button>
      </div>

      {/* Tabs Filter Bar */}
      <div className="flex flex-wrap gap-1.5 p-1.5 bg-slate-100 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-150 ${
              activeTab === tab.id
                ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-white/60 dark:hover:bg-slate-900/40"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {actionError && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
          {actionError}
        </div>
      )}

      {/* Queue Items Table */}
      <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-0 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-slate-400 dark:text-slate-500">
            <div className="inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-2" />
            <p className="text-sm">Loading queue items...</p>
          </div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center text-slate-400 dark:text-slate-500">
            No messages found in <strong className="text-slate-700 dark:text-slate-300">{activeTab.replace("_", " ")}</strong>.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-xs uppercase font-semibold text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-5 py-3.5">Recipient</th>
                  <th className="px-5 py-3.5">Type</th>
                  <th className="px-5 py-3.5">Message Body</th>
                  <th className="px-5 py-3.5">{activeTab === "sent" ? "Sent At" : "Due At"}</th>
                  <th className="px-5 py-3.5">Attempts</th>
                  {activeTab === "failed" || activeTab === "needs_review" ? <th className="px-5 py-3.5">Last Error</th> : null}
                  {activeTab === "sent" ? <th className="px-5 py-3.5">WA Message ID</th> : null}
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {items.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="px-5 py-4 whitespace-nowrap">
                      <div className="font-bold text-sm text-slate-900 dark:text-white">{row.toE164}</div>
                      {row.toJid && <div className="text-xs text-slate-400 font-mono">{row.toJid}</div>}
                    </td>
                    <td className="px-5 py-4 whitespace-nowrap">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                        {row.kind}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-800 dark:text-slate-200 max-w-sm whitespace-pre-wrap leading-relaxed font-sans">
                      {row.body}
                    </td>
                    <td className="px-5 py-4 text-xs font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {new Date(activeTab === "sent" && row.sentAt ? row.sentAt : row.dueAt).toLocaleString()}
                    </td>
                    <td className="px-5 py-4 text-xs font-mono text-slate-600 dark:text-slate-300">
                      {row.attemptCount}
                    </td>
                    {(activeTab === "failed" || activeTab === "needs_review") && (
                      <td className="px-5 py-4 text-xs text-rose-600 dark:text-rose-400 font-medium max-w-xs truncate">
                        {row.lastError || "—"}
                      </td>
                    )}
                    {activeTab === "sent" && (
                      <td className="px-5 py-4 text-xs font-mono text-slate-400 max-w-xs truncate">
                        {row.waMessageId || "—"}
                      </td>
                    )}
                    <td className="px-5 py-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        {row.status === "needs_approval" && (
                          <>
                            <button
                              className="btn btn-primary text-xs px-3 py-1.5 rounded-lg"
                              onClick={() => handleApprove(row.id)}
                            >
                              Approve
                            </button>
                            <button
                              className="btn btn-secondary text-xs px-3 py-1.5 rounded-lg"
                              onClick={() => {
                                setEditingItem(row);
                                setEditBody(row.body);
                                setModalError(null);
                              }}
                            >
                              Edit &amp; Approve
                            </button>
                            <button
                              className="btn btn-danger text-xs px-2.5 py-1.5 rounded-lg"
                              onClick={() => handleDiscard(row.id)}
                            >
                              Discard
                            </button>
                          </>
                        )}
                        {row.status === "queued" && (
                          <button
                            className="btn btn-danger text-xs px-3 py-1.5 rounded-lg"
                            onClick={() => handleCancel(row.id)}
                          >
                            Cancel
                          </button>
                        )}
                        {(row.status === "failed" || row.status === "needs_review") && (
                          <button
                            className="btn btn-secondary text-xs px-3 py-1.5 rounded-lg"
                            onClick={() => handleRetry(row.id)}
                          >
                            Retry
                          </button>
                        )}
                      </div>
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

      {/* Edit & Approve Modal */}
      {editingItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg p-6 animate-scale-in space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white m-0">
                Edit &amp; Approve Message
              </h3>
              <span className="text-xs font-mono text-slate-400">{editingItem.toE164}</span>
            </div>

            <div>
              <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 block mb-1.5">
                Message Content
              </label>
              <textarea
                rows={6}
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm font-mono transition-colors"
              />
              <div className="flex justify-between items-center text-xs text-slate-400 mt-1">
                <span>Direct WhatsApp delivery upon approval</span>
                <span>{editBody.length} characters</span>
              </div>
            </div>

            {modalError && (
              <div
                className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm"
                role="alert"
              >
                {modalError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                className="btn btn-secondary text-sm px-4 py-2 rounded-lg"
                onClick={() => {
                  setEditingItem(null);
                  setModalError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary text-sm px-5 py-2 font-medium rounded-lg"
                onClick={() => handleApprove(editingItem.id, editBody)}
                disabled={modalSubmitting || !editBody.trim()}
              >
                {modalSubmitting ? "Approving..." : "Approve & Send Now"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
