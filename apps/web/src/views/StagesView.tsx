import { useEffect, useState } from "react";
import { apiRequest } from "../api.js";

interface Stage {
  id: string;
  name: string;
  position: number;
}

export function StagesView() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [newStageName, setNewStageName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadStages = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ items: Stage[] }>("/api/v1/stages");
      setStages(res.items);
    } catch (err: unknown) {
      setError((err as { message?: string }).message || "Failed to load stages");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStages();
  }, []);

  const handleAddStage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStageName.trim()) return;
    setError(null);
    try {
      await apiRequest("/api/v1/stages", {
        method: "POST",
        body: JSON.stringify({ name: newStageName.trim() }),
      });
      setNewStageName("");
      loadStages();
    } catch (err: unknown) {
      setError((err as { message?: string }).message || "Failed to add stage");
    }
  };

  const handleSaveRename = async (stageId: string) => {
    if (!editingName.trim()) return;
    setError(null);
    try {
      await apiRequest(`/api/v1/stages/${stageId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editingName.trim() }),
      });
      setEditingId(null);
      loadStages();
    } catch (err: unknown) {
      setError((err as { message?: string }).message || "Failed to rename stage");
    }
  };

  const handleMove = async (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= stages.length) return;

    const newStages = [...stages];
    const temp = newStages[index]!;
    newStages[index] = newStages[targetIndex]!;
    newStages[targetIndex] = temp;

    const ids = newStages.map((s) => s.id);
    try {
      const res = await apiRequest<{ items: Stage[] }>("/api/v1/stages/order", {
        method: "PUT",
        body: JSON.stringify({ ids }),
      });
      setStages(res.items);
    } catch (err: unknown) {
      setError((err as { message?: string }).message || "Failed to reorder stages");
    }
  };

  return (
    <div className="view-container animate-fade-in space-y-6">
      {/* Header */}
      <div className="view-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">
            Pipeline Stages
          </h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1">
            Customize and reorder funnel stages for categorizing your contact pipeline.
          </p>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
          {error}
        </div>
      )}

      <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm max-w-2xl space-y-6">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">
            Active Funnel Steps ({stages.length})
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Stages appear sequentially in lead views
          </span>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-slate-400 dark:text-slate-500">
            <div className="inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-2" />
            <p>Loading pipeline stages...</p>
          </div>
        ) : stages.length === 0 ? (
          <div className="py-12 text-center text-slate-400 dark:text-slate-500">
            No pipeline stages defined. Add your first stage below.
          </div>
        ) : (
          <div className="space-y-2.5">
            {stages.map((stage, idx) => (
              <div
                key={stage.id}
                className="flex items-center justify-between p-3.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-800/40 hover:bg-white dark:hover:bg-slate-800 transition-all duration-150"
              >
                <div className="flex items-center gap-3 flex-1 mr-3">
                  <span className="w-7 h-7 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 text-xs font-bold font-mono flex items-center justify-center shrink-0">
                    {idx + 1}
                  </span>
                  {editingId === stage.id ? (
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className="flex-1 px-3 py-1.5 rounded-lg border border-indigo-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-indigo-500/20"
                      autoFocus
                    />
                  ) : (
                    <span className="font-semibold text-sm text-slate-900 dark:text-white">
                      {stage.name}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {editingId === stage.id ? (
                    <>
                      <button
                        className="btn btn-primary text-xs px-3 py-1.5 rounded-lg"
                        onClick={() => handleSaveRename(stage.id)}
                      >
                        Save
                      </button>
                      <button
                        className="btn btn-secondary text-xs px-3 py-1.5 rounded-lg"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn btn-secondary text-xs px-3 py-1.5 rounded-lg text-slate-700 dark:text-slate-300"
                        onClick={() => {
                          setEditingId(stage.id);
                          setEditingName(stage.name);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        className="btn btn-secondary text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed"
                        disabled={idx === 0}
                        onClick={() => handleMove(idx, "up")}
                        aria-label="Move stage up"
                      >
                        ↑
                      </button>
                      <button
                        className="btn btn-secondary text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed"
                        disabled={idx === stages.length - 1}
                        onClick={() => handleMove(idx, "down")}
                        aria-label="Move stage down"
                      >
                        ↓
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add Stage Form */}
        <form onSubmit={handleAddStage} className="pt-4 border-t border-slate-100 dark:border-slate-800 flex gap-3">
          <input
            type="text"
            placeholder="Add new stage name (e.g., Qualified, Demo Booked)..."
            value={newStageName}
            onChange={(e) => setNewStageName(e.target.value)}
            className="flex-1 px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm transition-colors"
          />
          <button type="submit" className="btn btn-primary text-sm px-5 py-2.5 font-medium rounded-lg shrink-0">
            Add Stage
          </button>
        </form>
      </div>
    </div>
  );
}
