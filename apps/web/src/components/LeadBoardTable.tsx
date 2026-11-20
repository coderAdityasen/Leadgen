import { useMemo, useState, type ReactNode } from "react";
import { daysSince, useBoard, type LeadCard } from "../crmBoard.js";
import {
  ActionCell,
  AdditionalCell,
  DaysCell,
  NotesCell,
  PersonalCell,
  ScheduleCell,
  SelectCell,
  SequenceCell,
} from "./LeadCells.js";
import { IconChevronDown, IconChevronUp } from "./icons.js";

export type SortKey = "name" | "stage" | "created" | "days";
export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

interface LeadBoardTableProps {
  leads: LeadCard[];
  /** "stage": per-stage group table (all columns). "flat": table view with stage badge + sortable headers. */
  mode: "stage" | "flat";
  /** Header checkbox for the flat table. */
  headerSelect?: ReactNode;
}

const th =
  "px-3 py-2.5 text-center text-[12px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800 whitespace-nowrap";
const td = "px-3 py-3 align-top border-b border-slate-100 dark:border-slate-800/80";

export function LeadBoardTable({ leads, mode, headerSelect }: LeadBoardTableProps) {
  const { stages, colorFor, selected } = useBoard();
  const [sort, setSort] = useState<SortState>({ key: "created", dir: "desc" });

  const stagePos = useMemo(() => new Map(stages.map((s) => [s.id, s.position])), [stages]);

  const rows = useMemo(() => {
    if (mode !== "flat") return leads;
    const sign = sort.dir === "asc" ? 1 : -1;
    const copy = [...leads];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sort.key) {
        case "name":
          cmp = a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
          break;
        case "stage":
          cmp = (stagePos.get(a.stageId) ?? 0) - (stagePos.get(b.stageId) ?? 0);
          break;
        case "created":
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case "days":
          cmp = daysSince(a.stageChangedAt) - daysSince(b.stageChangedAt);
          break;
      }
      return cmp * sign || a.id.localeCompare(b.id);
    });
    return copy;
  }, [leads, mode, sort, stagePos]);

  const sortHeader = (key: SortKey, label: string, extra = "") => {
    const active = sort.key === key;
    return (
      <th className={`${th} ${extra}`} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          className="inline-flex items-center gap-1 uppercase tracking-wide font-bold hover:text-slate-800 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
          onClick={() =>
            setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" || key === "stage" ? "asc" : "desc" }))
          }
        >
          {label}
          <span className={active ? "opacity-100" : "opacity-30"}>
            {active && sort.dir === "asc" ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
          </span>
        </button>
      </th>
    );
  };

  const flat = mode === "flat";
  const stickyBg = (isSel: boolean) =>
    isSel ? "bg-indigo-50 dark:bg-[#1a1d3a]" : "bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-[#151c2c]";

  return (
    <div className="overflow-x-auto crm-scroll">
      <table className={`w-full table-fixed border-separate border-spacing-0 text-left ${flat ? "min-w-[1586px]" : "min-w-[1596px]"}`}>
        <colgroup>
          <col style={{ width: 76 }} />
          <col style={{ width: 270 }} />
          {flat && <col style={{ width: 140 }} />}
          <col style={{ width: 230 }} />
          <col style={{ width: 260 }} />
          <col style={{ width: 300 }} />
          {!flat && <col style={{ width: 150 }} />}
          <col style={{ width: 130 }} />
          <col style={{ width: 180 }} />
        </colgroup>
        <thead>
          <tr>
            <th className={`${th} sticky left-0 z-20 w-[76px] min-w-[76px]`}>{headerSelect ?? "ID"}</th>
            {flat ? sortHeader("name", "Personal details", "text-left lg:sticky lg:left-[76px] z-20") : (
              <th className={`${th} lg:sticky lg:left-[76px] z-20 min-w-[250px]`}>Personal Details</th>
            )}
            {flat && sortHeader("stage", "Stage")}
            {flat ? sortHeader("created", "Company · Created") : <th className={th}>Additional Info</th>}
            <th className={`${th} min-w-[220px]`}>Notes</th>
            <th className={`${th} min-w-[260px]`}>Auto Follow-up Sequence</th>
            {!flat && <th className={`${th} min-w-[140px]`}>Scheduled</th>}
            {flat ? sortHeader("days", "Days in stage") : <th className={th}>Days in Stage</th>}
            <th className={`${th} min-w-[160px]`}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((lead) => {
            const isSel = selected.has(lead.id);
            const rowBg = isSel ? "bg-indigo-50/70 dark:bg-indigo-950/30" : "group-hover:bg-slate-50/80 dark:group-hover:bg-slate-800/30";
            const color = colorFor(lead.stageId);
            return (
              <tr key={lead.id} className="group">
                <td className={`${td} sticky left-0 z-10 ${stickyBg(isSel)}`}>
                  <SelectCell lead={lead} />
                </td>
                <td className={`${td} lg:sticky lg:left-[76px] z-10 w-[260px] min-w-[250px] max-w-[280px] ${stickyBg(isSel)} lg:shadow-[1px_0_0_0_rgba(148,163,184,0.25)]`}>
                  <PersonalCell lead={lead} />
                </td>
                {flat && (
                  <td className={`${td} ${rowBg} whitespace-nowrap`}>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold ${color.badge}`}>
                      <span className={`h-2 w-2 rounded-full ${color.dot}`} aria-hidden />
                      {lead.stageName}
                    </span>
                  </td>
                )}
                <td className={`${td} ${rowBg} min-w-[200px] max-w-[240px]`}>
                  <AdditionalCell lead={lead} />
                </td>
                <td className={`${td} ${rowBg} max-w-[300px]`}>
                  <NotesCell lead={lead} />
                </td>
                <td className={`${td} ${rowBg} max-w-[320px]`}>
                  <SequenceCell lead={lead} />
                </td>
                {!flat && (
                  <td className={`${td} ${rowBg}`}>
                    <ScheduleCell lead={lead} />
                  </td>
                )}
                <td className={`${td} ${rowBg} min-w-[120px]`}>
                  <DaysCell lead={lead} />
                </td>
                <td className={`${td} ${rowBg}`}>
                  <ActionCell lead={lead} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
