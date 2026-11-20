import type { ActiveChatInfo, CrmLeadCard, CrmSequenceBrief, CrmStage } from "@leaddesk/shared";
import type { OverlayPrefs } from "./api.js";

export type BridgeStatus = "waiting" | "ready" | "foreign";

export interface ContactView {
  key: string;
  lead: CrmLeadCard | null;
  stages: CrmStage[];
  sequences: CrmSequenceBrief[];
}

export interface OverlayState {
  dark: boolean;
  prefs: OverlayPrefs;
  bridge: BridgeStatus;
  /** null until the worker has answered the first status call */
  paired: boolean | null;
  serverOrigin: string | null;
  stages: CrmStage[];
  boardLoading: boolean;
  boardError: string | null;
  chat: ActiveChatInfo | null;
  contact: ContactView | null;
  contactError: string | null;
  panelError: string | null;
  /** label of the mutation in flight, if any */
  busy: string | null;
  savingField: string | null;
  savedField: string | null;
  confirmStop: boolean;
  selectedSequenceId: string;
  createName: string;
  createStageId: string;
}

export interface PanelActions {
  togglePanel(): void;
  retry(): void;
  dismissError(): void;
  createLead(): void;
  setCreateName(value: string): void;
  setCreateStage(stageId: string): void;
  patchLead(patch: Record<string, unknown>, field?: string): void;
  enroll(): void;
  selectSequence(sequenceId: string): void;
  cancelEnrollment(): void;
  setConfirmStop(on: boolean): void;
  copy(text: string): void;
}

/** Stable identity of the open chat; the panel only shows data loaded for the same key. */
export function contactKey(chat: ActiveChatInfo | null): string {
  if (!chat?.chatJid || chat.kind !== "direct") return "";
  return `${chat.chatJid}|${chat.lid ?? ""}|${chat.phoneUser ?? ""}`;
}
