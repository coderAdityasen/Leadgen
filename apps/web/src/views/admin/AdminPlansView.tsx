import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../api.js";
import { useSession } from "../../session.js";
import { apiErrorText, formatINR } from "../../format.js";
import type { Plan } from "../../types.js";
import { IconPencil, IconPlus } from "../../components/icons.js";
import { Toggle } from "../../components/Toggle.js";
import { useToasts, ToastStack } from "../../components/Toast.js";
import { ErrorBox, Modal, NotAuthorized, PageLoading, cardClass, fieldClass } from "../../components/BillingParts.js";

export function AdminPlansView() {
  const { me } = useSession();
  if (!me) return <PageLoading />;
  if (me.role !== "superadmin") return <NotAuthorized />;
  return <AdminPlans />;
}

function featuresFromText(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function AdminPlans() {
  const { toasts, push, dismiss } = useToasts();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [razorpayEnabled, setRazorpayEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<{ items: Plan[]; razorpayEnabled: boolean }>("/api/v1/admin/plans");
      setPlans([...res.items].sort((a, b) => a.position - b.position));
      setRazorpayEnabled(res.razorpayEnabled);
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "Could not load plans."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="view-container animate-fade-in space-y-6">
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <div className="view-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">Plans</h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1">
            Monthly plans clients can subscribe to. A plan's price cannot be changed — create a new plan and deactivate the old one.
          </p>
        </div>
        <button type="button" className="btn btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => setCreating(true)}>
          <IconPlus size={14} /> New plan
        </button>
      </div>

      {!razorpayEnabled && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200 text-sm">
          Razorpay is not configured, so new plans are not created in Razorpay automatically and clients cannot pay online yet.
        </div>
      )}

      {error && <ErrorBox onRetry={() => void load()}>{error}</ErrorBox>}

      {plans === null ? (
        !error && <PageLoading text="Loading plans…" />
      ) : plans.length === 0 ? (
        <div className="empty-state">No plans yet. Create the first one.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {plans.map((p) => (
            <div key={p.id} className={`${cardClass} p-6 flex flex-col gap-3 ${p.active ? "" : "opacity-70"}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white m-0">{p.name}</h3>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Position {p.position}</div>
                </div>
                <span className={`badge ${p.active ? "badge-success" : "badge-gray"}`}>{p.active ? "Active" : "Inactive"}</span>
              </div>
              <div>
                <span className="text-2xl font-extrabold text-slate-900 dark:text-white">{formatINR(p.pricePaise)}</span>
                <span className="text-sm text-slate-500 dark:text-slate-400"> /month</span>
              </div>
              {p.description && <p className="text-sm text-slate-600 dark:text-slate-300 m-0">{p.description}</p>}
              {p.features.length > 0 && (
                <ul className="text-sm text-slate-700 dark:text-slate-300 space-y-1 m-0 pl-5 list-disc">
                  {p.features.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Razorpay plan: <span className="font-mono break-all">{p.razorpayPlanId ?? "not linked"}</span>
              </div>
              <div className="mt-auto pt-2">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm inline-flex items-center gap-1.5"
                  onClick={() => setEditing(p)}
                >
                  <IconPencil size={14} /> Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <NewPlanModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            push("success", "Plan created.");
            void load();
          }}
        />
      )}
      {editing && (
        <EditPlanModal
          plan={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            push("success", "Plan saved.");
            void load();
          }}
        />
      )}
    </div>
  );
}

function FormError({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
      {text}
    </div>
  );
}

function NewPlanModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [features, setFeatures] = useState("");
  const [razorpayPlanId, setRazorpayPlanId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const rupees = Number(price);
    const pricePaise = Math.round(rupees * 100);
    if (!Number.isFinite(rupees) || pricePaise < 100) {
      setError("Price must be at least ₹1.");
      return;
    }
    setSaving(true);
    try {
      await apiRequest("/api/v1/admin/plans", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          pricePaise,
          features: featuresFromText(features),
          razorpayPlanId: razorpayPlanId.trim() || undefined,
        }),
      });
      onSaved();
    } catch (err) {
      setError(apiErrorText(err, "Could not create the plan."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New plan" onClose={onClose}>
      <FormError text={error} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={fieldClass}>
            Name *
            <input type="text" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Starter" />
          </label>
          <label className={fieldClass}>
            Monthly price (₹) *
            <input
              type="number"
              required
              min={1}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="499"
            />
          </label>
        </div>
        <label className={fieldClass}>
          Description
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className={fieldClass}>
          Features (one per line)
          <textarea rows={4} value={features} onChange={(e) => setFeatures(e.target.value)} placeholder={"Unlimited leads\nAI replies"} />
        </label>
        <label className={fieldClass}>
          Existing Razorpay plan ID (optional)
          <input
            type="text"
            className="font-mono"
            value={razorpayPlanId}
            onChange={(e) => setRazorpayPlanId(e.target.value)}
            placeholder="plan_XXXXXXXXXXXX"
          />
          <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
            Leave empty to create the monthly plan in Razorpay automatically. The price cannot be changed later.
          </span>
        </label>
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
            {saving ? "Creating…" : "Create plan"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditPlanModal({ plan, onClose, onSaved }: { plan: Plan; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description);
  const [features, setFeatures] = useState(plan.features.join("\n"));
  const [active, setActive] = useState(plan.active);
  const [position, setPosition] = useState(plan.position);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!Number.isInteger(position)) {
      setError("Position must be a whole number.");
      return;
    }
    setSaving(true);
    try {
      await apiRequest(`/api/v1/admin/plans/${encodeURIComponent(plan.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          features: featuresFromText(features),
          active,
          position,
        }),
      });
      onSaved();
    } catch (err) {
      setError(apiErrorText(err, "Could not save the plan."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Edit ${plan.name}`} onClose={onClose}>
      <FormError text={error} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={fieldClass}>
            Name *
            <input type="text" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className={fieldClass}>
            Position
            <input type="number" step={1} value={position} onChange={(e) => setPosition(Number(e.target.value))} />
          </label>
        </div>
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-3 text-sm text-slate-600 dark:text-slate-300">
          Price: <strong>{formatINR(plan.pricePaise)}/month</strong> — fixed. To change the price, create a new plan and deactivate
          this one.
        </div>
        <label className={fieldClass}>
          Description
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className={fieldClass}>
          Features (one per line)
          <textarea rows={4} value={features} onChange={(e) => setFeatures(e.target.value)} />
        </label>
        <Toggle label="Active (shown to clients)" checked={active} onChange={setActive} />
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
