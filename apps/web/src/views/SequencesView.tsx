import { useEffect, useState } from "react";
import { apiRequest } from "../api.js";
import { generateUlid } from "@leaddesk/shared";

interface SequenceSummary {
  id: string;
  name: string;
  enabled: boolean;
  stepCount: number;
  updatedAt: string;
}

interface SequenceStep {
  id?: string;
  position: number;
  delaySeconds: number;
  body: string;
}

interface SequenceDetail {
  id: string;
  name: string;
  enabled: boolean;
  steps: SequenceStep[];
  createdAt: string;
  updatedAt: string;
}

interface Enrollment {
  id: string;
  sequenceId: string;
  sequenceName: string;
  leadId: string;
  status: "active" | "completed" | "cancelled" | "stopped";
  currentStepId: string | null;
  startedAt: string;
  stoppedAt: string | null;
}

interface LeadOption {
  id: string;
  displayName: string;
  primaryPhone: string | null;
}

// GET /leads is cursor-paginated (max 100 per page); walk every page so the
// enroll dropdown isn't silently truncated.
async function fetchAllLeads(): Promise<LeadOption[]> {
  const all: LeadOption[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const qs: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const res: { items: LeadOption[]; nextCursor?: string | null } = await apiRequest(
      `/api/v1/leads?limit=100${qs}`
    );
    all.push(...res.items);
    cursor = res.nextCursor ?? null;
    if (!cursor) break;
  }
  return all;
}

const DELAY_PRESETS = [
  { label: "Immediate (0s)", seconds: 0 },
  { label: "1 Hour", seconds: 3600 },
  { label: "4 Hours", seconds: 14400 },
  { label: "1 Day (24h)", seconds: 86400 },
  { label: "2 Days (48h)", seconds: 172800 },
  { label: "3 Days (72h)", seconds: 259200 },
];

const SEQUENCE_TEMPLATES = [
  {
    name: "3-Step Lead Nurture",
    desc: "Immediate welcome + 24h follow-up + 48h final check-in",
    steps: [
      { delaySeconds: 0, body: "Hi {{display_name}}, thanks for connecting with us on WhatsApp! What brings you to Lead Desk today?" },
      { delaySeconds: 86400, body: "Hey {{display_name}}, following up on my previous message. Did you get a chance to review our platform overview?" },
      { delaySeconds: 172800, body: "Hi {{display_name}}, wanted to check in one last time this week. Would you like a quick 10-minute walkthrough?" },
    ],
  },
  {
    name: "Post-Demo Check-in",
    desc: "1h recap + 24h feedback follow-up",
    steps: [
      { delaySeconds: 3600, body: "Hi {{display_name}}, great speaking with you earlier! Here is the summary we discussed. Let me know if you have any questions." },
      { delaySeconds: 86400, body: "Hey {{display_name}}, hope your day is going well! Just checking if your team had any feedback on the demo." },
    ],
  },
  {
    name: "Re-engagement Drip",
    desc: "Immediate feature update + 3-day value ping",
    steps: [
      { delaySeconds: 0, body: "Hi {{display_name}}, we noticed you haven't been active recently. We just rolled out some major improvements to our WhatsApp desk!" },
      { delaySeconds: 259200, body: "Hey {{display_name}}, would love to help you get set up if you're still looking for a WhatsApp lead solution. Let me know!" },
    ],
  },
];

function formatDelay(seconds: number): string {
  if (seconds <= 0) return "Send immediately on enroll";
  if (seconds < 3600) return `Wait ${Math.round(seconds / 60)} mins`;
  if (seconds < 86400) return `Wait ${Math.round(seconds / 3600)} hrs`;
  const days = seconds / 86400;
  return `Wait ${days === 1 ? "1 day" : `${days.toFixed(days % 1 === 0 ? 0 : 1)} days`}`;
}

export function SequencesView() {
  const [sequences, setSequences] = useState<SequenceSummary[]>([]);
  const [selectedSeqId, setSelectedSeqId] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<SequenceDetail | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // View Mode: 'builder' | 'simulator'
  const [viewMode, setViewMode] = useState<"builder" | "simulator">("builder");

  // Filter / Search sequences
  const [searchSeq, setSearchSeq] = useState("");

  // New sequence modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSeqName, setNewSeqName] = useState("");
  const [selectedTemplateIndex, setSelectedTemplateIndex] = useState<number | null>(null);
  const [creatingSeq, setCreatingSeq] = useState(false);

  // Edit steps draft
  const [stepsDraft, setStepsDraft] = useState<SequenceStep[]>([]);
  const [savingSteps, setSavingSteps] = useState(false);
  const [stepsError, setStepsError] = useState<string | null>(null);
  const [stepsSuccess, setStepsSuccess] = useState<string | null>(null);

  // Enroll lead form
  const [enrollLeadId, setEnrollLeadId] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollSuccess, setEnrollSuccess] = useState<string | null>(null);

  // Enrollments filter
  const [enrollmentStatusFilter, setEnrollmentStatusFilter] = useState<string>("all");

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [seqRes, enrRes, leadsRes] = await Promise.all([
        apiRequest<{ items: SequenceSummary[] }>("/api/v1/sequences"),
        apiRequest<{ items: Enrollment[] }>("/api/v1/enrollments"),
        fetchAllLeads().catch(() => [] as LeadOption[]),
      ]);
      setSequences(seqRes.items);
      setEnrollments(enrRes.items);
      setLeads(leadsRes);
      if (!selectedSeqId && seqRes.items.length > 0) {
        setSelectedSeqId(seqRes.items[0]!.id);
      }
    } catch (err: unknown) {
      setError((err as { message?: string }).message || "Failed to load sequences");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const loadSequenceDetail = async (id: string) => {
    try {
      const detail = await apiRequest<SequenceDetail>(`/api/v1/sequences/${id}`);
      setSelectedSeq(detail);
      setStepsDraft(detail.steps.map((s, idx) => ({ ...s, position: idx })));
      setStepsError(null);
      setStepsSuccess(null);
    } catch (err: unknown) {
      setError((err as { message?: string }).message || "Failed to load sequence details");
    }
  };

  useEffect(() => {
    if (selectedSeqId) {
      loadSequenceDetail(selectedSeqId);
    } else {
      setSelectedSeq(null);
      setStepsDraft([]);
    }
  }, [selectedSeqId]);

  const handleCreateSequence = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSeqName.trim()) return;
    setCreatingSeq(true);
    try {
      const created = await apiRequest<SequenceDetail>("/api/v1/sequences", {
        method: "POST",
        body: JSON.stringify({ name: newSeqName.trim() }),
      });

      // If user selected a starter template, save its steps immediately
      if (selectedTemplateIndex !== null && SEQUENCE_TEMPLATES[selectedTemplateIndex]) {
        const tpl = SEQUENCE_TEMPLATES[selectedTemplateIndex];
        await apiRequest(`/api/v1/sequences/${created.id}/steps`, {
          method: "PUT",
          body: JSON.stringify({ steps: tpl.steps }),
        });
      }

      setNewSeqName("");
      setSelectedTemplateIndex(null);
      setShowCreateModal(false);
      await loadData();
      setSelectedSeqId(created.id);
    } catch (err: unknown) {
      alert((err as { message?: string }).message || "Failed to create sequence");
    } finally {
      setCreatingSeq(false);
    }
  };

  const handleToggleEnabled = async (seqId: string, currentVal: boolean) => {
    try {
      const updated = await apiRequest<SequenceDetail>(`/api/v1/sequences/${seqId}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !currentVal }),
      });
      setSequences((prev) =>
        prev.map((s) => (s.id === seqId ? { ...s, enabled: updated.enabled } : s))
      );
      if (selectedSeq?.id === seqId) {
        setSelectedSeq((prev) => (prev ? { ...prev, enabled: updated.enabled } : null));
      }
    } catch (err: unknown) {
      alert((err as { message?: string }).message || "Failed to toggle sequence");
    }
  };

  const handleDeleteSequence = async (seqId: string) => {
    if (!confirm("Are you sure you want to delete this sequence?")) return;
    setError(null);
    try {
      await apiRequest(`/api/v1/sequences/${seqId}`, { method: "DELETE" });
      setSelectedSeqId(null);
      await loadData();
    } catch (err: unknown) {
      // Server explains why (e.g. 409 when enrollments reference this sequence).
      setError((err as { message?: string }).message || "Failed to delete sequence.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const handleAddStep = () => {
    if (stepsDraft.length >= 10) {
      alert("At most 10 steps allowed per sequence.");
      return;
    }
    const defaultDelay = stepsDraft.length === 0 ? 0 : 86400;
    setStepsDraft((prev) => [
      ...prev,
      {
        position: prev.length,
        delaySeconds: defaultDelay,
        body: "",
      },
    ]);
  };

  const handleRemoveStep = (index: number) => {
    setStepsDraft((prev) =>
      prev.filter((_, idx) => idx !== index).map((s, idx) => ({ ...s, position: idx }))
    );
  };

  const handleMoveStep = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= stepsDraft.length) return;
    const nextDraft = [...stepsDraft];
    const temp = nextDraft[index]!;
    nextDraft[index] = nextDraft[targetIndex]!;
    nextDraft[targetIndex] = temp;
    setStepsDraft(nextDraft.map((s, idx) => ({ ...s, position: idx })));
  };

  const handleStepChange = (index: number, updates: Partial<SequenceStep>) => {
    setStepsDraft((prev) =>
      prev.map((s, idx) => (idx === index ? { ...s, ...updates } : s))
    );
  };

  const handleInsertVariable = (index: number, varName: string) => {
    setStepsDraft((prev) =>
      prev.map((s, idx) => {
        if (idx !== index) return s;
        return {
          ...s,
          body: s.body ? `${s.body} {{${varName}}}` : `{{${varName}}}`,
        };
      })
    );
  };

  const handleSaveSteps = async () => {
    if (!selectedSeqId) return;
    setSavingSteps(true);
    setStepsError(null);
    setStepsSuccess(null);
    try {
      const payload = {
        steps: stepsDraft.map((s) => ({
          delaySeconds: Number(s.delaySeconds) || 0,
          body: s.body,
        })),
      };
      const updated = await apiRequest<SequenceDetail>(
        `/api/v1/sequences/${selectedSeqId}/steps`,
        {
          method: "PUT",
          body: JSON.stringify(payload),
        }
      );
      setSelectedSeq(updated);
      setStepsDraft(updated.steps.map((s, idx) => ({ ...s, position: idx })));
      setSequences((prev) =>
        prev.map((s) => (s.id === selectedSeqId ? { ...s, stepCount: updated.steps.length } : s))
      );
      setStepsSuccess("Sequence workflow steps saved successfully.");
      setTimeout(() => setStepsSuccess(null), 4000);
    } catch (err: unknown) {
      const msg = (err as { message?: string }).message || "Failed to save steps";
      setStepsError(msg);
    } finally {
      setSavingSteps(false);
    }
  };

  const handleEnrollLead = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSeqId || !enrollLeadId.trim()) return;
    setEnrolling(true);
    setEnrollError(null);
    setEnrollSuccess(null);
    try {
      const idempotencyKey = generateUlid("enr");
      await apiRequest(`/api/v1/sequences/${selectedSeqId}/enrollments`, {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ leadId: enrollLeadId.trim() }),
      });
      setEnrollSuccess("Lead successfully enrolled. Step 1 has been scheduled in the Outbound Queue.");
      setEnrollLeadId("");
      await loadData();
      setTimeout(() => setEnrollSuccess(null), 5000);
    } catch (err: unknown) {
      setEnrollError((err as { message?: string }).message || "Failed to enroll lead");
    } finally {
      setEnrolling(false);
    }
  };

  const handleCancelEnrollment = async (enrollmentId: string) => {
    if (!confirm("Cancel sequence enrollment? Any queued or needs_approval step will be aborted.")) return;
    try {
      await apiRequest(`/api/v1/enrollments/${enrollmentId}/cancel`, { method: "POST" });
      await loadData();
    } catch (err: unknown) {
      alert((err as { message?: string }).message || "Failed to cancel enrollment");
    }
  };

  const filteredSequences = sequences.filter((s) =>
    s.name.toLowerCase().includes(searchSeq.toLowerCase())
  );

  const activeEnrollmentsCount = enrollments.filter((e) => e.status === "active").length;
  const filteredEnrollments = enrollments.filter((e) => {
    if (enrollmentStatusFilter === "all") return true;
    return e.status === enrollmentStatusFilter;
  });

  return (
    <div className="view-container animate-fade-in space-y-6">
      {/* Top Header Banner */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-7 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-5 transition-colors">
        <div>
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center text-emerald-600 dark:text-emerald-400 text-xl font-bold shadow-xs">
              💬
            </span>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white m-0 tracking-tight">
              WhatsApp Drip Sequences
            </h1>
            <span className="px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
              Delivery-Triggered
            </span>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5 mb-0 leading-relaxed">
            Automate multi-touch WhatsApp nurture sequences. Steps advance strictly after delivery acknowledgment.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs">
            <span className="text-slate-500 dark:text-slate-400">Active Flows:</span>
            <span className="font-bold text-slate-900 dark:text-white">{sequences.filter((s) => s.enabled).length}</span>
            <span className="text-slate-500 dark:text-slate-400">· Enrolled:</span>
            <span className="font-bold text-emerald-600 dark:text-emerald-400">{activeEnrollmentsCount}</span>
          </div>

          <button
            onClick={() => setShowCreateModal(true)}
            className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm shadow-sm hover:shadow transition-all flex items-center gap-2 active:scale-95"
          >
            <span>+</span>
            <span>New Sequence</span>
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* Main 2-Column Interface */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Sequences Explorer (4 Cols) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-5 space-y-3.5 transition-colors">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider m-0">
                Workflows ({filteredSequences.length})
              </h2>
              <button
                onClick={() => setShowCreateModal(true)}
                className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline font-bold transition-colors"
              >
                + Add Flow
              </button>
            </div>

            {/* Search Input */}
            <input
              type="text"
              placeholder="Search workflows..."
              value={searchSeq}
              onChange={(e) => setSearchSeq(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white text-sm outline-none focus:border-emerald-500 focus:bg-white dark:focus:bg-slate-900 transition-all"
            />

            {/* Sequences List */}
            {loading && sequences.length === 0 ? (
              <div className="p-8 text-sm text-slate-500 text-center">Loading workflows...</div>
            ) : filteredSequences.length === 0 ? (
              <div className="p-8 text-sm text-slate-500 text-center border border-dashed rounded-xl border-slate-200 dark:border-slate-800">
                No sequences found. Create your first sequence above.
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[600px] overflow-y-auto pr-1">
                {filteredSequences.map((s) => {
                  const isSelected = selectedSeqId === s.id;
                  return (
                    <div
                      key={s.id}
                      onClick={() => setSelectedSeqId(s.id)}
                      className={`p-4 rounded-xl border transition-all cursor-pointer text-left relative group ${
                        isSelected
                          ? "bg-emerald-50/60 dark:bg-emerald-950/40 border-emerald-500 shadow-xs"
                          : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-50/60 dark:hover:bg-slate-800/50"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-sm text-slate-900 dark:text-white truncate block">
                              {s.name}
                            </span>
                            {isSelected && (
                              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                            )}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono text-xs">
                              {s.stepCount} {s.stepCount === 1 ? "step" : "steps"}
                            </span>
                            <span>·</span>
                            <span>{new Date(s.updatedAt).toLocaleDateString()}</span>
                          </div>
                        </div>

                        {/* Status Toggle Switch */}
                        <div
                          className="flex items-center gap-1 shrink-0 pt-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => handleToggleEnabled(s.id, s.enabled)}
                            className={`w-10 h-[22px] rounded-full transition-colors relative flex items-center p-0.5 ${
                              s.enabled ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-700"
                            }`}
                            aria-label={s.enabled ? "Disable sequence" : "Enable sequence"}
                          >
                            <div
                              className={`w-4.5 h-4.5 rounded-full bg-white shadow-xs transform transition-transform ${
                                s.enabled ? "translate-x-4.5" : "translate-x-0"
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quick Info Card */}
          <div className="bg-slate-50 dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 space-y-2 text-xs">
            <div className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5 text-sm">
              <span>🛡️</span>
              <span>Delivery-Triggered Rules</span>
            </div>
            <p className="text-slate-600 dark:text-slate-400 leading-relaxed m-0 text-xs">
              Step 0 materializes immediately upon enrollment. Subsequent steps materialize strictly after the previous step receives WhatsApp delivery confirmation.
            </p>
          </div>
        </div>

        {/* Right Column: Workflow Builder & Simulator (8 Cols) */}
        <div className="lg:col-span-8 space-y-5">
          {selectedSeq ? (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden transition-colors">
              {/* Sequence Header Bar */}
              <div className="p-6 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2.5">
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white m-0 tracking-tight">
                      {selectedSeq.name}
                    </h2>
                    {selectedSeq.enabled ? (
                      <span className="badge badge-success text-xs">Active Flow</span>
                    ) : (
                      <span className="badge badge-standby text-xs">Disabled</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono">
                    ID: {selectedSeq.id} · {stepsDraft.length} of 10 maximum steps configured
                  </div>
                </div>

                <div className="flex items-center gap-2.5">
                  {/* View Mode Toggle: Builder vs Simulator */}
                  <div className="flex items-center bg-slate-200 dark:bg-slate-800 p-1 rounded-xl border border-slate-300 dark:border-slate-700 text-xs">
                    <button
                      type="button"
                      onClick={() => setViewMode("builder")}
                      className={`px-3.5 py-1.5 rounded-lg font-bold transition-all ${
                        viewMode === "builder"
                          ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs"
                          : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                      }`}
                    >
                      Workflow Builder
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode("simulator")}
                      className={`px-3.5 py-1.5 rounded-lg font-bold transition-all ${
                        viewMode === "simulator"
                          ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs"
                          : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                      }`}
                    >
                      📱 Phone Simulator
                    </button>
                  </div>

                  <button
                    onClick={() => handleDeleteSequence(selectedSeq.id)}
                    className="px-3 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg border border-transparent hover:border-red-200 dark:hover:border-red-900 transition-colors font-semibold"
                  >
                    Delete Flow
                  </button>
                </div>
              </div>

              {stepsError && <div className="error-banner m-6">{stepsError}</div>}
              {stepsSuccess && (
                <div className="badge badge-success p-3.5 m-6 block text-sm rounded-xl animate-fade-in">
                  {stepsSuccess}
                </div>
              )}

              {/* View 1: Workflow Builder */}
              {viewMode === "builder" && (
                <div className="p-7 space-y-7">
                  {/* Root Trigger Node */}
                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-2xl bg-emerald-600 text-white flex items-center justify-center font-bold text-base shrink-0 shadow-sm">
                      ⚡
                    </div>
                    <div className="flex-1 p-4 rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30 shadow-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm text-emerald-900 dark:text-emerald-300">
                          Trigger: When Contact Enrolls
                        </span>
                        <span className="text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/60 px-2.5 py-0.5 rounded-full font-bold">
                          Entry Point
                        </span>
                      </div>
                      <p className="text-xs text-emerald-800 dark:text-emerald-400/90 mt-1 m-0">
                        Enrollment initiates this flow. Step 1 will be scheduled according to its configured delay.
                      </p>
                    </div>
                  </div>

                  {/* Steps Timeline Loop */}
                  {stepsDraft.map((step, idx) => (
                    <div key={idx} className="relative pl-5 space-y-4">
                      {/* Vertical Connecting Line */}
                      <div className="absolute left-5 top-0 bottom-0 w-0.5 bg-slate-200 dark:bg-slate-800 -ml-[1px]" />

                      {/* Delay Connector Pill */}
                      <div className="relative z-10 flex items-center gap-3 pt-2">
                        <div className="w-7 h-7 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 flex items-center justify-center text-xs shrink-0 shadow-xs">
                          ⏱
                        </div>
                        <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-xs flex flex-wrap items-center gap-2.5 shadow-xs">
                          <span className="font-bold text-slate-800 dark:text-slate-200">
                            {formatDelay(step.delaySeconds)}:
                          </span>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {DELAY_PRESETS.map((preset) => (
                              <button
                                key={preset.label}
                                type="button"
                                onClick={() => handleStepChange(idx, { delaySeconds: preset.seconds })}
                                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
                                  step.delaySeconds === preset.seconds
                                    ? "bg-emerald-600 text-white shadow-xs"
                                    : "bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-600"
                                }`}
                              >
                                {preset.label}
                              </button>
                            ))}
                            {/* Custom seconds input */}
                            <div className="flex items-center gap-1 ml-1.5">
                              <input
                                type="number"
                                min="0"
                                max="2592000"
                                value={step.delaySeconds}
                                onChange={(e) =>
                                  handleStepChange(idx, {
                                    delaySeconds: Math.max(0, parseInt(e.target.value, 10) || 0),
                                  })
                                }
                                className="w-20 p-1 border rounded-lg text-xs font-mono text-center outline-none focus:border-emerald-500 bg-white dark:bg-slate-700 border-slate-300 dark:border-slate-600 text-slate-900 dark:text-white"
                              />
                              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">sec</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Step Message Card */}
                      <div className="relative z-10 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm hover:border-emerald-400 dark:hover:border-emerald-500 transition-all space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5">
                            <span className="w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-800 dark:text-emerald-300 font-bold text-xs flex items-center justify-center">
                              {idx + 1}
                            </span>
                            <span className="font-bold text-sm text-slate-900 dark:text-white">
                              Step {idx + 1} WhatsApp Message
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => handleMoveStep(idx, "up")}
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:pointer-events-none"
                              title="Move step up"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={idx === stepsDraft.length - 1}
                              onClick={() => handleMoveStep(idx, "down")}
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 disabled:pointer-events-none"
                              title="Move step down"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveStep(idx)}
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors ml-1"
                              title="Delete step"
                            >
                              ✕
                            </button>
                          </div>
                        </div>

                        {/* Message Composer Area */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                              Message Content
                            </span>
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-slate-500 dark:text-slate-400">Insert tag:</span>
                              <button
                                type="button"
                                onClick={() => handleInsertVariable(idx, "display_name")}
                                className="px-2.5 py-0.5 rounded-md text-xs font-mono bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 dark:hover:bg-emerald-900 transition-colors"
                              >
                                + {"{{display_name}}"}
                              </button>
                            </div>
                          </div>
                          <textarea
                            rows={4}
                            value={step.body}
                            placeholder="Type WhatsApp message here. Use {{display_name}} for lead name."
                            onChange={(e) => handleStepChange(idx, { body: e.target.value })}
                            className="w-full p-3.5 border rounded-xl text-sm font-mono outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white leading-relaxed"
                          />
                          <div className="flex justify-between items-center text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                            <span>Plain text only · Plain line breaks supported</span>
                            <span>{step.body.length} characters</span>
                          </div>
                        </div>

                        {/* Live WhatsApp Bubble Preview */}
                        <div className="p-4 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
                          <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider block mb-2.5">
                            WhatsApp Bubble Simulation
                          </span>
                          <div className="flex justify-end">
                            <div className="max-w-[85%] rounded-2xl rounded-tr-none px-4 py-2.5 bg-[#DCF8C6] dark:bg-[#005c4b] border border-[#c3e8ad] dark:border-[#025142] text-sm text-slate-900 dark:text-slate-100 shadow-xs relative">
                              <div className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                                {step.body || <span className="text-slate-400 italic">Empty message text...</span>}
                              </div>
                              <div className="flex items-center justify-end gap-1.5 text-xs text-slate-500 dark:text-slate-300 mt-1">
                                <span>10:30 AM</span>
                                <span className="text-blue-500 dark:text-blue-400 font-bold">✓✓</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Add Step Card */}
                  {stepsDraft.length < 10 ? (
                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={handleAddStep}
                        className="w-full py-4 rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-emerald-500 dark:hover:border-emerald-500 hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20 text-slate-600 dark:text-slate-400 hover:text-emerald-700 dark:hover:text-emerald-400 font-semibold text-sm transition-all flex items-center justify-center gap-2 group"
                      >
                        <span className="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-700 group-hover:bg-emerald-600 group-hover:text-white flex items-center justify-center text-xs transition-colors font-bold">
                          +
                        </span>
                        <span>Add Step {stepsDraft.length + 1} ({10 - stepsDraft.length} remaining)</span>
                      </button>
                    </div>
                  ) : (
                    <div className="p-4 text-center text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 rounded-xl border border-amber-200 dark:border-amber-800">
                      Maximum limit of 10 sequence steps reached.
                    </div>
                  )}

                  {/* Save Steps Floating Bar */}
                  <div className="pt-5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Delays automatically respect quiet hours and roll to opening minute.
                    </span>
                    <button
                      type="button"
                      onClick={handleSaveSteps}
                      disabled={savingSteps}
                      className="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-sm hover:shadow transition-all flex items-center gap-2.5 active:scale-95 disabled:opacity-50"
                    >
                      {savingSteps ? (
                        <>
                          <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          <span>Saving Workflow...</span>
                        </>
                      ) : (
                        <>
                          <span>✓</span>
                          <span>Save Workflow Steps</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* View 2: WhatsApp Chat Simulator */}
              {viewMode === "simulator" && (
                <div className="p-10 bg-slate-100 dark:bg-slate-950 flex justify-center items-center transition-colors">
                  {/* Smartphone Frame Mockup */}
                  <div className="w-full max-w-sm rounded-[36px] overflow-hidden border-[8px] border-slate-800 dark:border-slate-700 shadow-2xl bg-[#EFEAE2] dark:bg-[#0b141a]">
                    {/* Phone Status Bar */}
                    <div className="bg-[#075E54] dark:bg-[#1f2c34] text-white px-5 py-2.5 flex items-center justify-between text-xs font-semibold">
                      <span>9:41</span>
                      <div className="flex items-center gap-2 text-xs">
                        <span>5G</span>
                        <span>100%</span>
                      </div>
                    </div>

                    {/* WhatsApp Chat Header */}
                    <div className="bg-[#075E54] dark:bg-[#1f2c34] text-white px-4 py-3 flex items-center gap-3 border-b border-[#054c44] dark:border-slate-800">
                      <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center font-bold text-sm">
                        👤
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-sm truncate">Prospect Contact</div>
                        <div className="text-xs text-emerald-200 dark:text-emerald-400">online</div>
                      </div>
                      <span className="text-base">⋮</span>
                    </div>

                    {/* Chat Bubble Thread */}
                    <div className="p-4 space-y-4 min-h-[440px] max-h-[520px] overflow-y-auto">
                      <div className="text-center">
                        <span className="px-3 py-1 rounded-full bg-white/80 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300 shadow-xs font-semibold">
                          TODAY
                        </span>
                      </div>

                      {stepsDraft.length === 0 ? (
                        <div className="p-10 text-center text-sm text-slate-500 italic">
                          No sequence steps added yet. Add steps in Workflow Builder to preview here.
                        </div>
                      ) : (
                        stepsDraft.map((st, idx) => (
                          <div key={idx} className="space-y-1">
                            {idx > 0 && (
                              <div className="text-center my-3">
                                <span className="px-3 py-1 rounded-full bg-emerald-100/90 dark:bg-emerald-950/80 text-xs text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800 font-mono font-semibold">
                                  ⏱ {formatDelay(st.delaySeconds)}
                                </span>
                              </div>
                            )}

                            <div className="flex justify-end">
                              <div className="max-w-[85%] rounded-2xl rounded-tr-none px-4 py-2.5 bg-[#DCF8C6] dark:bg-[#005c4b] border border-[#c3e8ad] dark:border-[#025142] text-sm text-slate-900 dark:text-slate-100 shadow-xs relative">
                                <div className="text-[10px] font-bold text-emerald-800 dark:text-emerald-300 mb-0.5">
                                  Step {idx + 1}
                                </div>
                                <div className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                                  {st.body || <span className="text-slate-400 italic">No message text</span>}
                                </div>
                                <div className="flex items-center justify-end gap-1.5 text-[10px] text-slate-500 dark:text-slate-300 mt-1">
                                  <span>12:00 PM</span>
                                  <span className="text-blue-500 dark:text-blue-400 font-bold">✓✓</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    {/* Fake WhatsApp Input */}
                    <div className="bg-[#F0F0F0] dark:bg-[#1f2c34] p-2.5 flex items-center gap-2.5 border-t border-slate-300 dark:border-slate-800">
                      <div className="flex-1 bg-white dark:bg-slate-800 rounded-full px-4 py-2 text-xs text-slate-400">
                        Type a message
                      </div>
                      <div className="w-9 h-9 rounded-full bg-[#075E54] dark:bg-emerald-600 text-white flex items-center justify-center text-xs">
                        🎤
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Enroll Lead Drawer / Card */}
              <div className="p-7 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider m-0">
                      Enroll Contact into Sequence
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 m-0">
                      Select an existing contact or enter an ID to immediately initiate this drip campaign.
                    </p>
                  </div>
                  {activeEnrollmentsCount > 0 && (
                    <span className="badge badge-success text-xs">
                      {activeEnrollmentsCount} Currently Active
                    </span>
                  )}
                </div>

                {enrollError && <div className="error-banner text-xs">{enrollError}</div>}
                {enrollSuccess && (
                  <div className="badge badge-success p-3 block text-sm rounded-xl animate-fade-in">
                    {enrollSuccess}
                  </div>
                )}

                <form onSubmit={handleEnrollLead} className="flex flex-col sm:flex-row gap-3 items-center">
                  {/* Leads Dropdown Selection */}
                  {leads.length > 0 && (
                    <select
                      value={enrollLeadId}
                      onChange={(e) => setEnrollLeadId(e.target.value)}
                      className="w-full sm:w-1/2 p-3 border rounded-xl text-sm outline-none focus:border-emerald-500 bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white"
                    >
                      <option value="">-- Choose Lead from Desk ({leads.length}) --</option>
                      {leads.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.displayName} {l.primaryPhone ? `(${l.primaryPhone})` : ""}
                        </option>
                      ))}
                    </select>
                  )}

                  {/* Manual Lead ID Input */}
                  <input
                    type="text"
                    placeholder="Or enter Lead ID (led_...)"
                    value={enrollLeadId}
                    onChange={(e) => setEnrollLeadId(e.target.value)}
                    className="w-full sm:flex-1 p-3 border rounded-xl text-sm font-mono outline-none focus:border-emerald-500 bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white"
                    required
                  />

                  <button
                    type="submit"
                    disabled={enrolling || !selectedSeq.enabled || selectedSeq.steps.length === 0}
                    title={
                      selectedSeq.steps.length === 0
                        ? "Save at least one step before enrolling leads."
                        : !selectedSeq.enabled
                        ? "Enable this sequence to enroll leads."
                        : undefined
                    }
                    className="w-full sm:w-auto px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-sm transition-all whitespace-nowrap disabled:opacity-50"
                  >
                    {enrolling ? "Enrolling..." : "+ Enroll Lead"}
                  </button>
                </form>
              </div>
            </div>
          ) : (
            <div className="p-16 text-center text-sm text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
              Select a sequence from the left sidebar to view and customize its steps.
            </div>
          )}

          {/* Enrollments History Table Card */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-6 space-y-5 transition-colors">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-xl font-bold text-slate-900 dark:text-white m-0 tracking-tight">
                  Sequence Enrollments ({enrollments.length})
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 m-0">
                  Audit trail of all active and historical contacts enrolled in workflows
                </p>
              </div>

              {/* Status Filter Tabs */}
              <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 dark:bg-slate-800 p-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs">
                {["all", "active", "completed", "stopped", "cancelled"].map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setEnrollmentStatusFilter(st)}
                    className={`px-3 py-1.5 rounded-lg capitalize font-bold transition-all ${
                      enrollmentStatusFilter === st
                        ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs"
                        : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>

            {filteredEnrollments.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400 border border-dashed rounded-xl border-slate-200 dark:border-slate-800">
                No enrollments found for the selected status filter.
              </div>
            ) : (
              <div className="table-responsive">
                <table className="table w-full">
                  <thead>
                    <tr>
                      <th>Sequence</th>
                      <th>Lead ID</th>
                      <th>Status</th>
                      <th>Started</th>
                      <th>Stopped</th>
                      <th className="text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEnrollments.map((enr) => (
                      <tr key={enr.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors">
                        <td className="font-bold text-sm text-slate-900 dark:text-white">{enr.sequenceName}</td>
                        <td className="font-mono text-xs text-slate-500 dark:text-slate-400">{enr.leadId}</td>
                        <td>
                          {enr.status === "active" && (
                            <span className="badge badge-success text-xs flex items-center gap-1.5 w-fit">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              Active
                            </span>
                          )}
                          {enr.status === "completed" && (
                            <span className="badge badge-standby text-xs">Completed</span>
                          )}
                          {enr.status === "cancelled" && (
                            <span className="badge badge-gray text-xs">Cancelled</span>
                          )}
                          {enr.status === "stopped" && (
                            <span className="badge badge-danger text-xs">Stopped</span>
                          )}
                        </td>
                        <td className="text-sm text-slate-500 dark:text-slate-400">{new Date(enr.startedAt).toLocaleString()}</td>
                        <td className="text-sm text-slate-500 dark:text-slate-400">
                          {enr.stoppedAt ? new Date(enr.stoppedAt).toLocaleString() : "—"}
                        </td>
                        <td className="text-right">
                          {enr.status === "active" && (
                            <button
                              type="button"
                              className="btn btn-danger text-xs px-3 py-1.5"
                              onClick={() => handleCancelEnrollment(enr.id)}
                            >
                              Cancel
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* New Sequence Modal */}
      {showCreateModal && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="modal-content bg-white dark:bg-slate-900 rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg p-7 animate-scale-in space-y-5">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <span className="w-8 h-8 rounded-xl bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 flex items-center justify-center text-base font-bold">
                  💬
                </span>
                <h3 className="text-xl font-bold text-slate-900 dark:text-white m-0 tracking-tight">
                  Create WhatsApp Sequence
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="w-8 h-8 rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-sm transition-colors"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateSequence} className="space-y-5">
              <div>
                <label className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1.5 uppercase tracking-wider">
                  Sequence Name *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Inbound Demo Follow-up"
                  value={newSeqName}
                  onChange={(e) => setNewSeqName(e.target.value)}
                  className="w-full p-3 border rounded-xl text-sm font-semibold outline-none focus:border-emerald-500 bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white"
                  required
                  autoFocus
                />
              </div>

              {/* Starter Templates Picker */}
              <div>
                <label className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-2 uppercase tracking-wider">
                  Start from a Proven Template (Optional)
                </label>
                <div className="space-y-2.5">
                  {SEQUENCE_TEMPLATES.map((tpl, tIdx) => (
                    <div
                      key={tpl.name}
                      onClick={() => {
                        setSelectedTemplateIndex(tIdx);
                        if (!newSeqName) setNewSeqName(tpl.name);
                      }}
                      className={`p-3.5 rounded-2xl border transition-all cursor-pointer ${
                        selectedTemplateIndex === tIdx
                          ? "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 shadow-xs"
                          : "bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm text-slate-900 dark:text-white">{tpl.name}</span>
                        <span className="text-xs px-2 py-0.5 rounded-md bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-600 font-mono">
                          {tpl.steps.length} steps
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 m-0 leading-relaxed">
                        {tpl.desc}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  className="btn btn-secondary text-sm px-4 py-2.5"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingSeq}
                  className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-sm transition-all"
                >
                  {creatingSeq ? "Creating..." : "Create Workflow"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
