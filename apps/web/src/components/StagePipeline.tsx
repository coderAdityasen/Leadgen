import type { BoardStage, StageColor } from "../crmBoard.js";
import { IconPencil } from "./icons.js";

interface StagePipelineProps {
  stages: BoardStage[];
  counts: Record<string, number>;
  colorFor: (stageId: string) => StageColor;
  activeStageId: string | null;
  onSelect: (stageId: string) => void;
  onEdit: () => void;
  loading?: boolean;
}

/** Arrow-shaped pipeline bar: one segment per stage, click to filter. */
export function StagePipeline({ stages, counts, colorFor, activeStageId, onSelect, onEdit, loading }: StagePipelineProps) {
  if (loading) {
    return (
      <div className="flex gap-2" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-[68px] flex-1 min-w-[110px] rounded-lg bg-slate-200 dark:bg-slate-800 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-stretch gap-3 min-w-0">
      <nav aria-label="Pipeline stages" className="flex-1 min-w-0 overflow-x-auto crm-scroll pb-1">
        <ol className="flex min-w-max sm:min-w-0 list-none m-0 p-0">
          {stages.map((stage, i) => {
            const color = colorFor(stage.id);
            const active = activeStageId === stage.id;
            return (
              <li key={stage.id} className={`flex-1 min-w-[124px] ${i > 0 ? "-ml-2.5" : ""}`}>
                <button
                  type="button"
                  onClick={() => onSelect(stage.id)}
                  aria-pressed={active}
                  title={`Open ${stage.name}`}
                  className={`${i === 0 ? "crm-chevron-first pl-4" : "crm-chevron pl-7"} ${color.solid} group relative w-full h-[68px] pr-6 text-left text-white transition-[filter,box-shadow] focus:outline-none focus-visible:brightness-125 hover:brightness-110 ${
                    active ? "brightness-110 shadow-[inset_0_-4px_0_rgba(255,255,255,0.85)]" : ""
                  }`}
                >
                  <span className="block text-2xl font-extrabold leading-none tabular-nums">{counts[stage.id] ?? 0}</span>
                  <span
                    className={`mt-1.5 block truncate text-[13px] font-semibold leading-tight ${
                      active ? "underline decoration-2 underline-offset-4" : ""
                    }`}
                  >
                    {stage.name}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <button
        type="button"
        onClick={onEdit}
        className="btn btn-secondary btn-sm self-center shrink-0"
        aria-label="Edit pipeline stages"
      >
        <IconPencil size={14} />
        <span className="hidden sm:inline">Edit</span>
      </button>
    </div>
  );
}
