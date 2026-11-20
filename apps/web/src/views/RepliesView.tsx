import { useEffect, useState } from "react";
import { apiRequest } from "../api.js";

interface QuickReply {
  id: string;
  title: string;
  body: string;
  position: number;
}

export function RepliesView() {
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadReplies = async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ items: QuickReply[] }>("/api/v1/quick-replies");
      setReplies(res.items);
    } catch (err: unknown) {
      setError((err as { message?: string }).message || "Failed to load quick replies");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReplies();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Client check on placeholders
    const matches = bodyText.match(/\{\{([^}]+)\}\}/g);
    if (matches && matches.some((m) => m !== "{{display_name}}")) {
      setError("Only {{display_name}} placeholder is permitted in templates.");
      return;
    }

    try {
      if (editingId) {
        await apiRequest(`/api/v1/quick-replies/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify({ title, body: bodyText }),
        });
      } else {
        await apiRequest("/api/v1/quick-replies", {
          method: "POST",
          body: JSON.stringify({ title, body: bodyText }),
        });
      }
      setTitle("");
      setBodyText("");
      setEditingId(null);
      loadReplies();
    } catch (err: unknown) {
      setError((err as { message?: string }).message || "Failed to save quick reply");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this quick reply template?")) return;
    try {
      await apiRequest(`/api/v1/quick-replies/${id}`, { method: "DELETE" });
      loadReplies();
    } catch (err: unknown) {
      alert((err as { message?: string }).message || "Failed to delete quick reply");
    }
  };

  const handleStartEdit = (reply: QuickReply) => {
    setEditingId(reply.id);
    setTitle(reply.title);
    setBodyText(reply.body);
    setError(null);
  };

  const handleInsertVariable = () => {
    setBodyText((prev) => `${prev} {{display_name}} `);
  };

  return (
    <div className="view-container animate-fade-in space-y-6">
      {/* View Header */}
      <div className="view-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">
            Quick Replies
          </h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1">
            Pre-composed WhatsApp answer templates with dynamic name personalization.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Saved Templates List */}
        <div className="lg:col-span-7 card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white m-0">
              Saved Templates ({replies.length})
            </h2>
            <button
              onClick={loadReplies}
              className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              Refresh
            </button>
          </div>

          {loading ? (
            <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">
              <div className="inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-2" />
              <p>Loading quick replies...</p>
            </div>
          ) : replies.length === 0 ? (
            <div className="py-16 text-center text-slate-400 dark:text-slate-500">
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 text-xl font-mono">
                💬
              </div>
              <h3 className="text-base font-semibold text-slate-700 dark:text-slate-300 mb-1">
                No templates created yet
              </h3>
              <p className="text-sm max-w-sm mx-auto">
                Create reusable quick reply templates to quickly answer common questions from leads in 1 click.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {replies.map((qkr) => (
                <div
                  key={qkr.id}
                  className={`p-4 rounded-xl border transition-all duration-150 ${
                    editingId === qkr.id
                      ? "border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/20"
                      : "border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-white dark:hover:bg-slate-800"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-sm text-slate-900 dark:text-white">
                      {qkr.title}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        className="btn btn-secondary text-xs px-2.5 py-1 rounded-md"
                        onClick={() => handleStartEdit(qkr)}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-danger text-xs px-2.5 py-1 rounded-md"
                        onClick={() => handleDelete(qkr.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="text-sm font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap bg-white dark:bg-slate-900/60 p-3 rounded-lg border border-slate-100 dark:border-slate-800">
                    {qkr.body}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Form & Live WhatsApp Preview */}
        <div className="lg:col-span-5 space-y-6">
          <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white m-0">
                {editingId ? "Edit Quick Reply" : "New Quick Reply"}
              </h2>
              {editingId && (
                <span className="badge text-xs font-semibold px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
                  Editing
                </span>
              )}
            </div>

            {error && (
              <div className="p-3.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
                {error}
              </div>
            )}

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 block mb-1.5">
                  Template Title *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g., Intro, Pricing Summary, Booking Link"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm transition-colors"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                    Message Body *
                  </label>
                  <button
                    type="button"
                    onClick={handleInsertVariable}
                    className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 transition-colors"
                  >
                    + Insert name tag
                  </button>
                </div>
                <textarea
                  rows={5}
                  required
                  placeholder="Hi {{display_name}}, thank you for reaching out to us..."
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm font-mono transition-colors"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Supported token: <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-mono">{"{{display_name}}"}</code>
                </p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  className="btn btn-primary text-sm px-5 py-2.5 font-medium rounded-lg flex-1"
                >
                  {editingId ? "Save Changes" : "Create Quick Reply"}
                </button>
                {editingId && (
                  <button
                    type="button"
                    className="btn btn-secondary text-sm px-4 py-2.5 font-medium rounded-lg"
                    onClick={() => {
                      setEditingId(null);
                      setTitle("");
                      setBodyText("");
                      setError(null);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* Live Preview Card */}
          {bodyText && (
            <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block">
                Live WhatsApp Render Preview
              </span>
              <div className="p-4 rounded-xl bg-slate-100 dark:bg-slate-950 flex flex-col items-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm shadow-sm bg-[#DCF8C6] text-slate-900 dark:bg-[#005c4b] dark:text-slate-100 leading-relaxed font-sans">
                  <p className="whitespace-pre-wrap m-0">
                    {bodyText.replace(/\{\{display_name\}\}/g, "Alex Johnson")}
                  </p>
                  <div className="flex items-center justify-end gap-1 mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                    <span>Just now</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-bold">✓✓</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
