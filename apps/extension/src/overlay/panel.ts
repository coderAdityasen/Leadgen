import type { CrmLeadCard, CrmStage } from "@leaddesk/shared";
import { h, icon, renderState, type Child } from "./dom.js";
import { STAGE_COLORS } from "./styles.js";
import { contactKey, type OverlayState, type PanelActions } from "./types.js";

/** "More info" stays open across re-renders and chat switches once the operator opens it. */
let moreOpen = false;

export function stageColor(stages: CrmStage[], stageId: string | null | undefined): string {
  const index = stages.findIndex((s) => s.id === stageId);
  return STAGE_COLORS[(index < 0 ? 0 : index) % STAGE_COLORS.length] ?? "#475569";
}

function empty(title: string, text: string): HTMLElement {
  return h("div", { class: "empty" }, h("strong", null, title), text);
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const abs = date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const diffMin = Math.round((date.getTime() - Date.now()) / 60_000);
  let rel = "";
  if (Math.abs(diffMin) < 1) rel = "now";
  else if (Math.abs(diffMin) < 60) rel = diffMin > 0 ? `in ${diffMin}m` : `${-diffMin}m ago`;
  else if (Math.abs(diffMin) < 48 * 60) {
    const hrs = Math.round(diffMin / 60);
    rel = hrs > 0 ? `in ${hrs}h` : `${-hrs}h ago`;
  }
  return rel ? `${abs} (${rel})` : abs;
}

function phoneLabel(s: OverlayState, lead: CrmLeadCard | null): string | null {
  if (lead?.primaryPhone) return lead.primaryPhone;
  if (s.chat?.phoneUser) return `+${s.chat.phoneUser}`;
  return null;
}

function toggle(label: string, hint: string, checked: boolean, disabled: boolean, onChange: (on: boolean) => void): HTMLElement {
  const input = h("input", {
    type: "checkbox",
    checked,
    disabled,
    "aria-label": label,
    onChange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
  });
  return h(
    "div",
    { class: "switch-row" },
    h("div", null, h("div", { class: "lbl" }, label), h("div", { class: "hint" }, hint)),
    h("label", { class: "switch" }, input, h("span", { class: "track" }))
  );
}

function stageSelect(stages: CrmStage[], value: string, disabled: boolean, field: string, onChange: (id: string) => void) {
  return h(
    "select",
    { "data-field": field, disabled, onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    stages.map((st) => h("option", { value: st.id, selected: st.id === value }, st.name))
  );
}

function errorBox(message: string, onClose: () => void): HTMLElement {
  return h(
    "div",
    { class: "error", role: "alert" },
    h("span", null, message),
    h("button", { title: "Dismiss", "aria-label": "Dismiss", onClick: onClose }, icon("close", 14))
  );
}

function statusMark(s: OverlayState, field: string): Child {
  if (s.savingField === field) return h("span", { class: "saving" }, "Saving…");
  if (s.savedField === field) return h("span", { class: "saved" }, "Saved");
  return null;
}

/** Commit a text field on blur or Enter, when its trimmed value really changed. */
function commitOn(el: HTMLInputElement | HTMLTextAreaElement, original: string, commit: (value: string) => void, multiline = false) {
  const run = () => {
    if (renderState.replacing) return;
    const value = multiline ? el.value : el.value.trim();
    if (value !== original) commit(value);
  };
  el.addEventListener("blur", run);
  if (!multiline) {
    el.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        e.preventDefault();
        el.blur();
      }
    });
  }
}

export function renderPanelBody(s: OverlayState, a: PanelActions): Child[] {
  if (s.bridge === "foreign") {
    return [empty("Lead Desk is off in this tab", "Another WhatsApp tool is already running on this page.")];
  }
  if (s.paired === false) {
    return [empty("Not paired", "Pair Lead Desk from the extension popup.")];
  }
  if (s.bridge === "waiting" || s.paired === null) {
    return [empty("Waiting for WhatsApp…", "The lead panel appears once WhatsApp has finished loading.")];
  }
  const chat = s.chat;
  if (!chat?.chatJid || chat.kind !== "direct") {
    return [empty("No contact open", "Open a one-to-one chat to see the lead.")];
  }

  const key = contactKey(chat);
  if (!s.contact || s.contact.key !== key) {
    if (s.contactError) {
      return [
        errorBox(s.contactError, a.dismissError),
        h("button", { class: "btn block", onClick: a.retry }, icon("refresh", 14), "Try again"),
      ];
    }
    return [
      h(
        "div",
        { class: "section" },
        h("div", { class: "skeleton", style: "width:60%" }),
        h("div", { class: "skeleton", style: "width:85%" }),
        h("div", { class: "skeleton", style: "width:40%" })
      ),
    ];
  }

  const out: Child[] = [];
  if (s.panelError) out.push(errorBox(s.panelError, a.dismissError));
  const lead = s.contact.lead;
  if (!lead) out.push(...renderCreate(s, a));
  else out.push(...renderLead(s, a, lead));
  return out;
}

function renderCreate(s: OverlayState, a: PanelActions): Child[] {
  const chat = s.chat!;
  const stages = s.contact?.stages ?? s.stages;
  const phone = phoneLabel(s, null);
  const busy = s.busy !== null;
  const stageId = s.createStageId || stages[0]?.id || "";

  const nameInput = h("input", {
    type: "text",
    "data-field": "createName",
    value: s.createName,
    placeholder: "Lead name",
    maxLength: 200,
    onInput: (e: Event) => a.setCreateName((e.target as HTMLInputElement).value),
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      a.createLead();
    }
  });

  return [
    h(
      "div",
      { class: "section" },
      h("div", { class: "contact-name" }, chat.name || phone || "Unknown contact"),
      h(
        "div",
        { class: "field-wrap" },
        h("span", { class: "mono muted" }, phone ?? "Number hidden by WhatsApp"),
        phone
          ? h("button", { class: "icon-btn", title: "Copy number", "aria-label": "Copy number", onClick: () => a.copy(phone) }, icon("copy", 14))
          : null
      ),
      h("div", { class: "callout" }, h("div", { class: "k" }, "This chat is not a lead yet. Save it to track stage, notes, AI replies and follow-ups."))
    ),
    h(
      "div",
      { class: "section" },
      h("div", { class: "section-title" }, "Create lead"),
      h("div", { class: "row" }, h("label", null, "Name"), nameInput),
      h(
        "div",
        { class: "row" },
        h("label", null, "Stage"),
        stageSelect(stages, stageId, busy, "createStage", (id) => a.setCreateStage(id))
      ),
      h(
        "button",
        { class: "btn primary block", disabled: busy || stages.length === 0, onClick: a.createLead },
        s.busy === "create" ? "Creating…" : "Create lead"
      )
    ),
  ];
}

function renderLead(s: OverlayState, a: PanelActions, lead: CrmLeadCard): Child[] {
  const stages = s.contact?.stages ?? s.stages;
  const busy = s.busy !== null;
  const phone = phoneLabel(s, lead);

  // --- identity ---
  const nameInput = h("input", { type: "text", "data-field": "displayName", value: lead.displayName, maxLength: 200 });
  commitOn(nameInput, lead.displayName, (value) => {
    if (value) a.patchLead({ displayName: value }, "displayName");
    else nameInput.value = lead.displayName;
  });

  const badges: Child[] = [
    h("span", { class: "badge stage-badge", style: `background:${stageColor(stages, lead.stageId)}` }, lead.stageName),
  ];
  if (lead.doNotMessage) badges.push(h("span", { class: "badge danger", title: "Lead Desk will not send to this contact" }, "Do not message"));
  if (lead.archivedAt) badges.push(h("span", { class: "badge" }, "Archived"));
  if (lead.pendingScheduled > 0) badges.push(h("span", { class: "badge" }, `${lead.pendingScheduled} scheduled`));

  const identity = h(
    "div",
    { class: "section" },
    h("div", { class: "section-title" }, "Lead", h("span", { class: "grow" }), statusMark(s, "displayName")),
    h("div", { class: "row" }, h("label", null, "Name"), nameInput),
    h(
      "div",
      { class: "row" },
      h("span", { class: "lbl" }, "Phone"),
      h(
        "div",
        { class: "field-wrap" },
        h("span", { class: "mono", title: phone ?? "" }, phone ?? "Hidden by WhatsApp"),
        phone
          ? h("button", { class: "icon-btn", title: "Copy number", "aria-label": "Copy number", onClick: () => a.copy(phone) }, icon("copy", 14))
          : null
      )
    ),
    h(
      "div",
      { class: "row" },
      h("label", null, "Stage"),
      stageSelect(stages, lead.stageId, busy, "stage", (id) => {
        if (id !== lead.stageId) a.patchLead({ stageId: id }, "stage");
      })
    ),
    h("div", { class: "badges" }, badges)
  );

  // --- automation ---
  const automation = h(
    "div",
    { class: "section" },
    h("div", { class: "section-title" }, "Automation"),
    toggle("AI Reply", lead.aiEnabled ? "AI drafts replies to this lead" : "Off for this lead", lead.aiEnabled, busy, (on) =>
      a.patchLead({ aiEnabled: on }, "ai")
    ),
    toggle(
      "Auto Follow-up",
      lead.automationPaused ? "Paused: no automatic sends" : "Sequences and follow-ups may send",
      !lead.automationPaused,
      busy,
      (on) => a.patchLead({ automationPaused: !on }, "followup")
    )
  );

  // --- sequence ---
  const seqChildren: Child[] = [h("div", { class: "section-title" }, "Sequence")];
  if (lead.enrollment) {
    const e = lead.enrollment;
    const step = e.stepNumber != null ? `Step ${e.stepNumber} of ${e.totalSteps}` : `${e.totalSteps} steps`;
    const callout = h(
      "div",
      { class: "callout" },
      h("div", { class: "v" }, e.sequenceName),
      h("div", { class: "k" }, step)
    );
    if (lead.nextMessage) {
      const nm = lead.nextMessage;
      const body = nm.body.length > 220 ? `${nm.body.slice(0, 220)}…` : nm.body;
      callout.append(
        h("div", { class: "k" }, `Next ${nm.status === "needs_approval" ? "(needs approval) " : ""}· ${formatWhen(nm.dueAt)}`),
        h("div", { class: "next-body" }, body)
      );
    } else {
      callout.append(h("div", { class: "k" }, "No message queued right now."));
    }
    seqChildren.push(callout);
    seqChildren.push(
      h(
        "div",
        { style: "display:flex;gap:8px" },
        s.confirmStop
          ? [
              h("button", { class: "btn danger confirm sm", disabled: busy, onClick: a.cancelEnrollment }, s.busy === "stop" ? "Stopping…" : "Yes, stop sequence"),
              h("button", { class: "btn sm", disabled: busy, onClick: () => a.setConfirmStop(false) }, "Keep"),
            ]
          : h("button", { class: "btn danger sm", disabled: busy, onClick: () => a.setConfirmStop(true) }, "Stop sequence")
      )
    );
  } else {
    const sequences = (s.contact?.sequences ?? []).filter((q) => q.enabled && q.stepCount > 0);
    if (sequences.length === 0) {
      seqChildren.push(h("div", { class: "muted" }, "No sequence running. Create an enabled sequence in the dashboard to start one here."));
    } else {
      const selected = sequences.some((q) => q.id === s.selectedSequenceId) ? s.selectedSequenceId : "";
      seqChildren.push(
        h("div", { class: "muted" }, "No sequence running."),
        h(
          "div",
          { class: "field-wrap" },
          h(
            "select",
            {
              "data-field": "sequence",
              disabled: busy || lead.doNotMessage,
              onChange: (e: Event) => a.selectSequence((e.target as HTMLSelectElement).value),
            },
            h("option", { value: "", selected: selected === "" }, "Choose a sequence…"),
            sequences.map((q) => h("option", { value: q.id, selected: q.id === selected }, `${q.name} (${q.stepCount} steps)`))
          ),
          h(
            "button",
            { class: "btn primary sm", disabled: busy || !selected || lead.doNotMessage, onClick: a.enroll },
            s.busy === "enroll" ? "Starting…" : "Start"
          )
        )
      );
      if (lead.doNotMessage) seqChildren.push(h("div", { class: "muted" }, "Do-not-message is on, so sequences cannot start."));
    }
  }
  const sequence = h("div", { class: "section" }, seqChildren);

  // --- notes ---
  const notes = h("textarea", { "data-field": "notes", value: lead.notes, placeholder: "Add notes about this lead…", maxLength: 10000 });
  commitOn(notes, lead.notes, (value) => a.patchLead({ notes: value }, "notes"), true);
  const notesSection = h(
    "div",
    { class: "section" },
    h("div", { class: "section-title" }, "Notes", h("span", { class: "grow" }), statusMark(s, "notes")),
    notes
  );

  // --- more info ---
  const email = h("input", { type: "email", "data-field": "email", value: lead.email ?? "", placeholder: "name@example.com", maxLength: 200 });
  commitOn(email, lead.email ?? "", (value) => a.patchLead({ email: value || null }, "more"));
  const company = h("input", { type: "text", "data-field": "company", value: lead.company ?? "", placeholder: "Company", maxLength: 200 });
  commitOn(company, lead.company ?? "", (value) => a.patchLead({ company: value || null }, "more"));
  const more = h(
    "details",
    {
      class: "more section",
      open: moreOpen,
      onToggle: (e: Event) => {
        if (!renderState.replacing) moreOpen = (e.target as HTMLDetailsElement).open;
      },
    },
    h("summary", null, "More info", icon("chevronDown", 14), h("span", { class: "grow", style: "flex:1" }), statusMark(s, "more")),
    h(
      "div",
      { class: "inner" },
      h("div", { class: "row" }, h("label", null, "Email"), email),
      h("div", { class: "row" }, h("label", null, "Company"), company),
      h("div", { class: "row" }, h("span", { class: "lbl" }, "Created"), h("span", null, formatWhen(lead.createdAt))),
      h("div", { class: "row" }, h("span", { class: "lbl" }, "Last inbound"), h("span", null, formatWhen(lead.lastInboundAt))),
      h("div", { class: "row" }, h("span", { class: "lbl" }, "Last outbound"), h("span", null, formatWhen(lead.lastOutboundAt)))
    )
  );

  const link = dashboardLink(s.serverOrigin, lead.id);
  return [identity, automation, sequence, notesSection, more, link ? h("div", { class: "section" }, link) : null];
}

function dashboardLink(origin: string | null, leadId: string): HTMLElement | null {
  // The local desk (loopback http) or a remote desk over https.
  if (!origin || !(/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(origin) || /^https:\/\/[^/]+$/.test(origin))) return null;
  return h(
    "a",
    { class: "link", href: `${origin}/leads/${encodeURIComponent(leadId)}`, target: "_blank", rel: "noopener noreferrer" },
    "Open in dashboard",
    icon("external", 14)
  );
}
