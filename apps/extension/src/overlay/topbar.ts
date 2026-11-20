import type { CrmLeadCard } from "@leaddesk/shared";
import { h, icon, type Child } from "./dom.js";
import { stageColor } from "./panel.js";
import type { OverlayState } from "./types.js";

export interface BarActions {
  /** null = "All chats" (WhatsApp's own list) */
  selectStage(stageId: string | null): void;
  refresh(): void;
  minimize(): void;
}

function barStatus(s: OverlayState): { text: string; err: boolean } | null {
  if (s.bridge === "foreign") return { text: "Off in this tab (another WhatsApp tool is running)", err: true };
  if (s.paired === false) return { text: "Not paired · open the Lead Desk popup", err: true };
  if (s.boardError) return { text: s.boardError, err: true };
  if (s.bridge === "waiting") return { text: "Waiting for WhatsApp…", err: false };
  return null;
}

/** Status text the overlay wants in the bar for the selected stage, with at most one action. */
export interface BarNote {
  text: string;
  err?: boolean;
  action?: { label: string; title?: string; run: () => void };
}

export function renderBar(s: OverlayState, a: BarActions, activeStageId: string | null, note: BarNote | null = null): Child[] {
  const total = s.stages.reduce((sum, st) => sum + (Number(st.count) || 0), 0);
  const all = h(
    "button",
    {
      class: `stage all${activeStageId === null ? " active" : ""}`,
      title: "All chats (WhatsApp's normal list)",
      "aria-pressed": activeStageId === null ? "true" : "false",
      onClick: () => a.selectStage(null),
    },
    h("span", { class: "count" }, s.stages.length ? total : "–"),
    h("span", { class: "name" }, "All chats")
  );
  const segments = s.stages.map((stage) =>
    h(
      "button",
      {
        class: `stage${stage.id === activeStageId ? " active" : ""}`,
        style: `background:${stageColor(s.stages, stage.id)}`,
        title: `Show only ${stage.name} (${stage.count} lead${stage.count === 1 ? "" : "s"}) in the chat list`,
        "aria-pressed": stage.id === activeStageId ? "true" : "false",
        onClick: () => a.selectStage(stage.id),
      },
      h("span", { class: "count" }, stage.count),
      h("span", { class: "name" }, stage.name)
    )
  );
  const status: BarNote | null = barStatus(s) ?? note;
  return [
    h("div", { class: "mark", title: "Lead Desk" }, h("span", { class: "mark-logo" }, "LD"), h("span", null, "Lead Desk")),
    h("div", { class: "stages", role: "toolbar", "aria-label": "Filter chats by lead stage" }, all, segments),
    status ? h("span", { class: `bar-status${status.err ? " err" : ""}`, title: status.text }, status.text) : null,
    status?.action
      ? h("button", { class: "bar-action", title: status.action.title ?? status.action.label, onClick: status.action.run }, status.action.label)
      : null,
    h(
      "button",
      {
        class: `icon-btn${s.boardLoading ? " spin" : ""}`,
        title: "Refresh",
        "aria-label": "Refresh",
        disabled: s.paired !== true,
        onClick: a.refresh,
      },
      icon("refresh")
    ),
    h("button", { class: "icon-btn", title: "Hide Lead Desk bar", "aria-label": "Hide Lead Desk bar", onClick: a.minimize }, icon("chevronUp")),
  ];
}

/** WhatsApp id to open for a lead card: lid first (how WhatsApp keys chats now), then jid, then phone. */
export function leadChatJid(lead: CrmLeadCard): string | null {
  if (lead.waLid) return lead.waLid;
  if (lead.waJid) return lead.waJid;
  const digits = (lead.primaryPhone ?? "").replace(/\D/g, "");
  return digits ? `${digits}@c.us` : null;
}

/** Every id WhatsApp might key this lead's chat by. */
export function leadChatJids(lead: CrmLeadCard): string[] {
  const out: string[] = [];
  const digits = (lead.primaryPhone ?? "").replace(/\D/g, "");
  for (const jid of [lead.waLid, lead.waJid, digits ? `${digits}@c.us` : null]) {
    if (jid && !out.includes(jid)) out.push(jid);
  }
  return out;
}
