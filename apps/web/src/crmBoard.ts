/**
 * Shared types and helpers for the CRM stage board (Leads page).
 * Shapes mirror apps/server/src/crm.ts (GET /api/v1/leads/board).
 */
import { createContext, useContext, useEffect, useState } from "react";

export interface BoardStage {
  id: string;
  name: string;
  position: number;
  count: number;
}

export interface LeadCard {
  id: string;
  displayName: string;
  email: string | null;
  company: string | null;
  notes: string;
  stageId: string;
  stageName: string;
  aiEnabled: boolean;
  requireApproval: boolean;
  automationPaused: boolean;
  doNotMessage: boolean;
  archivedAt: string | null;
  primaryPhone: string | null;
  waJid: string | null;
  waLid: string | null;
  createdAt: string;
  updatedAt: string;
  stageChangedAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  enrollment: {
    id: string;
    sequenceId: string;
    sequenceName: string;
    stepNumber: number | null;
    totalSteps: number;
  } | null;
  nextMessage: {
    outboundId: string;
    kind: string;
    body: string;
    dueAt: string;
    status: string;
  } | null;
  pendingScheduled: number;
}

export interface BoardResponse {
  stages: BoardStage[];
  items: LeadCard[];
  truncated: boolean;
}

export interface SequenceBrief {
  id: string;
  name: string;
  enabled: boolean;
  stepCount: number;
}

export type LeadPatch = Partial<
  Pick<
    LeadCard,
    "displayName" | "notes" | "stageId" | "aiEnabled" | "requireApproval" | "automationPaused" | "doNotMessage" | "email" | "company"
  >
>;

/* ---------- Stage colours ---------- */

export interface StageColor {
  solid: string; // pipeline segment background (white text on top)
  tint: string; // group header background
  border: string; // group card border
  text: string; // coloured text on tint
  dot: string; // small swatch
  badge: string; // pill used in the flat table
}

// Full class strings so Tailwind's JIT picks them up.
export const STAGE_PALETTE: StageColor[] = [
  {
    solid: "bg-sky-600 dark:bg-sky-700",
    tint: "bg-sky-50 dark:bg-sky-950/40",
    border: "border-sky-200 dark:border-sky-900/70",
    text: "text-sky-800 dark:text-sky-200",
    dot: "bg-sky-500",
    badge: "bg-sky-100 text-sky-800 dark:bg-sky-950/70 dark:text-sky-200",
  },
  {
    solid: "bg-indigo-600 dark:bg-indigo-700",
    tint: "bg-indigo-50 dark:bg-indigo-950/40",
    border: "border-indigo-200 dark:border-indigo-900/70",
    text: "text-indigo-800 dark:text-indigo-200",
    dot: "bg-indigo-500",
    badge: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-200",
  },
  {
    solid: "bg-violet-600 dark:bg-violet-700",
    tint: "bg-violet-50 dark:bg-violet-950/40",
    border: "border-violet-200 dark:border-violet-900/70",
    text: "text-violet-800 dark:text-violet-200",
    dot: "bg-violet-500",
    badge: "bg-violet-100 text-violet-800 dark:bg-violet-950/70 dark:text-violet-200",
  },
  {
    solid: "bg-amber-600 dark:bg-amber-700",
    tint: "bg-amber-50 dark:bg-amber-950/40",
    border: "border-amber-200 dark:border-amber-900/70",
    text: "text-amber-800 dark:text-amber-200",
    dot: "bg-amber-500",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-200",
  },
  {
    solid: "bg-emerald-600 dark:bg-emerald-700",
    tint: "bg-emerald-50 dark:bg-emerald-950/40",
    border: "border-emerald-200 dark:border-emerald-900/70",
    text: "text-emerald-800 dark:text-emerald-200",
    dot: "bg-emerald-500",
    badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-200",
  },
  {
    solid: "bg-rose-600 dark:bg-rose-700",
    tint: "bg-rose-50 dark:bg-rose-950/40",
    border: "border-rose-200 dark:border-rose-900/70",
    text: "text-rose-800 dark:text-rose-200",
    dot: "bg-rose-500",
    badge: "bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-200",
  },
  {
    solid: "bg-teal-600 dark:bg-teal-700",
    tint: "bg-teal-50 dark:bg-teal-950/40",
    border: "border-teal-200 dark:border-teal-900/70",
    text: "text-teal-800 dark:text-teal-200",
    dot: "bg-teal-500",
    badge: "bg-teal-100 text-teal-800 dark:bg-teal-950/70 dark:text-teal-200",
  },
  {
    solid: "bg-slate-600 dark:bg-slate-700",
    tint: "bg-slate-100 dark:bg-slate-800/60",
    border: "border-slate-200 dark:border-slate-700",
    text: "text-slate-800 dark:text-slate-200",
    dot: "bg-slate-500",
    badge: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  },
];

export function stageColorAt(index: number): StageColor {
  return STAGE_PALETTE[((index % STAGE_PALETTE.length) + STAGE_PALETTE.length) % STAGE_PALETTE.length]!;
}

/* ---------- Formatting ---------- */

const DAY = 86_400_000;

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function relativeDay(isoDate: string): string {
  const t = new Date(isoDate);
  if (isNaN(t.getTime())) return "—";
  const diff = Math.round((startOfDay(new Date()) - startOfDay(t)) / DAY);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 30) return `${diff} days ago`;
  return t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function daysSince(isoDate: string | null | undefined): number {
  if (!isoDate) return 0;
  const t = new Date(isoDate).getTime();
  if (isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

export function formatDue(isoDate: string): string {
  const t = new Date(isoDate);
  if (isNaN(t.getTime())) return "—";
  return t.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function shortId(id: string): string {
  return id.slice(-6).toUpperCase();
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function whatsappUrl(phone: string): string {
  return `https://web.whatsapp.com/send?phone=${phone.replace(/\D/g, "")}`;
}

export function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const FRIENDLY: Record<string, string> = {
  country_required: "Add the country code to the phone (e.g. +44…), or set a default country in Settings.",
  conflict: "A lead with this phone number already exists.",
  no_phone: "This lead has no phone number yet.",
  do_not_message: "This lead is marked Do not message.",
  already_enrolled: "This lead is already in a sequence.",
  no_steps: "That sequence has no steps yet.",
  archived: "This lead is archived.",
};

/** Turn an ApiError (thrown by apiRequest) into readable text. */
export function errorText(err: unknown, fallback = "Something went wrong."): string {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return fallback;
  if (e.code === "conflict" && e.message && !/phone/i.test(e.message)) return e.message;
  if (e.code && FRIENDLY[e.code]) return FRIENDLY[e.code]!;
  return e.message || fallback;
}

/* ---------- Hooks ---------- */

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/* ---------- Board context (actions + lookup data shared by cells) ---------- */

export interface BoardActions {
  patch: (lead: LeadCard, changes: LeadPatch) => Promise<boolean>;
  startSequence: (lead: LeadCard, sequenceId: string) => Promise<void>;
  stopSequence: (lead: LeadCard) => Promise<void>;
  schedule: (lead: LeadCard, body: string, dueAtIso: string, idempotencyKey: string) => Promise<string | null>;
  copy: (text: string, label: string) => void;
  openLead: (id: string) => void;
}

export interface BoardContextValue {
  stages: BoardStage[];
  sequences: SequenceBrief[];
  colorFor: (stageId: string) => StageColor;
  actions: BoardActions;
  selected: Set<string>;
  toggleSelected: (id: string) => void;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("useBoard must be used inside BoardContext");
  return ctx;
}
