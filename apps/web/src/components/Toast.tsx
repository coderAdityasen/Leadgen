import { useCallback, useRef, useState } from "react";

export interface ToastItem {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastItem["kind"], text: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
      window.setTimeout(() => dismiss(id), kind === "error" ? 6000 : 2600);
    },
    [dismiss]
  );

  return { toasts, push, dismiss };
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div
      className="fixed top-4 right-4 left-4 sm:left-auto z-[120] flex flex-col items-end gap-2 pointer-events-none"
      aria-live="polite"
      role="status"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto w-full sm:w-auto sm:max-w-sm flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg animate-slide-down ${
            t.kind === "error"
              ? "bg-rose-50 border-rose-200 text-rose-800 dark:bg-rose-950/90 dark:border-rose-900 dark:text-rose-200"
              : t.kind === "success"
                ? "bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/90 dark:border-emerald-900 dark:text-emerald-200"
                : "bg-white border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200"
          }`}
        >
          <span className="flex-1">{t.text}</span>
          <button
            type="button"
            className="opacity-60 hover:opacity-100 text-xs font-bold"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
