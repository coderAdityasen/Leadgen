import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  daysSince,
  formatDue,
  newIdempotencyKey,
  relativeDay,
  shortId,
  truncate,
  useBoard,
  whatsappUrl,
  type LeadCard,
} from "../crmBoard.js";
import { Toggle } from "./Toggle.js";
import { IconClock, IconCopy, IconPencil, IconWhatsApp } from "./icons.js";

const iconBtn =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-slate-200 dark:hover:bg-slate-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500";

/* ---------- Select + ID ---------- */

export function SelectCell({ lead }: { lead: LeadCard }) {
  const { selected, toggleSelected } = useBoard();
  return (
    <div className="flex flex-col items-center gap-1.5 pt-0.5">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
        checked={selected.has(lead.id)}
        onChange={() => toggleSelected(lead.id)}
        aria-label={`Select ${lead.displayName}`}
      />
      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400" title={lead.id}>
        {shortId(lead.id)}
      </span>
    </div>
  );
}

/* ---------- Personal details ---------- */

export function PersonalCell({ lead, showToggles = true }: { lead: LeadCard; showToggles?: boolean }) {
  const { actions } = useBoard();
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <a
          href={`/leads/${lead.id}`}
          onClick={(e) => {
            if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
              e.preventDefault();
              actions.openLead(lead.id);
            }
          }}
          className="font-semibold text-[14px] text-slate-900 dark:text-white hover:text-indigo-600 dark:hover:text-indigo-400 truncate"
        >
          {lead.displayName}
        </a>
        {lead.doNotMessage && (
          <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[10.5px] font-bold text-rose-700 dark:bg-rose-950/70 dark:text-rose-300">
            Do not message
          </span>
        )}
        {lead.archivedAt && (
          <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[10.5px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            Archived
          </span>
        )}
      </div>

      {lead.email ? (
        <div className="flex items-center gap-1 min-w-0">
          <a href={`mailto:${lead.email}`} className="truncate text-[13px] text-indigo-600 dark:text-indigo-400 hover:underline" title={lead.email}>
            {lead.email}
          </a>
          <button type="button" className={iconBtn} aria-label="Copy email" title="Copy email" onClick={() => actions.copy(lead.email!, "Email")}>
            <IconCopy size={14} />
          </button>
        </div>
      ) : (
        <span className="text-[13px] text-slate-400 dark:text-slate-500">No email</span>
      )}

      {lead.primaryPhone ? (
        <div className="flex items-center gap-1 min-w-0">
          <span className="font-mono text-[13px] text-slate-700 dark:text-slate-300 truncate">{lead.primaryPhone}</span>
          <button type="button" className={iconBtn} aria-label="Copy phone" title="Copy phone" onClick={() => actions.copy(lead.primaryPhone!, "Phone")}>
            <IconCopy size={14} />
          </button>
          <a
            href={whatsappUrl(lead.primaryPhone)}
            target="_blank"
            rel="noopener noreferrer"
            className={`${iconBtn} !text-emerald-600 dark:!text-emerald-400`}
            aria-label={`Open WhatsApp chat with ${lead.displayName}`}
            title="Open in WhatsApp"
          >
            <IconWhatsApp size={16} />
          </a>
        </div>
      ) : (
        <span className="text-[13px] text-slate-400 dark:text-slate-500">No phone</span>
      )}

      {showToggles && <LeadToggles lead={lead} />}
    </div>
  );
}

export function LeadToggles({ lead }: { lead: LeadCard }) {
  const { actions } = useBoard();
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <Toggle
        label="Auto Follow-up"
        title="Let sequences and scheduled follow-ups send automatically"
        checked={!lead.automationPaused}
        onChange={(on) => void actions.patch(lead, { automationPaused: !on })}
      />
      <Toggle
        label="AI Reply"
        title="Let the AI draft or send replies to this lead"
        checked={lead.aiEnabled}
        onChange={(on) => void actions.patch(lead, { aiEnabled: on })}
      />
    </div>
  );
}

/* ---------- Additional info ---------- */

export function AdditionalCell({ lead }: { lead: LeadCard }) {
  const { actions } = useBoard();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(lead.company ?? "");
  const cancelled = useRef(false);

  const begin = () => {
    cancelled.current = false;
    setDraft(lead.company ?? "");
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (cancelled.current) return;
    const next = draft.trim();
    if (next !== (lead.company ?? "")) void actions.patch(lead, { company: next || null });
  };

  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      <div className="flex items-start gap-1">
        <span className="font-semibold text-slate-700 dark:text-slate-300 shrink-0 pt-px">Company:</span>
        {editing ? (
          <input
            type="text"
            autoFocus
            className="crm-ctl"
            value={draft}
            maxLength={200}
            aria-label="Company"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                cancelled.current = true;
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        ) : (
          <>
            <span className={`flex-1 min-w-0 truncate ${lead.company ? "text-slate-800 dark:text-slate-200" : "text-slate-400"}`} title={lead.company ?? ""}>
              {lead.company || "—"}
            </span>
            <button type="button" className={iconBtn} aria-label="Edit company" title="Edit company" onClick={begin}>
              <IconPencil size={14} />
            </button>
          </>
        )}
      </div>
      <div>
        <span className="font-semibold text-slate-700 dark:text-slate-300">Created:</span>{" "}
        <span className="text-slate-600 dark:text-slate-400" title={new Date(lead.createdAt).toLocaleString()}>
          {relativeDay(lead.createdAt)}
        </span>
      </div>
    </div>
  );
}

/* ---------- Notes ---------- */

export function NotesCell({ lead }: { lead: LeadCard }) {
  const { actions } = useBoard();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(lead.notes);
  const cancelled = useRef(false);

  const begin = () => {
    cancelled.current = false;
    setDraft(lead.notes);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (cancelled.current) return;
    if (draft !== lead.notes) void actions.patch(lead, { notes: draft });
  };

  if (editing) {
    return (
      <div>
        <textarea
          autoFocus
          rows={4}
          className="crm-ctl"
          value={draft}
          aria-label={`Notes for ${lead.displayName}`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
            if (e.key === "Escape") {
              cancelled.current = true;
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        <p className="mt-1 text-[11px] text-slate-400">Ctrl+Enter to save · Esc to cancel</p>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={begin}
      className="block w-full text-left rounded-md px-1.5 py-1 -mx-1.5 text-[13px] leading-relaxed hover:bg-slate-100 dark:hover:bg-slate-800/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      aria-label={lead.notes ? `Edit notes for ${lead.displayName}` : `Add a note for ${lead.displayName}`}
    >
      {lead.notes ? (
        <span className="whitespace-pre-wrap break-words text-slate-700 dark:text-slate-300 line-clamp-5">{lead.notes}</span>
      ) : (
        <span className="italic text-slate-400 dark:text-slate-500">Add a note…</span>
      )}
    </button>
  );
}

/* ---------- Sequence ---------- */

export function SequenceCell({ lead }: { lead: LeadCard }) {
  const { actions, sequences } = useBoard();
  const [busy, setBusy] = useState(false);
  const enabled = sequences.filter((s) => s.enabled);

  if (lead.enrollment) {
    const e = lead.enrollment;
    return (
      <div className="flex flex-col gap-1.5 text-[13px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12.5px] font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300">
            <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
            {e.sequenceName}
            <span className="font-normal text-emerald-700/80 dark:text-emerald-400/80">
              · step {e.stepNumber ?? "–"}/{e.totalSteps}
            </span>
          </span>
          <button
            type="button"
            disabled={busy}
            className="text-[12px] font-semibold text-rose-600 hover:underline dark:text-rose-400 disabled:opacity-50"
            onClick={async () => {
              if (!window.confirm(`Stop "${e.sequenceName}" for ${lead.displayName}?`)) return;
              setBusy(true);
              await actions.stopSequence(lead);
              setBusy(false);
            }}
          >
            Stop
          </button>
        </div>
        {lead.nextMessage && <NextMessage lead={lead} />}
        {lead.automationPaused && (
          <p className="text-[12px] text-amber-700 dark:text-amber-400">Auto follow-up is off — sends are paused.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <select
        className="crm-ctl max-w-[220px]"
        value=""
        disabled={busy || enabled.length === 0}
        aria-label={`Start a sequence for ${lead.displayName}`}
        onChange={async (ev) => {
          const id = ev.target.value;
          if (!id) return;
          setBusy(true);
          await actions.startSequence(lead, id);
          setBusy(false);
        }}
      >
        <option value="">{enabled.length === 0 ? "No sequences yet" : busy ? "Starting…" : "Start sequence…"}</option>
        {enabled.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.stepCount} step{s.stepCount === 1 ? "" : "s"})
          </option>
        ))}
      </select>
      {lead.nextMessage && <NextMessage lead={lead} />}
    </div>
  );
}

function NextMessage({ lead }: { lead: LeadCard }) {
  const m = lead.nextMessage!;
  return (
    <div className="text-[12.5px] leading-snug text-slate-600 dark:text-slate-400">
      <div>
        <span className="font-semibold text-slate-700 dark:text-slate-300">Next message:</span>{" "}
        <span title={m.body}>{truncate(m.body, 70)}</span>
      </div>
      <div>
        <span className="font-semibold text-slate-700 dark:text-slate-300">Scheduled:</span> {formatDue(m.dueAt)}
        {m.status === "needs_approval" && (
          <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-px text-[10.5px] font-bold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
            needs approval
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------- Scheduled message ---------- */

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleCell({ lead }: { lead: LeadCard }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex items-center gap-2">
      <button
        ref={btnRef}
        type="button"
        className="inline-flex items-center gap-1 text-[13px] font-semibold text-indigo-600 hover:underline dark:text-indigo-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        + Schedule
      </button>
      {lead.pendingScheduled > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-bold text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300"
          title={`${lead.pendingScheduled} scheduled message(s) waiting`}
        >
          <IconClock size={12} />
          {lead.pendingScheduled}
        </span>
      )}
      {open && <SchedulePopover lead={lead} anchor={btnRef} onClose={() => setOpen(false)} />}
    </div>
  );
}

function SchedulePopover({
  lead,
  anchor,
  onClose,
}: {
  lead: LeadCard;
  anchor: React.RefObject<HTMLButtonElement>;
  onClose: () => void;
}) {
  const { actions } = useBoard();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [body, setBody] = useState("");
  const [due, setDue] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const key = useRef(newIdempotencyKey());

  // Fixed-position next to the trigger so the table's scroll container can't clip it.
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(320, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    const below = r.bottom + 6;
    const top = below + 300 > window.innerHeight ? Math.max(12, r.top - 306) : below;
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        anchor.current?.focus();
      }
    };
    const onScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const when = new Date(due);
    if (!body.trim()) return setError("Write a message first.");
    if (isNaN(when.getTime()) || when.getTime() <= Date.now()) return setError("Pick a time in the future.");
    setSaving(true);
    const err = await actions.schedule(lead, body.trim(), when.toISOString(), key.current);
    setSaving(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Schedule a message to ${lead.displayName}`}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
      className="fixed z-[90] w-[min(320px,calc(100vw-24px))] rounded-xl border border-slate-200 bg-white p-3.5 shadow-xl dark:border-slate-700 dark:bg-slate-900 animate-scale-in"
    >
      <form onSubmit={submit} className="flex flex-col gap-2.5">
        <p className="m-0 text-[13px] font-bold text-slate-900 dark:text-white">Schedule a WhatsApp message</p>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-slate-600 dark:text-slate-300">
          Message
          <textarea
            autoFocus
            rows={3}
            className="crm-ctl"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Hi ${lead.displayName.split(" ")[0] ?? ""}, …`}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-slate-600 dark:text-slate-300">
          Send at
          <input
            type="datetime-local"
            className="crm-ctl w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            value={due}
            min={toLocalInput(new Date())}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        {error && <p className="m-0 text-[12px] font-medium text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-0.5">
          <button type="button" className="btn btn-secondary btn-xs" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-xs" disabled={saving}>
            {saving ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------- Days in stage ---------- */

export function DaysCell({ lead, compact }: { lead: LeadCard; compact?: boolean }) {
  const inStage = daysSince(lead.stageChangedAt);
  const inPipeline = daysSince(lead.createdAt);
  return (
    <div className={compact ? "flex items-baseline gap-2" : "flex flex-col items-center text-center"}>
      <span className="text-2xl font-extrabold leading-none tabular-nums text-slate-900 dark:text-white" title="Days in current stage">
        {inStage}
      </span>
      <span className="mt-1 text-[11.5px] text-slate-500 dark:text-slate-400">
        {compact ? `day${inStage === 1 ? "" : "s"} in stage · ` : ""}In pipeline: {inPipeline} day{inPipeline === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/* ---------- Actions ---------- */

export function MoveToSelect({ lead, className = "" }: { lead: LeadCard; className?: string }) {
  const { stages, actions } = useBoard();
  return (
    <select
      className={`crm-ctl ${className}`}
      value={lead.stageId}
      aria-label={`Move ${lead.displayName} to stage`}
      onChange={(e) => {
        if (e.target.value !== lead.stageId) void actions.patch(lead, { stageId: e.target.value });
      }}
    >
      {stages.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

export function ActionCell({ lead }: { lead: LeadCard }) {
  const { actions } = useBoard();
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        className={`${iconBtn} border border-slate-200 dark:border-slate-700`}
        aria-label={`Open ${lead.displayName}`}
        title="Open lead"
        onClick={() => actions.openLead(lead.id)}
      >
        <IconPencil size={14} />
      </button>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-slate-500 dark:text-slate-400 w-full">
        Move to
        <MoveToSelect lead={lead} className="min-w-[140px]" />
      </label>
    </div>
  );
}

/* ---------- Mobile card ---------- */

export function LeadMobileCard({ lead, extra }: { lead: LeadCard; extra?: ReactNode }) {
  const { selected } = useBoard();
  return (
    <article
      className={`rounded-xl border p-3.5 flex flex-col gap-3 ${
        selected.has(lead.id)
          ? "border-indigo-300 bg-indigo-50/60 dark:border-indigo-800 dark:bg-indigo-950/30"
          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      }`}
    >
      <div className="flex gap-3">
        <SelectCell lead={lead} />
        <div className="flex-1 min-w-0">
          {extra}
          <PersonalCell lead={lead} showToggles={false} />
        </div>
      </div>
      <DaysCell lead={lead} compact />
      <LeadToggles lead={lead} />
      <AdditionalCell lead={lead} />
      <div>
        <p className="m-0 mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Notes</p>
        <NotesCell lead={lead} />
      </div>
      <div>
        <p className="m-0 mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Auto follow-up sequence</p>
        <SequenceCell lead={lead} />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
        <ScheduleCell lead={lead} />
        <MoveToSelect lead={lead} className="!w-auto max-w-[55%]" />
      </div>
    </article>
  );
}
