import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../api.js";
import { useRouter } from "../router.js";
import { generateUlid } from "@leaddesk/shared";

interface Stage {
  id: string;
  name: string;
}

interface SequenceOption {
  id: string;
  name: string;
  enabled: boolean;
  stepCount: number;
}

interface LeadEnrollment {
  id: string;
  sequenceId: string;
  sequenceName: string;
  leadId: string;
  status: "active" | "completed" | "cancelled" | "stopped";
  currentStepId: string | null;
  startedAt: string;
  stoppedAt: string | null;
}

interface LeadMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  fromMe: boolean;
  waTimestamp: string;
  aiState: string | null;
  aiReason: string | null;
}

interface QuickReply {
  id: string;
  title: string;
  body: string;
}

interface ScheduledMessage {
  id: string;
  leadId: string;
  body: string;
  requestedAt: string;
  allowDuringQuietHours: boolean;
  status: string;
}

// Friendly explanations for the send/schedule guard codes returned by the server.
function describeSendError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  switch (e.code) {
    case "quiet_hours":
      return 'It is currently inside quiet hours. Tick "Allow during quiet hours" to send anyway, or schedule it for later.';
    case "do_not_message":
      return "This lead is marked Do Not Message (DND). Clear the DND flag to message them.";
    case "no_phone":
      return "This lead has no primary phone number. Add one under Phone Identities first.";
    case "cap_reached":
      return "The daily manual send cap has been reached. Raise it in Policy & System or schedule for later.";
    default:
      return e.message || "Failed to send message.";
  }
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface PhoneItem {
  id: string;
  e164: string | null;
  waJid: string | null;
  waLid: string | null;
  primary: boolean;
  createdAt: string;
}

interface LeadDetail {
  id: string;
  displayName: string;
  notes: string;
  stageId: string;
  stageName: string;
  aiEnabled: boolean;
  requireApproval: boolean;
  automationPaused: boolean;
  doNotMessage: boolean;
  archivedAt: string | null;
  phones: PhoneItem[];
  createdAt: string;
  updatedAt: string;
}

export function LeadDetailView({ leadId }: { leadId: string }) {
  const { navigate } = useRouter();
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSuccess, setNotesSuccess] = useState(false);
  const [notesText, setNotesText] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [sequences, setSequences] = useState<SequenceOption[]>([]);
  const [enrollments, setEnrollments] = useState<LeadEnrollment[]>([]);
  const [selectedSeqId, setSelectedSeqId] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [timelineMessages, setTimelineMessages] = useState<LeadMessage[]>([]);
  const [notesError, setNotesError] = useState<string | null>(null);
  // Last notes value known to be persisted on the server; used to detect unsaved edits.
  const savedNotesRef = useRef<string>("");

  // Composer state
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledMessage[]>([]);
  const [composeBody, setComposeBody] = useState("");
  const [allowQuietHours, setAllowQuietHours] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [composeBusy, setComposeBusy] = useState<"send" | "schedule" | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeSuccess, setComposeSuccess] = useState<string | null>(null);

  const loadScheduled = async () => {
    try {
      const res = await apiRequest<{ items: ScheduledMessage[] }>("/api/v1/scheduled-messages");
      const now = Date.now();
      setScheduled(
        res.items
          .filter((m) => m.leadId === leadId && m.status !== "cancelled" && new Date(m.requestedAt).getTime() > now)
          .sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime())
      );
    } catch {
      setScheduled([]);
    }
  };

  const loadLead = async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const [leadRes, stagesRes, seqRes, enrRes, msgRes, qrRes] = await Promise.all([
        apiRequest<LeadDetail>(`/api/v1/leads/${leadId}`),
        apiRequest<{ items: Stage[] }>("/api/v1/stages"),
        apiRequest<{ items: SequenceOption[] }>("/api/v1/sequences").catch(() => ({ items: [] })),
        apiRequest<{ items: LeadEnrollment[] }>(`/api/v1/enrollments?leadId=${leadId}`).catch(() => ({ items: [] })),
        apiRequest<{ items: LeadMessage[] }>(`/api/v1/messages?leadId=${leadId}`).catch(() => ({ items: [] })),
        apiRequest<{ items: QuickReply[] }>("/api/v1/quick-replies").catch(() => ({ items: [] as QuickReply[] })),
      ]);
      setLead(leadRes);
      // Keep unsaved note edits when refreshing after phone/enroll actions.
      setNotesText((prev) => (initial || prev === savedNotesRef.current ? leadRes.notes : prev));
      savedNotesRef.current = leadRes.notes;
      setQuickReplies(qrRes.items);
      setStages(stagesRes.items);
      setSequences(seqRes.items);
      setEnrollments(enrRes.items);
      setTimelineMessages(msgRes.items.reverse());
      const enabledSeqs = seqRes.items.filter((s) => s.enabled && s.stepCount > 0);
      setSelectedSeqId((prev) =>
        prev && enabledSeqs.some((s) => s.id === prev) ? prev : enabledSeqs[0]?.id ?? ""
      );
    } catch {
      // Handled
    } finally {
      if (initial) setLoading(false);
    }
  };

  useEffect(() => {
    setComposeBody("");
    setComposeError(null);
    setComposeSuccess(null);
    loadLead(true);
    loadScheduled();
  }, [leadId]);

  const patchLead = async (updates: Partial<LeadDetail>) => {
    if (!lead) return;
    try {
      const updated = await apiRequest<LeadDetail>(`/api/v1/leads/${leadId}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      });
      setLead(updated);
    } catch (err: unknown) {
      alert((err as { message?: string }).message || "Failed to update lead");
    }
  };

  const saveNotes = async () => {
    setSavingNotes(true);
    setNotesSuccess(false);
    setNotesError(null);
    const toSave = notesText;
    try {
      const updated = await apiRequest<LeadDetail>(`/api/v1/leads/${leadId}`, {
        method: "PATCH",
        body: JSON.stringify({ notes: toSave }),
      });
      setLead(updated);
      savedNotesRef.current = toSave;
      setNotesSuccess(true);
      setTimeout(() => setNotesSuccess(false), 2500);
    } catch (err: unknown) {
      setNotesError((err as { message?: string }).message || "Failed to save notes");
    } finally {
      setSavingNotes(false);
    }
  };

  const handleSendNow = async () => {
    const body = composeBody.trim();
    if (!body) return;
    setComposeBusy("send");
    setComposeError(null);
    setComposeSuccess(null);
    try {
      await apiRequest(`/api/v1/leads/${leadId}/send`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ body, allowDuringQuietHours: allowQuietHours || undefined }),
      });
      setComposeBody("");
      setComposeSuccess("Message queued for sending. Track it in the Outbound Queue.");
      setTimeout(() => setComposeSuccess(null), 4000);
    } catch (err: unknown) {
      setComposeError(describeSendError(err));
    } finally {
      setComposeBusy(null);
    }
  };

  const handleSchedule = async () => {
    const body = composeBody.trim();
    if (!body) return;
    const due = scheduleAt ? new Date(scheduleAt) : null;
    if (!due || isNaN(due.getTime())) {
      setComposeError("Pick a valid date and time to schedule the message.");
      return;
    }
    if (due.getTime() <= Date.now()) {
      setComposeError('The scheduled time must be in the future. Use "Send now" instead.');
      return;
    }
    setComposeBusy("schedule");
    setComposeError(null);
    setComposeSuccess(null);
    try {
      await apiRequest("/api/v1/scheduled-messages", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          leadId,
          body,
          dueAt: due.toISOString(),
          allowDuringQuietHours: allowQuietHours || undefined,
        }),
      });
      setComposeBody("");
      setScheduleAt("");
      setComposeSuccess(
        `Scheduled for ${due.toLocaleString()}.${
          allowQuietHours ? "" : " If that falls inside quiet hours it will be moved to the next open minute."
        }`
      );
      setTimeout(() => setComposeSuccess(null), 5000);
      loadScheduled();
    } catch (err: unknown) {
      setComposeError(describeSendError(err));
    } finally {
      setComposeBusy(null);
    }
  };

  const handleCancelScheduled = async (id: string) => {
    if (!confirm("Cancel this scheduled message?")) return;
    setComposeError(null);
    try {
      await apiRequest(`/api/v1/scheduled-messages/${id}/cancel`, { method: "POST" });
      loadScheduled();
    } catch (err: unknown) {
      setComposeError((err as { message?: string }).message || "Failed to cancel scheduled message");
    }
  };

  const handleAddPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhoneError(null);
    try {
      await apiRequest(`/api/v1/leads/${leadId}/phones`, {
        method: "POST",
        body: JSON.stringify({ e164: newPhone, primary: lead?.phones.length === 0 }),
      });
      setNewPhone("");
      loadLead();
    } catch (err: unknown) {
      setPhoneError((err as { message?: string }).message || "Failed to add phone");
    }
  };

  const handleSetPrimaryPhone = async (phoneId: string) => {
    try {
      await apiRequest(`/api/v1/phones/${phoneId}`, {
        method: "PATCH",
        body: JSON.stringify({ primary: true }),
      });
      loadLead();
    } catch (err: unknown) {
      alert((err as { message?: string }).message || "Failed to set primary phone");
    }
  };

  const handleDeletePhone = async (phoneId: string) => {
    if (!confirm("Are you sure you want to delete this phone number?")) return;
    try {
      await apiRequest(`/api/v1/phones/${phoneId}`, { method: "DELETE" });
      loadLead();
    } catch (err: unknown) {
      alert((err as { message?: string }).message || "Failed to delete phone");
    }
  };

  const handleArchive = async () => {
    if (!confirm("Archive this lead? Any active sequences and queued messages will be cancelled.")) return;
    try {
      await apiRequest(`/api/v1/leads/${leadId}/archive`, { method: "POST" });
      navigate("/leads");
    } catch (err: unknown) {
      alert((err as { message?: string }).message || "Failed to archive lead");
    }
  };

  const handleEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSeqId) return;
    setEnrolling(true);
    try {
      const idempotencyKey = generateUlid("enr");
      await apiRequest(`/api/v1/sequences/${selectedSeqId}/enrollments`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ leadId }),
      });
      loadLead();
    } catch (err: unknown) {
      alert((err as { message?: string }).message || "Failed to enroll lead");
    } finally {
      setEnrolling(false);
    }
  };

  const handleCancelEnrollment = async (enrId: string) => {
    if (!confirm("Cancel sequence enrollment? Any queued or needs_approval step will be aborted.")) return;
    try {
      await apiRequest(`/api/v1/enrollments/${enrId}/cancel`, { method: "POST" });
      loadLead();
    } catch (err: unknown) {
      alert((err as { message?: string }).message || "Failed to cancel enrollment");
    }
  };

  if (loading) {
    return (
      <div className="py-24 text-center text-slate-400 dark:text-slate-500">
        <div className="inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-2" />
        <p className="text-sm">Loading lead record...</p>
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="p-6 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
        Lead not found or has been removed.
      </div>
    );
  }

  return (
    <div className="view-container animate-fade-in space-y-6">
      {/* View Header */}
      <div className="view-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <button
            className="btn btn-secondary text-sm px-3.5 py-2 rounded-lg"
            onClick={() => navigate("/leads")}
          >
            ← Back
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">
                {lead.displayName}
              </h1>
              {lead.archivedAt && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">
                  Archived
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
                {lead.stageName}
              </span>
              <span className="text-xs text-slate-400 font-mono">{lead.id}</span>
            </div>
          </div>
        </div>

        {!lead.archivedAt && (
          <button
            className="btn btn-danger text-sm px-4 py-2 rounded-lg"
            onClick={handleArchive}
          >
            Archive Lead
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Properties & Automation Toggles */}
        <div className="lg:col-span-5 space-y-6">
          <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-5">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">
              Automation &amp; Controls
            </h2>

            <div>
              <label className="text-xs font-bold text-slate-500 dark:text-slate-400 block mb-1.5 uppercase tracking-wider">
                Pipeline Stage
              </label>
              <select
                value={lead.stageId}
                onChange={(e) => patchLead({ stageId: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="pt-4 space-y-3.5 border-t border-slate-100 dark:border-slate-800">
              <label className="flex items-start gap-3 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={lead.aiEnabled}
                  onChange={(e) => patchLead({ aiEnabled: e.target.checked })}
                  className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 mt-0.5"
                />
                <div>
                  <span className="font-semibold text-slate-900 dark:text-white block">
                    AI Auto-Reply Enabled
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Draft responses using Grok-4.7 reasoning based on notes and history.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={lead.requireApproval}
                  onChange={(e) => patchLead({ requireApproval: e.target.checked })}
                  className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 mt-0.5"
                />
                <div>
                  <span className="font-semibold text-slate-900 dark:text-white block">
                    Require Human Approval
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Hold AI-generated replies in Outbound Queue until manually approved.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={lead.automationPaused}
                  onChange={(e) => patchLead({ automationPaused: e.target.checked })}
                  className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 mt-0.5"
                />
                <div>
                  <span className="font-semibold text-slate-900 dark:text-white block">
                    Pause Automated Sequences
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Suspend sequence progression while customer is engaged in live chat.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={lead.doNotMessage}
                  onChange={(e) => patchLead({ doNotMessage: e.target.checked })}
                  className="w-4 h-4 rounded text-rose-600 focus:ring-rose-500 mt-0.5"
                />
                <div>
                  <span className="font-bold text-rose-600 dark:text-rose-400 block">
                    Do Not Message (DND)
                  </span>
                  <span className="text-xs text-rose-500/80 dark:text-rose-400/70">
                    Strict compliance halt on all manual, AI, and sequence outbound messages.
                  </span>
                </div>
              </label>
            </div>
          </div>

          {/* Phone Numbers Card */}
          <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">
              Phone Identities
            </h2>

            {phoneError && (
              <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-xs">
                {phoneError}
              </div>
            )}

            <div className="space-y-2">
              {lead.phones.map((phone) => (
                <div
                  key={phone.id}
                  className="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40"
                >
                  <div>
                    <span className="font-mono font-bold text-sm text-slate-900 dark:text-white">
                      {phone.e164 || "LID-only"}
                    </span>
                    {phone.primary && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 ml-2">
                        Primary
                      </span>
                    )}
                    {phone.waLid && (
                      <div className="text-xs text-slate-400 font-mono mt-0.5">LID: {phone.waLid}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {!phone.primary && (
                      <button
                        className="btn btn-secondary text-xs px-2.5 py-1 rounded-md"
                        onClick={() => handleSetPrimaryPhone(phone.id)}
                      >
                        Make Primary
                      </button>
                    )}
                    <button
                      className="btn btn-danger text-xs px-2.5 py-1 rounded-md"
                      onClick={() => handleDeletePhone(phone.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={handleAddPhone} className="flex gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
              <input
                type="text"
                placeholder="+15551234567"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                className="flex-1 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-xs font-mono transition-colors"
              />
              <button type="submit" className="btn btn-primary text-xs px-4 py-2 font-medium rounded-lg">
                Add Phone
              </button>
            </form>
          </div>

          {/* Follow-up Sequence Enrollment Card */}
          <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">
              Active WhatsApp Drip
            </h2>

            {enrollments.some((e) => e.status === "active") ? (
              <div className="space-y-2">
                {enrollments
                  .filter((e) => e.status === "active")
                  .map((enr) => (
                    <div
                      key={enr.id}
                      className="flex items-center justify-between p-3.5 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50/50 dark:bg-indigo-950/20"
                    >
                      <div>
                        <div className="font-bold text-sm text-slate-900 dark:text-white">
                          {enr.sequenceName}
                        </div>
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 mt-1">
                          In Progress
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 ml-2">
                          Enrolled {new Date(enr.startedAt).toLocaleDateString()}
                        </span>
                      </div>
                      <button
                        className="btn btn-danger text-xs px-3 py-1.5 rounded-lg"
                        onClick={() => handleCancelEnrollment(enr.id)}
                      >
                        Cancel
                      </button>
                    </div>
                  ))}
              </div>
            ) : (
              <div>
                {sequences.filter((s) => s.enabled && s.stepCount > 0).length === 0 ? (
                  <p className="text-sm text-slate-400 dark:text-slate-500 m-0">
                    No active sequences with steps available.
                  </p>
                ) : (
                  <form onSubmit={handleEnroll} className="flex gap-2 items-center">
                    <select
                      value={selectedSeqId}
                      onChange={(e) => setSelectedSeqId(e.target.value)}
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
                    >
                      {sequences
                        .filter((s) => s.enabled && s.stepCount > 0)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({s.stepCount} steps)
                          </option>
                        ))}
                    </select>
                    <button
                      type="submit"
                      className="btn btn-primary text-xs px-4 py-2 font-medium rounded-lg whitespace-nowrap"
                      disabled={enrolling || lead.doNotMessage || Boolean(lead.archivedAt)}
                    >
                      {enrolling ? "Enrolling..." : "Enroll in Drip"}
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Lead Notes & Conversation Timeline */}
        <div className="lg:col-span-7 space-y-6">
          {/* Notes Card */}
          <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">
                  Lead Notes &amp; AI Context
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Fed into SpaceXSI Grok-4.7 prompt for personalization.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {notesSuccess && (
                  <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    ✓ Saved
                  </span>
                )}
                {!notesSuccess && !savingNotes && notesText !== savedNotesRef.current && (
                  <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">Unsaved changes</span>
                )}
                <button
                  className="btn btn-primary text-xs px-4 py-2 font-medium rounded-lg"
                  onClick={saveNotes}
                  disabled={savingNotes}
                >
                  {savingNotes ? "Saving..." : "Save Notes"}
                </button>
              </div>
            </div>

            {notesError && (
              <div
                className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-xs"
                role="alert"
              >
                {notesError}
              </div>
            )}

            <textarea
              rows={6}
              className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-mono transition-colors"
              placeholder="Record business context, budget, timeline, pain points..."
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
            />
          </div>

          {/* Message Composer Card */}
          <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Send a Message</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Queued through the paired WhatsApp sender with anti-ban pacing.
                </p>
              </div>
              {quickReplies.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    const qr = quickReplies.find((q) => q.id === e.target.value);
                    if (qr) setComposeBody((prev) => (prev.trim() ? `${prev}\n${qr.body}` : qr.body));
                  }}
                  className="sm:w-56 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
                  aria-label="Insert quick reply"
                >
                  <option value="">Insert quick reply…</option>
                  {quickReplies.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.title}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {(lead.doNotMessage || lead.archivedAt || lead.phones.length === 0) && (
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 text-xs">
                {lead.archivedAt
                  ? "This lead is archived; messages can't be sent."
                  : lead.doNotMessage
                  ? "This lead is marked Do Not Message (DND); sends will be rejected."
                  : "This lead has no phone number yet; add one under Phone Identities."}
              </div>
            )}

            {composeError && (
              <div
                className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm"
                role="alert"
              >
                {composeError}
              </div>
            )}
            {composeSuccess && (
              <div
                className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300 text-sm"
                role="status"
              >
                {composeSuccess}
              </div>
            )}

            <div>
              <textarea
                rows={4}
                value={composeBody}
                onChange={(e) => setComposeBody(e.target.value)}
                placeholder="Type a WhatsApp message…"
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm transition-colors"
              />
              <div className="flex justify-end text-xs text-slate-400 mt-1">{composeBody.length} characters</div>
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allowQuietHours}
                onChange={(e) => setAllowQuietHours(e.target.checked)}
                className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500"
              />
              Allow during quiet hours
            </label>

            <div className="flex flex-col sm:flex-row sm:items-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                className="btn btn-primary text-sm px-5 py-2 font-medium rounded-lg"
                onClick={handleSendNow}
                disabled={composeBusy !== null || !composeBody.trim() || Boolean(lead.archivedAt)}
              >
                {composeBusy === "send" ? "Sending..." : "Send now"}
              </button>
              <div className="flex-1 flex flex-col sm:flex-row sm:items-end gap-2 sm:justify-end">
                <div>
                  <label className="text-xs font-bold text-slate-500 dark:text-slate-400 block mb-1 uppercase tracking-wider">
                    Schedule for
                  </label>
                  <input
                    type="datetime-local"
                    value={scheduleAt}
                    min={toLocalInputValue(new Date())}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    className="w-full sm:w-auto px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-secondary text-sm px-5 py-2 font-medium rounded-lg"
                  onClick={handleSchedule}
                  disabled={composeBusy !== null || !composeBody.trim() || !scheduleAt || Boolean(lead.archivedAt)}
                >
                  {composeBusy === "schedule" ? "Scheduling..." : "Schedule"}
                </button>
              </div>
            </div>

            {scheduled.length > 0 && (
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
                <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider m-0">
                  Upcoming scheduled messages
                </h3>
                {scheduled.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-start justify-between gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                        {new Date(m.requestedAt).toLocaleString()}
                        {m.allowDuringQuietHours && <span className="ml-2">(quiet hours allowed)</span>}
                      </div>
                      <p className="text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words m-0 mt-1">
                        {m.body}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger text-xs px-3 py-1.5 rounded-lg shrink-0"
                      onClick={() => handleCancelScheduled(m.id)}
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Conversation Timeline Card */}
          <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">
                Conversation Timeline
              </h2>
              <span className="text-xs text-slate-400">
                {timelineMessages.length} total messages
              </span>
            </div>

            {timelineMessages.length === 0 ? (
              <div className="py-16 text-center text-slate-400 dark:text-slate-500">
                <p className="text-sm">No messages exchanged with this lead yet.</p>
              </div>
            ) : (
              <div className="space-y-4 max-h-[560px] overflow-y-auto p-4 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                {timelineMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col max-w-[85%] ${
                      msg.direction === "inbound" ? "mr-auto items-start" : "ml-auto items-end"
                    }`}
                  >
                    <div
                      className={`p-3.5 rounded-2xl text-sm leading-relaxed shadow-sm ${
                        msg.direction === "inbound"
                          ? "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-tl-sm"
                          : "bg-[#DCF8C6] dark:bg-[#005c4b] text-slate-900 dark:text-slate-100 rounded-tr-sm"
                      }`}
                    >
                      <div className="text-xs font-semibold mb-1 opacity-75">
                        {msg.direction === "inbound" ? "Customer" : "Lead Desk"}
                      </div>
                      <p className="whitespace-pre-wrap font-sans m-0">{msg.body}</p>
                      <div className="flex items-center justify-end gap-1 mt-1 text-[10px] opacity-70">
                        <span>
                          {new Date(msg.waTimestamp).toLocaleString([], {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {msg.direction === "outbound" && (
                          // Single tick: we only know the message was submitted, not delivered/read.
                          <span className="text-emerald-700 dark:text-emerald-300 font-bold" title="Submitted to WhatsApp">
                            ✓
                          </span>
                        )}
                      </div>
                    </div>

                    {msg.aiState && (
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-400">
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium">
                          AI: {msg.aiState}
                        </span>
                        {msg.aiReason && <span>({msg.aiReason})</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
