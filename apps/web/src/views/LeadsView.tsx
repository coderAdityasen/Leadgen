import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../api.js";
import { useRouter } from "../router.js";
import {
  BoardContext,
  errorText,
  newIdempotencyKey,
  stageColorAt,
  useMediaQuery,
  type BoardActions,
  type BoardContextValue,
  type BoardResponse,
  type LeadCard,
  type LeadPatch,
  type SequenceBrief,
  type StageColor,
} from "../crmBoard.js";
import { StagePipeline } from "../components/StagePipeline.js";
import { LeadBoardTable } from "../components/LeadBoardTable.js";
import { LeadMobileCard } from "../components/LeadCells.js";
import { AddLeadModal } from "../components/AddLeadModal.js";
import { FilterPopover, DEFAULT_FILTERS, activeFilterCount, type BoardFilters, type TriState } from "../components/FilterPopover.js";
import { ToastStack, useToasts } from "../components/Toast.js";
import { IconChevronDown, IconPlus, IconRows, IconSearch, IconTable, IconX } from "../components/icons.js";

type ViewMode = "stages" | "table";
const VIEW_KEY = "leaddesk.leads.view";

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "table" ? "table" : "stages";
  } catch {
    return "stages";
  }
}

function matchTri(state: TriState, value: boolean) {
  return state === "any" || (state === "yes") === value;
}

/* ---------- Small pieces ---------- */

function SelectAllBox({ ids, selected, onChange, label }: { ids: string[]; selected: Set<string>; onChange: (ids: string[], on: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const picked = ids.filter((id) => selected.has(id)).length;
  const all = ids.length > 0 && picked === ids.length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = picked > 0 && !all;
  }, [picked, all]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-4 w-4 cursor-pointer rounded border-slate-300 text-indigo-600 disabled:cursor-not-allowed"
      checked={all}
      disabled={ids.length === 0}
      aria-label={label}
      onChange={() => onChange(ids, !all)}
    />
  );
}

function BoardSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading leads">
      {[0, 1].map((g) => (
        <div key={g} className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
          <div className="h-12 bg-slate-100 dark:bg-slate-800/70 animate-pulse" />
          {[0, 1, 2].map((r) => (
            <div key={r} className="flex gap-4 border-t border-slate-100 p-4 dark:border-slate-800">
              <div className="h-4 w-10 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-1/3 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
                <div className="h-3 w-1/2 rounded bg-slate-100 dark:bg-slate-800/70 animate-pulse" />
              </div>
              <div className="hidden h-4 w-1/4 rounded bg-slate-100 dark:bg-slate-800/70 animate-pulse md:block" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------- View ---------- */

export function LeadsView() {
  const { navigate } = useRouter();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const { toasts, push: toast, dismiss } = useToasts();

  const [operatorName, setOperatorName] = useState("");
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sequences, setSequences] = useState<SequenceBrief[]>([]);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filters, setFilters] = useState<BoardFilters>(DEFAULT_FILTERS);
  // Accordion: every stage group is always listed; exactly one (or none) is open at a time.
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const openInitialized = useRef(false);
  const [view, setView] = useState<ViewMode>(readViewMode);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(() => new URLSearchParams(window.location.search).get("new") === "1");

  const requestSeq = useRef(0);

  // Strip ?new=1 once consumed so a refresh doesn't reopen the form.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("new")) {
      window.history.replaceState({}, "", "/leads");
    }
  }, []);

  useEffect(() => {
    apiRequest<{ displayName: string }>("/api/v1/me")
      .then((me) => setOperatorName(me.displayName))
      .catch(() => {});
    apiRequest<{ items: SequenceBrief[] }>("/api/v1/sequences")
      .then((res) => setSequences(res.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadBoard = useCallback(
    async (silent = false) => {
      const seq = ++requestSeq.current;
      if (!silent) setLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams();
        if (debouncedSearch) params.set("q", debouncedSearch);
        if (filters.includeArchived) params.set("includeArchived", "true");
        const qs = params.toString();
        const res = await apiRequest<BoardResponse>(`/api/v1/leads/board${qs ? `?${qs}` : ""}`);
        if (seq !== requestSeq.current) return; // a newer request superseded this one
        setBoard(res);
        setSelected((prev) => {
          if (prev.size === 0) return prev;
          const ids = new Set(res.items.map((i) => i.id));
          return new Set([...prev].filter((id) => ids.has(id)));
        });
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setLoadError(errorText(err, "Could not load leads."));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [debouncedSearch, filters.includeArchived]
  );

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  const stages = useMemo(() => [...(board?.stages ?? [])].sort((a, b) => a.position - b.position), [board]);

  // Open the first stage that has leads on first load; drop an open stage that was deleted.
  useEffect(() => {
    if (!board) return;
    if (!openInitialized.current) {
      openInitialized.current = true;
      const sorted = [...board.stages].sort((a, b) => a.position - b.position);
      setOpenStageId((sorted.find((st) => st.count > 0) ?? sorted[0])?.id ?? null);
      return;
    }
    if (openStageId && !board.stages.some((st) => st.id === openStageId)) setOpenStageId(null);
  }, [board, openStageId]);

  const colorMap = useMemo(() => {
    const m = new Map<string, StageColor>();
    stages.forEach((s, i) => m.set(s.id, stageColorAt(i)));
    return m;
  }, [stages]);
  const colorFor = useCallback((id: string) => colorMap.get(id) ?? stageColorAt(7), [colorMap]);

  /* ----- Filtering ----- */

  const narrowed = debouncedSearch !== "" || activeFilterCount(filters) > 0;

  const filteredItems = useMemo(
    () =>
      (board?.items ?? []).filter(
        (l) =>
          matchTri(filters.ai, l.aiEnabled) &&
          matchTri(filters.auto, !l.automationPaused) &&
          matchTri(filters.inSequence, l.enrollment !== null) &&
          matchTri(filters.doNotMessage, l.doNotMessage)
      ),
    [board, filters]
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    if (!narrowed) {
      for (const s of stages) c[s.id] = s.count;
    } else {
      for (const l of filteredItems) c[l.stageId] = (c[l.stageId] ?? 0) + 1;
    }
    return c;
  }, [narrowed, stages, filteredItems]);

  const visibleItems = useMemo(
    () => filteredItems,
    [filteredItems]
  );

  const groups = useMemo(() => {
    const byStage = new Map<string, LeadCard[]>();
    for (const l of visibleItems) {
      const arr = byStage.get(l.stageId) ?? [];
      arr.push(l);
      byStage.set(l.stageId, arr);
    }
    return stages
      .map((s) => ({ stage: s, leads: byStage.get(s.id) ?? [] }));
  }, [visibleItems, stages]);

  // Clicking a pipeline chevron opens that stage's group (closing the others) and brings
  // it into view. It never hides the other stages.
  const changeView = useCallback((v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // storage unavailable — keep in memory only
    }
  }, []);

  const openStage = useCallback(
    (stageId: string) => {
      setOpenStageId(stageId);
      if (view !== "stages") changeView("stages");
      requestAnimationFrame(() => {
        document
          .getElementById(`stage-group-${stageId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    [view, changeView]
  );

  /* ----- Mutations ----- */

  const updateItem = useCallback((id: string, fn: (l: LeadCard) => LeadCard) => {
    setBoard((b) => (b ? { ...b, items: b.items.map((x) => (x.id === id ? fn(x) : x)) } : b));
  }, []);

  const stageName = useCallback((id: string) => stages.find((s) => s.id === id)?.name ?? "", [stages]);

  const actions: BoardActions = useMemo(
    () => ({
      patch: async (lead: LeadCard, changes: LeadPatch) => {
        const rollback: Partial<LeadCard> = {};
        for (const k of Object.keys(changes) as (keyof LeadPatch)[]) {
          (rollback as Record<string, unknown>)[k] = lead[k];
        }
        if (changes.stageId) rollback.stageName = lead.stageName;
        updateItem(lead.id, (x) => ({
          ...x,
          ...changes,
          ...(changes.stageId ? { stageName: stageName(changes.stageId), stageChangedAt: new Date().toISOString() } : {}),
        }));
        try {
          await apiRequest(`/api/v1/leads/${lead.id}`, { method: "PATCH", body: JSON.stringify(changes) });
          if (changes.stageId) {
            toast("success", `${lead.displayName} moved to ${stageName(changes.stageId)}.`);
            void loadBoard(true);
          }
          return true;
        } catch (err) {
          updateItem(lead.id, (x) => ({ ...x, ...rollback }));
          toast("error", `Couldn't update ${lead.displayName}: ${errorText(err)}`);
          return false;
        }
      },
      startSequence: async (lead, sequenceId) => {
        try {
          await apiRequest(`/api/v1/sequences/${sequenceId}/enrollments`, {
            method: "POST",
            headers: { "Idempotency-Key": newIdempotencyKey() },
            body: JSON.stringify({ leadId: lead.id }),
          });
          toast("success", `Sequence started for ${lead.displayName}.`);
          await loadBoard(true);
        } catch (err) {
          toast("error", `Couldn't start sequence: ${errorText(err)}`);
        }
      },
      stopSequence: async (lead) => {
        if (!lead.enrollment) return;
        try {
          await apiRequest(`/api/v1/enrollments/${lead.enrollment.id}/cancel`, { method: "POST" });
          toast("success", `Sequence stopped for ${lead.displayName}.`);
          await loadBoard(true);
        } catch (err) {
          toast("error", `Couldn't stop sequence: ${errorText(err)}`);
        }
      },
      schedule: async (lead, body, dueAtIso, key) => {
        try {
          await apiRequest(`/api/v1/scheduled-messages`, {
            method: "POST",
            headers: { "Idempotency-Key": key },
            body: JSON.stringify({ leadId: lead.id, body, dueAt: dueAtIso }),
          });
          toast("success", `Message scheduled for ${lead.displayName}.`);
          void loadBoard(true);
          return null;
        } catch (err) {
          return errorText(err, "Could not schedule the message.");
        }
      },
      copy: (text, label) => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => toast("info", `${label} copied.`))
          .catch(() => toast("error", "Clipboard is not available."));
      },
      openLead: (id) => navigate(`/leads/${id}`),
    }),
    [updateItem, stageName, toast, loadBoard, navigate]
  );

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const ctx: BoardContextValue = useMemo(
    () => ({ stages, sequences, colorFor, actions, selected, toggleSelected }),
    [stages, sequences, colorFor, actions, selected, toggleSelected]
  );

  /* ----- Bulk actions ----- */

  const runBulk = async (label: string, fn: (id: string) => Promise<unknown>) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(ids.map(fn));
    const failed = results.filter((r) => r.status === "rejected");
    setBulkBusy(false);
    if (failed.length) {
      const first = (failed[0] as PromiseRejectedResult).reason;
      toast("error", `${label}: ${failed.length} of ${ids.length} failed — ${errorText(first)}`);
    } else {
      toast("success", `${label}: ${ids.length} lead${ids.length === 1 ? "" : "s"} updated.`);
    }
    await loadBoard(true);
  };

  const bulkPatch = (label: string, changes: LeadPatch) =>
    runBulk(label, (id) => apiRequest(`/api/v1/leads/${id}`, { method: "PATCH", body: JSON.stringify(changes) }));

  const bulkArchive = async () => {
    const n = selected.size;
    if (!window.confirm(`Archive ${n} lead${n === 1 ? "" : "s"}? Their pending messages and sequences will be cancelled.`)) return;
    await runBulk("Archive", (id) => apiRequest(`/api/v1/leads/${id}/archive`, { method: "POST" }));
    setSelected(new Set());
  };

  const clearAllFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setFilters(DEFAULT_FILTERS);
  };

  const totalLeads = board?.items.length ?? 0;
  const firstLoad = loading && !board;

  /* ----- Render ----- */

  return (
    <BoardContext.Provider value={ctx}>
      <div className="animate-fade-in flex min-w-0 flex-col gap-5 pb-24">
        {/* Row 1: welcome + view toggle */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="m-0 truncate text-2xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-[26px]">
              Welcome{operatorName ? `, ${operatorName}` : ""}
            </h1>
            <p className="m-0 mt-0.5 text-sm text-slate-500 dark:text-slate-400">Your pipeline at a glance — click a stage to focus on it.</p>
          </div>
          <div role="group" aria-label="Layout" className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-xs dark:border-slate-700 dark:bg-slate-900">
            {(
              [
                ["stages", "Stages", IconRows],
                ["table", "Table", IconTable],
              ] as const
            ).map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => changeView(v)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  view === v
                    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
                    : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                }`}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Row 2: search, filter, add */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex flex-1 items-center gap-2 min-w-0">
            <div className="relative flex-1 min-w-0">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <IconSearch size={17} />
              </span>
              <input
                type="text"
                className="crm-search"
                placeholder="Search name, email, company, phone or notes"
                aria-label="Search leads"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                >
                  <IconX size={14} />
                </button>
              )}
            </div>
            <FilterPopover value={filters} onChange={setFilters} />
          </div>
          <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={() => setShowAdd(true)}>
            <IconPlus size={16} />
            Add New Lead
          </button>
        </div>

        {/* Row 3: pipeline */}
        <StagePipeline
          stages={stages}
          counts={counts}
          colorFor={colorFor}
          activeStageId={view === "stages" ? openStageId : null}
          onSelect={openStage}
          onEdit={() => navigate("/settings/stages")}
          loading={firstLoad}
        />

        {narrowed && !firstLoad && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <span>
              Showing <strong className="text-slate-900 dark:text-white">{visibleItems.length}</strong> of {totalLeads} lead{totalLeads === 1 ? "" : "s"}
            </span>
            <button type="button" className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400" onClick={clearAllFilters}>
              Clear all
            </button>
            {loading && <span className="text-xs text-slate-400">Updating…</span>}
          </div>
        )}

        {loadError && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            <span>{loadError}</span>
            <button type="button" className="btn btn-danger btn-xs" onClick={() => void loadBoard()}>
              Retry
            </button>
          </div>
        )}

        {board?.truncated && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            Showing the newest {board.items.length} leads. Use search to find older ones.
          </div>
        )}

        {/* Content */}
        {firstLoad ? (
          <BoardSkeleton />
        ) : !board ? null : totalLeads === 0 && !narrowed ? (
          <div className="card flex flex-col items-center gap-3 py-14 text-center">
            <p className="m-0 text-lg font-bold text-slate-900 dark:text-white">No leads yet</p>
            <p className="m-0 max-w-sm text-sm text-slate-500 dark:text-slate-400">
              Add your first lead, or let the WhatsApp extension capture them as chats come in.
            </p>
            <button type="button" className="btn btn-primary btn-sm mt-1" onClick={() => setShowAdd(true)}>
              <IconPlus size={16} /> Add New Lead
            </button>
          </div>
        ) : visibleItems.length === 0 && (narrowed || view === "table") ? (
          <div className="card flex flex-col items-center gap-3 py-12 text-center">
            <p className="m-0 text-base font-bold text-slate-900 dark:text-white">No leads match</p>
            <p className="m-0 text-sm text-slate-500 dark:text-slate-400">Try a different search or loosen the filters.</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={clearAllFilters}>
              Clear filters
            </button>
          </div>
        ) : view === "stages" ? (
          <div className="flex flex-col gap-4">
            {groups.map(({ stage, leads }) => {
              const color = colorFor(stage.id);
              const isCollapsed = openStageId !== stage.id;
              const ids = leads.map((l) => l.id);
              return (
                <section
                  key={stage.id}
                  id={`stage-group-${stage.id}`}
                  aria-label={`${stage.name} stage`}
                  className={`scroll-mt-4 overflow-hidden rounded-xl border bg-white shadow-card dark:bg-slate-900 ${color.border}`}
                >
                  <header className={`flex items-center gap-3 px-4 py-3 ${color.tint}`}>
                    <SelectAllBox ids={ids} selected={selected} onChange={setMany} label={`Select all leads in ${stage.name}`} />
                    <button
                      type="button"
                      className={`flex flex-1 items-center justify-between gap-3 text-left focus:outline-none focus-visible:underline ${color.text}`}
                      aria-expanded={!isCollapsed}
                      aria-controls={`stage-body-${stage.id}`}
                      onClick={() =>
                        setOpenStageId((cur) => (cur === stage.id ? null : stage.id))
                      }
                    >
                      <span className="flex items-center gap-2 text-[15px] font-bold">
                        <span className={`h-2.5 w-2.5 rounded-full ${color.dot}`} aria-hidden />
                        {stage.name} <span className="font-semibold opacity-70">({leads.length})</span>
                      </span>
                      <span className={`transition-transform ${isCollapsed ? "" : "rotate-180"}`}>
                        <IconChevronDown size={18} />
                      </span>
                    </button>
                  </header>
                  {!isCollapsed && (
                    <div id={`stage-body-${stage.id}`}>
                      {leads.length === 0 ? (
                        <p className="m-0 px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
                          No leads in {stage.name} yet. Move a lead here with “Move to”.
                        </p>
                      ) : isMobile ? (
                        <div className="flex flex-col gap-3 p-3">
                          {leads.map((l) => (
                            <LeadMobileCard key={l.id} lead={l} />
                          ))}
                        </div>
                      ) : (
                        <LeadBoardTable leads={leads} mode="stage" />
                      )}
                    </div>
                  )}
                </section>
              );
            })}
            {groups.length === 0 && (
              <div className="card py-10 text-center text-sm text-slate-500">No stages yet — add one in the stage editor.</div>
            )}
          </div>
        ) : isMobile ? (
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300">
              <SelectAllBox ids={visibleItems.map((l) => l.id)} selected={selected} onChange={setMany} label="Select all visible leads" />
              Select all
            </label>
            {visibleItems.map((l) => {
              const c = colorFor(l.stageId);
              return (
                <LeadMobileCard
                  key={l.id}
                  lead={l}
                  extra={
                    <span className={`mb-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${c.badge}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} aria-hidden />
                      {l.stageName}
                    </span>
                  }
                />
              );
            })}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-slate-800 dark:bg-slate-900">
            <LeadBoardTable
              leads={visibleItems}
              mode="flat"
              headerSelect={
                <SelectAllBox ids={visibleItems.map((l) => l.id)} selected={selected} onChange={setMany} label="Select all visible leads" />
              }
            />
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed inset-x-3 bottom-4 z-40 mx-auto max-w-3xl lg:left-[296px] lg:right-6 animate-slide-up" role="region" aria-label="Bulk actions">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
            <span className="mr-1 text-sm font-bold text-slate-900 dark:text-white">{selected.size} selected</span>
            <select
              className="crm-ctl !w-auto"
              value=""
              disabled={bulkBusy}
              aria-label="Move selected leads to stage"
              onChange={(e) => {
                const id = e.target.value;
                if (id) void bulkPatch(`Moved to ${stageName(id)}`, { stageId: id });
              }}
            >
              <option value="">Move to stage…</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-secondary btn-xs" disabled={bulkBusy} onClick={() => void bulkPatch("AI on", { aiEnabled: true })}>
              AI on
            </button>
            <button type="button" className="btn btn-secondary btn-xs" disabled={bulkBusy} onClick={() => void bulkPatch("AI off", { aiEnabled: false })}>
              AI off
            </button>
            <button type="button" className="btn btn-danger btn-xs" disabled={bulkBusy} onClick={() => void bulkArchive()}>
              Archive
            </button>
            <button
              type="button"
              className="ml-auto text-sm font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </button>
          </div>
        </div>
      )}

      {showAdd && (
        <AddLeadModal
          stages={stages}
          defaultStageId={openStageId}
          onClose={() => setShowAdd(false)}
          onCreated={(lead) => {
            setShowAdd(false);
            toast("success", `${lead.displayName} added.`);
            void loadBoard(true);
          }}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </BoardContext.Provider>
  );
}

