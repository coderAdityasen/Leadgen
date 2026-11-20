import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BillingState, Payment } from "../types.js";
import { STATE_BADGE, STATE_LABEL, formatDateTime, formatINR } from "../format.js";
import { IconCopy, IconWhatsApp } from "./icons.js";

export const fieldClass = "flex flex-col gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300";
export const cardClass =
  "card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm";

export function StateBadge({ state }: { state: BillingState }) {
  return <span className={`badge ${STATE_BADGE[state]}`}>{STATE_LABEL[state]}</span>;
}

export function PageLoading({ text = "Loading…" }: { text?: string }) {
  return (
    <div className="py-24 text-center text-slate-400 dark:text-slate-500">
      <div className="inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-2" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

export function ErrorBox({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm flex items-center justify-between gap-3"
    >
      <span>{children}</span>
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function NotAuthorized() {
  return (
    <div className="view-container animate-fade-in">
      <div className="empty-state">
        <h2 className="text-xl font-bold text-slate-900 dark:text-white m-0">Not authorized</h2>
        <p className="mt-2 mb-0">This area is only available to the Lead Desk administrator.</p>
      </div>
    </div>
  );
}

export function PaymentsTable({ payments }: { payments: Payment[] }) {
  if (payments.length === 0) {
    return <p className="text-sm text-slate-500 dark:text-slate-400 m-0">No payments yet.</p>;
  }
  return (
    <div className="table-responsive">
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Payment ID</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id}>
              <td className="whitespace-nowrap">{formatDateTime(p.paidAt)}</td>
              <td className="whitespace-nowrap font-semibold">{formatINR(p.amountPaise)}</td>
              <td>
                <span
                  className={`badge ${
                    p.status === "captured" ? "badge-success" : p.status === "failed" ? "badge-danger" : "badge-gray"
                  }`}
                >
                  {p.status}
                </span>
              </td>
              <td className="font-mono text-xs break-all">{p.razorpayPaymentId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Modal shell matching AddLeadModal (Esc + backdrop click close). */
export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal-content max-h-[92vh] overflow-y-auto ${wide ? "max-w-2xl" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="m-0 text-xl font-bold text-slate-900 dark:text-white">{title}</h2>
          <button
            type="button"
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="text-sm text-slate-600 dark:text-slate-300 space-y-2">{message}</div>
      <div className="flex justify-end gap-3 pt-5">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={`btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`}
          onClick={onConfirm}
          disabled={busy}
          autoFocus
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Login details the admin just created or reset, to hand to the person: copy them, or send them
 * on WhatsApp / by email. The password is shown only here; the server keeps only its hash.
 */
export function CredentialsPanel({
  email,
  password,
  recipientName,
  businessName,
  isReset = false,
}: {
  email: string;
  password: string;
  recipientName?: string;
  businessName?: string;
  isReset?: boolean;
}) {
  const [copied, setCopied] = useState<"email" | "password" | "all" | null>(null);
  const loginUrl = `${window.location.origin}/login`;
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";
  const what = isReset
    ? "your Lead Desk password has been reset"
    : businessName
      ? `your Lead Desk account for ${businessName} is ready`
      : "your Lead Desk account is ready";
  const message = `${greeting} ${what}.\n\nSign in: ${loginUrl}\nEmail: ${email}\nPassword: ${password}\n\nYou can change the password after signing in (Settings).`;
  const waHref = `https://wa.me/?text=${encodeURIComponent(message)}`;
  const mailHref = `mailto:${email}?subject=${encodeURIComponent("Your Lead Desk login")}&body=${encodeURIComponent(message)}`;

  const copy = async (what: "email" | "password" | "all", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      // clipboard blocked: the values stay selectable on screen
    }
  };

  const row = (label: string, value: string, key: "email" | "password") => (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs font-semibold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
        {label}
      </span>
      <input
        type="text"
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-sm"
        aria-label={label}
      />
      <button
        type="button"
        className="btn btn-secondary btn-sm shrink-0 inline-flex items-center gap-1.5"
        onClick={() => void copy(key, value)}
      >
        <IconCopy size={14} /> {copied === key ? "Copied" : "Copy"}
      </button>
    </div>
  );

  return (
    <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/30 p-4 space-y-3">
      <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
        {isReset ? "New login details" : "Login details"}: give these to {recipientName || "the client"}
      </div>
      {row("Email", email, "email")}
      {row("Password", password, "password")}
      <p className="text-xs text-amber-700 dark:text-amber-300 m-0">
        This password is shown only now. If it gets lost, reset it again.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy("all", message)}>
          {copied === "all" ? "Copied" : "Copy message"}
        </button>
        <a
          href={waHref}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-sm inline-flex items-center gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 border border-emerald-600"
        >
          <IconWhatsApp size={14} /> Send on WhatsApp
        </a>
        <a href={mailHref} className="btn btn-secondary btn-sm">
          Email
        </a>
      </div>
    </div>
  );
}
