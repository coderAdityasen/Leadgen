import { useEffect, useRef, useState } from "react";
import { IconFilter } from "./icons.js";

export type TriState = "any" | "yes" | "no";

export interface BoardFilters {
  ai: TriState;
  auto: TriState;
  inSequence: TriState;
  doNotMessage: TriState;
  includeArchived: boolean;
}

export const DEFAULT_FILTERS: BoardFilters = {
  ai: "any",
  auto: "any",
  inSequence: "any",
  doNotMessage: "any",
  includeArchived: false,
};

export function activeFilterCount(f: BoardFilters): number {
  return (
    (f.ai !== "any" ? 1 : 0) +
    (f.auto !== "any" ? 1 : 0) +
    (f.inSequence !== "any" ? 1 : 0) +
    (f.doNotMessage !== "any" ? 1 : 0) +
    (f.includeArchived ? 1 : 0)
  );
}

const ROWS: { key: Exclude<keyof BoardFilters, "includeArchived">; label: string; yes: string; no: string }[] = [
  { key: "ai", label: "AI reply", yes: "On", no: "Off" },
  { key: "auto", label: "Auto follow-up", yes: "On", no: "Off" },
  { key: "inSequence", label: "In a sequence", yes: "Yes", no: "No" },
  { key: "doNotMessage", label: "Do not message", yes: "Yes", no: "No" },
];

export function FilterPopover({ value, onChange }: { value: BoardFilters; onChange: (next: BoardFilters) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const count = activeFilterCount(value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`btn btn-secondary btn-sm !rounded-full ${count ? "!border-indigo-300 !text-indigo-700 dark:!border-indigo-700 dark:!text-indigo-300" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IconFilter size={15} />
        Filter
        {count > 0 && (
          <span className="ml-0.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-indigo-600 px-1.5 text-[11px] font-bold text-white">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter leads"
          className="absolute left-0 sm:left-auto sm:right-0 top-full z-50 mt-2 w-[min(300px,calc(100vw-32px))] rounded-xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900 animate-scale-in"
        >
          <div className="flex flex-col gap-3">
            {ROWS.map((row) => (
              <fieldset key={row.key} className="m-0 border-0 p-0">
                <legend className="mb-1.5 p-0 text-[12px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{row.label}</legend>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                  {(["any", "yes", "no"] as const).map((opt) => {
                    const on = value[row.key] === opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onChange({ ...value, [row.key]: opt })}
                        className={`rounded-md py-1 text-[12.5px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                          on
                            ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white"
                            : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                        }`}
                      >
                        {opt === "any" ? "Any" : opt === "yes" ? row.yes : row.no}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                checked={value.includeArchived}
                onChange={(e) => onChange({ ...value, includeArchived: e.target.checked })}
              />
              Include archived leads
            </label>
            <div className="flex justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
              <button
                type="button"
                className="text-sm font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-40"
                disabled={count === 0}
                onClick={() => onChange({ ...DEFAULT_FILTERS })}
              >
                Reset
              </button>
              <button type="button" className="btn btn-primary btn-xs" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
