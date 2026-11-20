// --- WhatsApp CRM overlay <-> service worker (chrome.runtime) ---
// The content script never sees the device token: it sends a CrmRequest, the worker adds
// the bearer header, calls /api/v1/extension/crm/*, and answers with a CrmResponse.

export type CrmOp = "board" | "contact" | "createLead" | "updateLead" | "enroll" | "cancelEnrollment";

export const CRM_OPS: readonly CrmOp[] = [
  "board",
  "contact",
  "createLead",
  "updateLead",
  "enroll",
  "cancelEnrollment",
] as const;

export type CrmRequest = { op: CrmOp; params?: Record<string, unknown> };

export type CrmError = { code: string; message?: string };

export type CrmResponse<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: CrmError };

export type CrmStatus = { paired: boolean; serverOrigin: string | null };

export interface CrmStage {
  id: string;
  name: string;
  position: number;
  count: number;
}

export interface CrmSequenceBrief {
  id: string;
  name: string;
  enabled: boolean;
  stepCount: number;
}

export interface CrmLeadCard {
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

export type CrmBoard = { stages: CrmStage[]; items: CrmLeadCard[]; truncated: boolean };
export type CrmContact = { lead: CrmLeadCard | null; stages: CrmStage[]; sequences: CrmSequenceBrief[] };
