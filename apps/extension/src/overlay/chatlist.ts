/**
 * Stage-filtered chat list. It sits exactly over WhatsApp's own chat column (#side) while a
 * stage chevron is selected, looks like WhatsApp's list, and opens chats the normal way
 * (the conversation shows on the right). "All chats" removes it and WhatsApp's list is back.
 */
import type { ChatSummary, CrmLeadCard, CrmStage } from "@leaddesk/shared";
import { h, icon, type Child } from "./dom.js";
import { leadChatJid } from "./topbar.js";

export interface ChatListView {
  stage: CrmStage;
  color: string;
  q: string;
  items: CrmLeadCard[] | null;
  summaries: Map<string, ChatSummary>;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  /** lead id whose chat is open on the right */
  activeLeadId: string | null;
  openingLeadId: string | null;
  /** WhatsApp's own list can be filtered in this tab */
  canUseNative: boolean;
}

export interface ChatListActions {
  close(): void;
  search(q: string): void;
  open(lead: CrmLeadCard): void;
  dismissError(): void;
  /** go back to filtering WhatsApp's own list */
  nativeView(): void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function isoMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Last activity for sorting and the time column: WhatsApp's own value wins over ours. */
export function lastActivity(lead: CrmLeadCard, summary: ChatSummary | undefined): number {
  if (summary?.lastAt) return summary.lastAt;
  return Math.max(isoMs(lead.lastInboundAt), isoMs(lead.lastOutboundAt));
}

/** WhatsApp-style time: 14:05 today, Yesterday, weekday this week, else a date. */
function chatTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startOfDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (ms >= startOfDay - 86_400_000) return "Yesterday";
  if (ms >= startOfDay - 6 * 86_400_000) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString();
}

function avatar(lead: CrmLeadCard, summary: ChatSummary | undefined, color: string): HTMLElement {
  const fallback = h("span", { class: "cl-avatar", style: `background:${color}` }, initials(lead.displayName || "?"));
  if (!summary?.picUrl) return fallback;
  const img = h("img", { class: "cl-avatar", alt: "", referrerPolicy: "no-referrer", src: summary.picUrl });
  img.addEventListener("error", () => img.replaceWith(fallback), { once: true });
  return img;
}

function row(lead: CrmLeadCard, v: ChatListView, a: ChatListActions): HTMLElement {
  const summary = v.summaries.get(lead.id);
  const canOpen = Boolean(leadChatJid(lead));
  const when = lastActivity(lead, summary);
  let preview: Child[];
  if (summary?.lastBody) {
    preview = [summary.lastFromMe ? h("span", { class: "cl-me" }, "You: ") : null, summary.lastBody];
  } else {
    const bits = [lead.primaryPhone, lead.enrollment ? `Sequence: ${lead.enrollment.sequenceName}` : null].filter(Boolean);
    preview = [bits.join(" · ") || (canOpen ? "" : "No WhatsApp number")];
  }
  const tags: Child[] = [];
  if (lead.doNotMessage) tags.push(h("span", { class: "cl-tag danger" }, "Do not message"));
  else if (lead.enrollment) tags.push(h("span", { class: "cl-tag" }, `Step ${lead.enrollment.stepNumber ?? "–"}/${lead.enrollment.totalSteps}`));
  if (lead.aiEnabled && !lead.doNotMessage) tags.push(h("span", { class: "cl-tag" }, "AI"));

  const classes = ["cl-row"];
  if (v.activeLeadId === lead.id) classes.push("active");
  if (v.openingLeadId === lead.id) classes.push("opening");
  return h(
    "button",
    {
      class: classes.join(" "),
      disabled: !canOpen,
      title: canOpen ? `Open chat with ${lead.displayName}` : "This lead has no WhatsApp number",
      onClick: () => a.open(lead),
    },
    avatar(lead, summary, v.color),
    h(
      "span",
      { class: "cl-main" },
      h(
        "span",
        { class: "cl-top" },
        h("span", { class: "cl-name" }, lead.displayName || lead.primaryPhone || "Unnamed lead"),
        h("span", { class: `cl-time${summary?.unread ? " unread" : ""}` }, chatTime(when))
      ),
      h(
        "span",
        { class: "cl-bottom" },
        h("span", { class: "cl-preview" }, preview),
        tags,
        summary?.unread
          ? summary.unread < 0
            ? h("span", { class: "cl-unread dot", title: "Marked as unread" })
            : h("span", { class: "cl-unread" }, summary.unread > 99 ? "99+" : summary.unread)
          : null
      )
    )
  );
}

export function renderChatListHead(v: ChatListView, a: ChatListActions, input: HTMLInputElement): Child[] {
  return [
    h(
      "div",
      { class: "cl-head" },
      h("span", { class: "cl-swatch", style: `background:${v.color}` }),
      h("span", { class: "cl-title" }, v.stage.name),
      h("span", { class: "cl-count" }, `${v.items?.length ?? v.stage.count} lead${(v.items?.length ?? v.stage.count) === 1 ? "" : "s"}`),
      v.canUseNative
        ? h("button", { class: "cl-back", title: "Show this stage in WhatsApp's own chat list", onClick: a.nativeView }, "Chat view")
        : null,
      h(
        "button",
        { class: "cl-back", title: "Back to all chats", onClick: a.close },
        "All chats",
        icon("close", 14)
      )
    ),
    h("div", { class: "cl-search" }, icon("search", 15), input),
  ];
}

export function renderChatListBody(v: ChatListView, a: ChatListActions): Child[] {
  const out: Child[] = [];
  if (v.error) {
    out.push(
      h(
        "div",
        { class: "error", style: "margin:8px 12px" },
        h("span", null, v.error),
        h("button", { title: "Dismiss", "aria-label": "Dismiss", onClick: a.dismissError }, icon("close", 14))
      )
    );
  }
  if (!v.items) {
    out.push(h("div", { class: "cl-empty" }, v.loading ? "Loading…" : ""));
    return out;
  }
  if (v.items.length === 0) {
    out.push(
      h(
        "div",
        { class: "cl-empty" },
        v.loading ? "Loading…" : v.q.trim() ? `No ${v.stage.name} leads match “${v.q.trim()}”.` : `No leads in ${v.stage.name} yet.`
      )
    );
    return out;
  }
  const sorted = [...v.items].sort((x, y) => {
    const diff = lastActivity(y, v.summaries.get(y.id)) - lastActivity(x, v.summaries.get(x.id));
    return diff !== 0 ? diff : (x.displayName || "").localeCompare(y.displayName || "");
  });
  for (const lead of sorted) out.push(row(lead, v, a));
  if (v.truncated) out.push(h("div", { class: "cl-empty" }, "Showing the first 200 leads. Search to find others."));
  return out;
}
