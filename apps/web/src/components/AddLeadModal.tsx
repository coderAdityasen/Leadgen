import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../api.js";
import { errorText, type BoardStage } from "../crmBoard.js";

interface AddLeadModalProps {
  stages: BoardStage[];
  defaultStageId?: string | null;
  onClose: () => void;
  onCreated: (lead: { id: string; displayName: string }) => void;
}

const field = "flex flex-col gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300";

export function AddLeadModal({ stages, defaultStageId, onClose, onCreated }: AddLeadModalProps) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [stageId, setStageId] = useState(defaultStageId || stages[0]?.id || "");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!stageId && stages[0]) setStageId(stages[0].id);
  }, [stages, stageId]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiRequest<{ id: string; displayName: string }>("/api/v1/leads", {
        method: "POST",
        body: JSON.stringify({
          displayName: name.trim(),
          phoneE164: phone.trim() || undefined,
          email: email.trim() || undefined,
          company: company.trim() || undefined,
          stageId: stageId || undefined,
          notes: notes.trim(),
        }),
      });
      onCreated(res);
    } catch (err) {
      setError(errorText(err, "Could not create the lead."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-content max-h-[92vh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="add-lead-title">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="add-lead-title" className="m-0 text-xl font-bold text-slate-900 dark:text-white">
            Add new lead
          </h2>
          <button type="button" className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && (
          <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}

        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className={field}>
            Name *
            <input ref={firstRef} type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya Sharma" />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className={field}>
              Phone
              <input type="text" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 415 555 2671" />
            </label>
            <label className={field}>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            </label>
            <label className={field}>
              Company
              <input type="text" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company name" />
            </label>
            <label className={field}>
              Stage
              <select value={stageId} onChange={(e) => setStageId(e.target.value)}>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className={field}>
            Notes
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Where did this lead come from? What do they need?" />
          </label>
          <div className="flex justify-end gap-3 pt-1">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
              {submitting ? "Adding…" : "Add lead"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
