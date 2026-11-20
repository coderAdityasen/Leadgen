/**
 * Lead Desk CRM overlay for WhatsApp Web (isolated content-script world).
 *
 * - All UI lives in a closed Shadow DOM, so WhatsApp's CSS cannot reach it and ours cannot leak.
 * - The only change to WhatsApp's DOM is one <style> that shrinks #app to make room for the
 *   bar and panel; removing it (minimize, teardown) restores WhatsApp's layout exactly.
 * - Data comes from the service worker (`leaddesk.crm.request`); the device token stays there.
 * - Active-chat info and "open chat" go through the existing MessagePort via the host callbacks.
 */
import type {
  ActiveChatInfo,
  CrmBoard,
  CrmContact,
  CrmLeadCard,
  CrmOp,
  CrmResponse,
  CrmStage,
  ChatFilterResult,
  ChatLookupItem,
  ChatSummary,
  OpenChatResult,
} from "@leaddesk/shared";
import { crm, crmStatus, errorText, extensionAlive, loadPrefs, savePrefs } from "./api.js";
import { append, guard, h, icon, replaceKeepingFocus } from "./dom.js";
import { renderPanelBody, stageColor } from "./panel.js";
import { PAGE_STYLE_ID, PANEL_SLIM, PANEL_WIDTH, SHADOW_CSS, pageLayoutCss } from "./styles.js";
import { isDarkNow, watchTheme } from "./theme.js";
import { leadChatJid, leadChatJids, renderBar, type BarNote } from "./topbar.js";
import { renderChatListBody, renderChatListHead, type ChatListActions, type ChatListView } from "./chatlist.js";
import { contactKey, type BridgeStatus, type OverlayState, type PanelActions } from "./types.js";

export interface OverlayHost {
  openChat(jid: string): Promise<OpenChatResult>;
  chatSummaries(items: ChatLookupItem[]): Promise<ChatSummary[]>;
  /** filter WhatsApp's own chat list to these chats; null shows every chat again */
  setChatFilter(items: ChatLookupItem[] | null): Promise<ChatFilterResult>;
}

export interface OverlayController {
  setBridge(status: BridgeStatus): void;
  setActiveChat(info: ActiveChatInfo): void;
  pairingChanged(): void;
  /** a message arrived or was sent somewhere in WhatsApp */
  chatActivity(): void;
}

const HOST_ID = "leaddesk-overlay-host";
const REFRESH_MS = 30_000;
const ISOLATED_EVENTS = [
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "paste",
  "copy",
  "cut",
  "compositionstart",
  "compositionupdate",
  "compositionend",
] as const;

export function startOverlay(host: OverlayHost): OverlayController {
  try {
    return createOverlay(host);
  } catch (err) {
    console.warn("[Lead Desk overlay] failed to start", err);
    return { setBridge() {}, setActiveChat() {}, pairingChanged() {}, chatActivity() {} };
  }
}

function sortStages(stages: CrmStage[] | undefined): CrmStage[] {
  return Array.isArray(stages) ? [...stages].sort((x, y) => x.position - y.position) : [];
}

function createOverlay(host: OverlayHost): OverlayController {
  // A previous content script (extension reloaded) may have left its overlay behind.
  document.getElementById(HOST_ID)?.remove();
  document.getElementById(PAGE_STYLE_ID)?.remove();

  const state: OverlayState = {
    dark: isDarkNow(),
    prefs: { minimized: false, panelCollapsed: false },
    bridge: "waiting",
    paired: null,
    serverOrigin: null,
    stages: [],
    boardLoading: false,
    boardError: null,
    chat: null,
    contact: null,
    contactError: null,
    panelError: null,
    busy: null,
    savingField: null,
    savedField: null,
    confirmStop: false,
    selectedSequenceId: "",
    createName: "",
    createStageId: "",
  };
  let torn = false;
  let prefsLoaded = false;

  // ---------- DOM scaffold ----------
  const hostEl = document.createElement("div");
  hostEl.id = HOST_ID;
  hostEl.setAttribute(
    "style",
    "all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483000!important;display:block!important;"
  );
  const shadow = hostEl.attachShadow({ mode: "closed" });
  const styleEl = document.createElement("style");
  styleEl.textContent = SHADOW_CSS;
  const root = h("div", { class: "root" });
  const bar = h("div", { class: "bar", role: "region", "aria-label": "Lead Desk stages" });
  const panel = h("aside", { class: "panel", "aria-label": "Lead Desk lead panel" });
  const pill = h(
    "button",
    { class: "pill", title: "Show Lead Desk", onClick: () => setMinimized(false) },
    h("span", { class: "dot" }),
    "Lead Desk",
    icon("chevronDown", 12)
  );
  root.append(bar, panel, pill);
  shadow.append(styleEl, root);
  (document.body ?? document.documentElement).appendChild(hostEl);

  // Typing in our inputs must not reach WhatsApp's global key handlers (bubble phase).
  for (const type of ISOLATED_EVENTS) {
    shadow.addEventListener(type, (e) => {
      e.stopPropagation();
    });
  }

  // ---------- layout on WhatsApp's page ----------
  let lastLayoutCss: string | null = null;
  function applyLayout() {
    const existing = document.getElementById(PAGE_STYLE_ID);
    // Until prefs load we do not know if the operator minimized the bar; do not move WhatsApp yet.
    if (torn || state.prefs.minimized || !prefsLoaded) {
      if (existing) existing.remove();
      if (lastLayoutCss !== null) {
        lastLayoutCss = null;
        nudgeResize();
      }
      return;
    }
    const css = pageLayoutCss(state.prefs.panelCollapsed ? PANEL_SLIM : PANEL_WIDTH);
    let el = existing as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = PAGE_STYLE_ID;
      (document.head ?? document.documentElement).appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
    if (lastLayoutCss !== css) {
      lastLayoutCss = css;
      nudgeResize();
    }
  }
  function nudgeResize() {
    // WhatsApp sizes some lists on window resize; tell it the usable area changed.
    requestAnimationFrame(() => {
      try {
        window.dispatchEvent(new Event("resize"));
      } catch {
        // ignore
      }
    });
  }

  // ---------- rendering ----------
  function render() {
    renderChrome();
    renderBarNow();
    renderPanel();
    renderChatList();
  }
  function renderChrome() {
    root.classList.toggle("dark", state.dark);
    const min = state.prefs.minimized || !prefsLoaded;
    bar.style.display = min ? "none" : "";
    panel.style.display = min ? "none" : "";
    pill.style.display = prefsLoaded && state.prefs.minimized ? "" : "none";
    panel.classList.toggle("slim", state.prefs.panelCollapsed);
  }
  let scrolledToStage: string | null = null;
  function renderBarNow() {
    if (torn) return;
    replaceKeepingFocus(shadow, bar, renderBar(state, barActions, filter?.stageId ?? null, filterNote()));
    // Many stages scroll sideways; bring a newly selected chevron into view (once, not on every refresh).
    const selected = filter?.stageId ?? null;
    if (selected !== scrolledToStage) {
      scrolledToStage = selected;
      bar.querySelector(".stage.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  function renderPanel() {
    if (torn) return;
    if (state.prefs.panelCollapsed) {
      replaceKeepingFocus(shadow, panel, [
        h("button", { class: "icon-btn", title: "Show lead panel", "aria-label": "Show lead panel", onClick: panelActions.togglePanel }, icon("chevronLeft")),
        h("button", { class: "slim-label", onClick: panelActions.togglePanel }, "Lead Desk"),
      ]);
      return;
    }
    const head = h(
      "div",
      { class: "panel-head" },
      h("span", { class: "title" }, state.contact?.lead ? "Lead" : "Contact"),
      h("button", { class: "icon-btn", title: "Collapse panel", "aria-label": "Collapse panel", onClick: panelActions.togglePanel }, icon("chevronRight"))
    );
    const body = h("div", { class: "panel-body" }, renderPanelBody(state, panelActions));
    // Keep the body's scroll position while re-rendering the same chat.
    const key = contactKey(state.chat);
    const oldBody = panel.querySelector(".panel-body");
    const scrollTop = oldBody && panel.getAttribute("data-key") === key ? oldBody.scrollTop : 0;
    replaceKeepingFocus(shadow, panel, [head, body]);
    body.scrollTop = scrollTop;
    panel.setAttribute("data-key", key);
  }

  // ---------- server data ----------
  let boardSeq = 0;
  let boardTimer: ReturnType<typeof setTimeout> | null = null;
  let contactSeq = 0;
  let contactTimer: ReturnType<typeof setTimeout> | null = null;

  function handleNotPaired(res: CrmResponse<unknown>): boolean {
    if (!res.ok && res.error.code === "not_paired") {
      setPaired(false, null);
      return true;
    }
    if (!res.ok && res.error.code === "extension_unavailable" && !extensionAlive()) {
      teardown();
      return true;
    }
    return false;
  }

  function scheduleBoard(delay = 300) {
    if (boardTimer) clearTimeout(boardTimer);
    boardTimer = setTimeout(() => guard(refreshBoard), delay);
  }
  async function refreshBoard() {
    if (torn || state.paired !== true) return;
    const seq = ++boardSeq;
    state.boardLoading = true;
    renderBarNow();
    const res = await crm<CrmBoard>("board");
    if (torn || seq !== boardSeq) return;
    state.boardLoading = false;
    if (res.ok) {
      state.stages = sortStages(res.data?.stages);
      state.boardError = null;
      // Keep the stage filter in step: a lead may have moved stage, or the stage was deleted.
      if (filter && !state.stages.some((st) => st.id === filter!.stageId)) setFilter(null);
      else if (filter) scheduleFilterLoad(0);
    } else if (!handleNotPaired(res)) {
      state.boardError = errorText(res);
    }
    renderBarNow();
  }

  function scheduleContact(delay = 250) {
    if (contactTimer) clearTimeout(contactTimer);
    contactTimer = setTimeout(() => guard(loadContact), delay);
  }
  async function loadContact() {
    if (torn) return;
    const chat = state.chat;
    const key = contactKey(chat);
    if (state.paired !== true || !key || !chat?.chatJid) {
      contactSeq++;
      renderPanel();
      return;
    }
    const seq = ++contactSeq;
    const res = await crm<CrmContact>("contact", { chatJid: chat.chatJid, lid: chat.lid, phoneUser: chat.phoneUser });
    if (torn || seq !== contactSeq || contactKey(state.chat) !== key) return; // stale
    if (res.ok) {
      state.contact = {
        key,
        lead: res.data?.lead ?? null,
        stages: sortStages(res.data?.stages),
        sequences: Array.isArray(res.data?.sequences) ? res.data.sequences : [],
      };
      state.contactError = null;
      if (state.contact.stages.length) {
        state.stages = state.contact.stages;
        renderBarNow();
      }
    } else if (!handleNotPaired(res)) {
      state.contactError = errorText(res);
    }
    renderPanel();
  }

  async function refreshStatus() {
    const status = await crmStatus();
    if (torn) return;
    if (!status) {
      if (!extensionAlive()) teardown();
      return;
    }
    setPaired(status.paired, status.serverOrigin);
  }

  function setPaired(paired: boolean, origin: string | null) {
    const changed = state.paired !== paired;
    state.paired = paired;
    state.serverOrigin = paired ? origin : null;
    if (!paired) {
      state.stages = [];
      state.contact = null;
      state.boardError = null;
      setFilter(null);
    }
    if (changed) {
      render();
      if (paired) {
        scheduleBoard(0);
        scheduleContact(0);
      }
    }
  }

  // ---------- mutations ----------
  // Mutations run one at a time, in order, so a notes blur followed by a quick toggle both land.
  let mutationChain: Promise<unknown> = Promise.resolve();
  function mutate(label: string, op: CrmOp, params: Record<string, unknown>, field?: string): Promise<boolean> {
    const run = mutationChain.then(
      () => runMutation(label, op, params, field),
      () => runMutation(label, op, params, field)
    );
    mutationChain = run.catch(() => false);
    return run;
  }
  async function runMutation(label: string, op: CrmOp, params: Record<string, unknown>, field?: string): Promise<boolean> {
    if (torn) return false;
    const key = state.contact?.key ?? null;
    contactSeq++; // any in-flight contact load is now older than this change
    state.busy = label;
    state.panelError = null;
    state.savingField = field ?? null;
    renderPanel();
    const res = await crm<{ lead?: CrmLeadCard | null }>(op, params);
    if (torn) return false;
    state.busy = null;
    state.savingField = null;
    const same = state.contact !== null && state.contact.key === key;
    if (res.ok) {
      if (same && res.data?.lead && state.contact) state.contact.lead = res.data.lead;
      if (field && same) flashSaved(field);
    } else if (!handleNotPaired(res) && same) {
      state.panelError = errorText(res);
    }
    renderPanel();
    scheduleContact(400);
    scheduleBoard(400);
    return res.ok;
  }

  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  function flashSaved(field: string) {
    state.savedField = field;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      if (state.savedField === field) {
        state.savedField = null;
        renderPanel();
      }
    }, 2000);
  }

  function newIdempotencyKey(): string {
    try {
      return crypto.randomUUID().replace(/-/g, "");
    } catch {
      return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    }
  }

  const panelActions: PanelActions = {
    togglePanel() {
      state.prefs = { ...state.prefs, panelCollapsed: !state.prefs.panelCollapsed };
      savePrefs(state.prefs);
      renderChrome();
      renderPanel();
      applyLayout();
    },
    retry() {
      state.contactError = null;
      renderPanel();
      void refreshStatus().then(() => scheduleContact(0));
    },
    dismissError() {
      state.panelError = null;
      state.contactError = null;
      renderPanel();
      if (!state.contact || state.contact.key !== contactKey(state.chat)) scheduleContact(0);
    },
    createLead() {
      const chat = state.chat;
      if (!chat?.chatJid || chat.kind !== "direct") return;
      const stages = state.contact?.stages ?? state.stages;
      const stageId = state.createStageId || stages[0]?.id;
      void mutate("create", "createLead", {
        chatJid: chat.chatJid,
        lid: chat.lid ?? undefined,
        phoneUser: chat.phoneUser ?? undefined,
        displayName: state.createName.trim() || undefined,
        stageId: stageId || undefined,
      });
    },
    setCreateName(value) {
      state.createName = value;
    },
    setCreateStage(stageId) {
      state.createStageId = stageId;
    },
    patchLead(patch, field) {
      const lead = state.contact?.lead;
      if (!lead) return;
      void mutate(field ?? "update", "updateLead", { leadId: lead.id, patch }, field);
    },
    selectSequence(sequenceId) {
      state.selectedSequenceId = sequenceId;
      renderPanel();
    },
    enroll() {
      const lead = state.contact?.lead;
      if (!lead || !state.selectedSequenceId) return;
      void mutate("enroll", "enroll", {
        leadId: lead.id,
        sequenceId: state.selectedSequenceId,
        idempotencyKey: newIdempotencyKey(),
      }).then((ok) => {
        if (ok) state.selectedSequenceId = "";
      });
    },
    cancelEnrollment() {
      const lead = state.contact?.lead;
      if (!lead) return;
      void mutate("stop", "cancelEnrollment", { leadId: lead.id }).then(() => {
        state.confirmStop = false;
        renderPanel();
      });
    },
    setConfirmStop(on) {
      state.confirmStop = on;
      renderPanel();
    },
    copy(text) {
      try {
        void navigator.clipboard?.writeText(text).catch(() => {});
      } catch {
        // clipboard blocked; nothing else to do
      }
    },
  };

  // ---------- stage filter ----------
  // Two ways to show a stage, chosen per tab:
  //  - "native": WhatsApp's own chat list is filtered (WPP.chat.setChatList). Rows, unread
  //    badges, search and right-click menus are WhatsApp's own. Leads with no chat yet cannot
  //    appear there, so the bar offers to list them.
  //  - "list": our WhatsApp-style list over the chat column. Used when native filtering is not
  //    available on this WhatsApp build, or to see leads without a chat.
  type FilterMode = "pending" | "native" | "list";
  /** null = not tried yet in this tab; false = this WhatsApp build cannot filter natively */
  let nativeSupported: boolean | null = null;

  const listEl = h("section", { class: "chatlist", "aria-label": "Leads in this stage" });
  const listHead = h("div", { class: "cl-head-wrap" });
  const listBody = h("div", { class: "cl-list", role: "list" });
  listEl.append(listHead, listBody);
  listEl.style.display = "none";
  root.appendChild(listEl);
  const listInput = h("input", {
    type: "search",
    placeholder: "Search name, phone or company",
    "aria-label": "Search leads in this stage",
    onInput: (e: Event) => chatListActions.search((e.target as HTMLInputElement).value),
    onKeydown: (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape") {
        if (listInput.value) {
          listInput.value = "";
          chatListActions.search("");
        } else {
          chatListActions.close();
        }
      }
    },
  });

  interface StageFilter {
    stageId: string;
    mode: FilterMode;
    /** operator asked for the full lead list (leads without a chat included) */
    wantList: boolean;
    q: string;
    seq: number;
    timer: ReturnType<typeof setTimeout> | null;
    items: CrmLeadCard[] | null;
    summaries: Map<string, ChatSummary>;
    summarySeq: number;
    summaryKey: string;
    /** lead ids that have a chat in WhatsApp's list (native mode) */
    matched: Set<string> | null;
    nativeSeq: number;
    lastNativeAt: number;
    error: string | null;
    loading: boolean;
    truncated: boolean;
    openingLeadId: string | null;
  }
  let filter: StageFilter | null = null;
  let listVisible = false;

  function lookupItems(items: CrmLeadCard[]): ChatLookupItem[] {
    return items.map((lead) => ({ key: lead.id, jids: leadChatJids(lead) })).filter((i) => i.jids.length > 0);
  }

  function filterView(): ChatListView | null {
    const f = filter;
    if (!f) return null;
    const stage = state.stages.find((s) => s.id === f.stageId);
    if (!stage) return null;
    return {
      stage,
      color: stageColor(state.stages, stage.id),
      q: f.q,
      items: f.items,
      summaries: f.summaries,
      loading: f.loading,
      error: f.error,
      truncated: f.truncated,
      activeLeadId: activeLeadId(),
      openingLeadId: f.openingLeadId,
      canUseNative: nativeSupported !== false && state.bridge === "ready",
    };
  }

  /** The lead whose chat is open on the right, if it is in the filtered list. */
  function activeLeadId(): string | null {
    const chat = state.chat;
    if (!filter?.items || !chat?.chatJid) return null;
    const phone = chat.phoneUser ? `+${chat.phoneUser}` : null;
    const hit = filter.items.find(
      (l) =>
        (l.waJid && l.waJid === chat.chatJid) ||
        (l.waLid && (l.waLid === chat.chatJid || l.waLid === chat.lid)) ||
        (phone && l.primaryPhone === phone)
    );
    if (hit) return hit.id;
    // The panel's lookup is authoritative, but only when it belongs to the chat open right now.
    const contact = state.contact;
    return contact && contact.key === contactKey(chat) ? contact.lead?.id ?? null : null;
  }

  /** What the bar says about the current filter (and the one action it may offer). */
  function filterNote(): BarNote | null {
    const f = filter;
    if (!f) return null;
    const stage = state.stages.find((s) => s.id === f.stageId);
    if (!stage) return null;
    if (f.mode === "pending") return { text: `Filtering chats: ${stage.name}…` };
    if (f.mode === "native") {
      if (f.error) return { text: f.error, err: true };
      const total = f.items?.length ?? 0;
      const shown = f.matched?.size ?? 0;
      const missing = Math.max(0, total - shown);
      const text =
        total === 0
          ? `No leads in ${stage.name}`
          : `${stage.name}: ${shown} chat${shown === 1 ? "" : "s"}${f.truncated ? " (first 200 leads)" : ""}`;
      return missing > 0
        ? { text, action: { label: `+${missing} without a chat`, title: "List every lead in this stage, including ones you have not chatted with", run: () => showLeadList() } }
        : { text };
    }
    return listBlocked ? { text: listBlocked } : null;
  }

  function renderChatList() {
    if (torn) return;
    const view = filterView();
    const show = Boolean(view) && filter?.mode === "list" && !state.prefs.minimized && prefsLoaded;
    listVisible = show;
    if (!show || !view) {
      listEl.style.display = "none";
      return;
    }
    listEl.style.display = "";
    placeChatList();
    replaceKeepingFocus(shadow, listHead, renderChatListHead(view, chatListActions, listInput));
    const scrollTop = listBody.scrollTop;
    listBody.replaceChildren();
    append(listBody, renderChatListBody(view, chatListActions));
    listBody.scrollTop = scrollTop;
  }

  /**
   * Cover WhatsApp's chat column exactly. The list is hidden (not moved elsewhere) when that
   * column is not on screen: Status/Channels/Communities tab, a left drawer such as Profile,
   * Settings or New chat sliding over it, the single-column layout of a narrow window while a
   * chat is open, or the QR/login screen. It comes back by itself when the chat list does.
   */
  let placeTimer: ReturnType<typeof setInterval> | null = null;
  let listBlocked: string | null = null;
  function chatColumnBox(): { box: DOMRect | null; why: string | null } {
    const side = document.getElementById("side") ?? document.getElementById("pane-side")?.parentElement ?? null;
    if (!side) return { box: null, why: "Open WhatsApp's Chats tab to see this stage" };
    const rect = side.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 200 || rect.right <= 0 || rect.left >= window.innerWidth) {
      return { box: null, why: "Widen the window or go back to the chat list to see this stage" };
    }
    // Something of WhatsApp's own (a drawer or dialog) on top of the column? Let it be used.
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + Math.min(rect.height / 2, 200)));
    const top = document.elementsFromPoint(x, y).find((el) => el !== hostEl && !hostEl.contains(el));
    if (top && !side.contains(top) && !top.contains(side)) return { box: null, why: "Close WhatsApp's side panel to see this stage" };
    return { box: rect, why: null };
  }
  function placeChatList() {
    if (!filter || torn || !listVisible || document.visibilityState !== "visible") return;
    const { box, why } = chatColumnBox();
    if (why !== listBlocked) {
      listBlocked = why;
      renderBarNow();
    }
    if (!box) {
      if (listEl.style.visibility !== "hidden") listEl.style.visibility = "hidden";
      return;
    }
    const css = `left:${Math.round(box.left)}px;top:${Math.round(box.top)}px;width:${Math.round(box.width)}px;height:${Math.round(box.height)}px;`;
    if (listEl.getAttribute("style") !== css) listEl.setAttribute("style", css);
  }

  function scheduleFilterLoad(delay = 250) {
    const f = filter;
    if (!f) return;
    if (f.timer) clearTimeout(f.timer);
    f.timer = setTimeout(() => guard(loadFilter), delay);
  }

  async function loadFilter() {
    const f = filter;
    if (!f || torn) return;
    const seq = ++f.seq;
    f.loading = true;
    if (!f.items) renderChatList();
    // Native mode shows every chat of the stage; the search box only exists in list mode.
    const q = f.mode === "list" ? f.q.trim() : "";
    const res = await crm<CrmBoard>("board", { stageId: f.stageId, q: q || undefined });
    if (filter !== f || seq !== f.seq) return;
    f.loading = false;
    if (!res.ok) {
      if (!handleNotPaired(res)) {
        f.error = errorText(res);
        renderChatList();
        renderBarNow();
      }
      return;
    }
    f.items = Array.isArray(res.data?.items) ? res.data.items : [];
    f.truncated = Boolean(res.data?.truncated);
    f.error = null;
    if (res.data?.stages) state.stages = sortStages(res.data.stages);
    if (f.mode === "list") {
      renderBarNow();
      renderChatList();
      await loadSummaries(f);
    } else {
      await applyNative(f);
    }
  }

  /** Filter WhatsApp's own list to this stage; fall back to our list if that is not possible. */
  async function applyNative(f: StageFilter) {
    if (filter !== f || !f.items) return;
    if (state.bridge !== "ready" || nativeSupported === false) {
      switchToList(f, false);
      return;
    }
    const seq = ++f.nativeSeq;
    f.lastNativeAt = Date.now();
    const res = await host.setChatFilter(lookupItems(f.items));
    if (filter !== f || seq !== f.nativeSeq) return; // a newer request (or "All chats") won
    if (!res.ok) {
      // Only a ready bridge that still fails means this WhatsApp build cannot filter.
      if (state.bridge === "ready" && /unavailable/i.test(res.detail)) nativeSupported = false;
      switchToList(f, false);
      return;
    }
    f.matched = new Set(res.matchedKeys);
    const firstTime = f.mode !== "native";
    f.mode = "native";
    renderBarNow();
    renderChatList();
    if (firstTime && nativeSupported === null) verifyNative(f);
  }

  /**
   * wa-js can accept the filter yet fail to hook WhatsApp's list on some builds. If WhatsApp
   * still renders more chat rows than the stage has chats, native filtering does not work in
   * this tab: undo it and use our list instead.
   */
  function verifyNative(f: StageFilter) {
    setTimeout(
      () =>
        guard(() => {
          if (filter !== f || f.mode !== "native" || !f.matched) return;
          const pane = document.getElementById("pane-side");
          if (!pane || pane.getBoundingClientRect().width < 100) return; // cannot tell; keep it
          const rows = pane.querySelectorAll('[role="listitem"], [role="row"]').length;
          if (rows > f.matched.size + 2) {
            nativeSupported = false;
            void host.setChatFilter(null);
            switchToList(f, false);
          } else {
            nativeSupported = true;
          }
        }),
      900
    );
  }

  function switchToList(f: StageFilter, userAsked: boolean) {
    if (filter !== f) return;
    if (userAsked) f.wantList = true;
    if (f.mode === "native") void host.setChatFilter(null);
    f.mode = "list";
    f.matched = null;
    renderBarNow();
    renderChatList();
    void loadSummaries(f);
  }

  function showLeadList() {
    if (filter) switchToList(filter, true);
  }

  function showNativeView() {
    const f = filter;
    if (!f || nativeSupported === false) return;
    f.wantList = false;
    f.mode = "pending";
    f.q = "";
    listInput.value = "";
    renderBarNow();
    renderChatList();
    scheduleFilterLoad(0);
  }

  /** Ask WhatsApp (via the page bridge) for each lead's last message, time and unread count. */
  async function loadSummaries(f: StageFilter) {
    if (!f.items?.length || state.bridge !== "ready" || f.mode !== "list") return;
    const seq = ++f.summarySeq;
    const summaries = await host.chatSummaries(lookupItems(f.items));
    if (filter !== f || seq !== f.summarySeq) return; // an older answer must not overwrite a newer one
    const map = new Map<string, ChatSummary>();
    for (const s of summaries) if (s && typeof s.key === "string" && s.found) map.set(s.key, s);
    const key = JSON.stringify([...map.entries()]);
    if (key === f.summaryKey) return; // nothing changed: skip the re-render (keeps images and hover)
    f.summaryKey = key;
    f.summaries = map;
    renderChatList();
  }

  function setFilter(stageId: string | null) {
    const prev = filter;
    if (prev?.timer) clearTimeout(prev.timer);
    if (stageId === null || !state.stages.some((s) => s.id === stageId)) {
      filter = null;
      listBlocked = null;
      if (placeTimer) clearInterval(placeTimer);
      placeTimer = null;
      if (summaryTimer) clearInterval(summaryTimer);
      summaryTimer = null;
      if (prev && prev.mode !== "list") void host.setChatFilter(null);
      renderChatList();
      renderBarNow();
      return;
    }
    if (prev?.stageId !== stageId) {
      const wantList = prev?.wantList ?? false;
      filter = {
        stageId,
        mode: wantList || nativeSupported === false ? "list" : "pending",
        wantList,
        q: "",
        seq: 0,
        timer: null,
        items: null,
        summaries: new Map(),
        summarySeq: 0,
        summaryKey: "",
        matched: null,
        nativeSeq: 0,
        lastNativeAt: 0,
        error: null,
        loading: true,
        truncated: false,
        openingLeadId: null,
      };
      // Leaving native mode for list mode on a new stage: show WhatsApp's whole list behind ours.
      if (prev && prev.mode === "native" && filter.mode === "list") void host.setChatFilter(null);
      listInput.value = "";
      listBody.scrollTop = 0;
    }
    if (!placeTimer) placeTimer = setInterval(() => guard(placeChatList), 400);
    // Previews and unread counts come from WhatsApp's memory; re-read them now and then.
    if (!summaryTimer) {
      summaryTimer = setInterval(
        () => guard(() => filter && document.visibilityState === "visible" && loadSummaries(filter)),
        15_000
      );
    }
    renderBarNow();
    renderChatList();
    scheduleFilterLoad(0);
  }

  let summaryTimer: ReturnType<typeof setInterval> | null = null;
  let activityTimer: ReturnType<typeof setTimeout> | null = null;

  /** A message came or went: refresh previews (list) or pick up newly created chats (native). */
  function onChatActivity() {
    const f = filter;
    if (!f) return;
    if (f.mode === "list") void loadSummaries(f);
    else if (f.mode === "native" && Date.now() - f.lastNativeAt > 5_000) void applyNative(f);
  }

  async function openLead(lead: CrmLeadCard) {
    const f = filter;
    if (!f || f.openingLeadId === lead.id) return; // double click while it opens
    const jid = leadChatJid(lead);
    if (!jid) {
      f.error = "This lead has no WhatsApp number.";
      renderChatList();
      return;
    }
    if (state.bridge !== "ready") {
      f.error = state.bridge === "foreign" ? "Lead Desk cannot open chats in this tab." : "WhatsApp is still loading. Try again in a moment.";
      renderChatList();
      return;
    }
    f.openingLeadId = lead.id;
    f.error = null;
    renderChatList();
    const result = await host.openChat(jid);
    if (filter !== f) return;
    f.openingLeadId = null;
    if (!result.ok) {
      f.error =
        result.errorClass === "not_on_whatsapp"
          ? "This number is not on WhatsApp."
          : result.errorClass === "timeout"
            ? "WhatsApp took too long to open the chat. Try again."
            : `Could not open the chat (${result.detail}).`;
    }
    renderChatList();
  }

  const chatListActions: ChatListActions = {
    close() {
      setFilter(null);
    },
    search(q: string) {
      if (!filter) return;
      filter.q = q;
      scheduleFilterLoad(250);
    },
    open(lead) {
      void openLead(lead);
    },
    dismissError() {
      if (!filter) return;
      filter.error = null;
      renderChatList();
    },
    nativeView() {
      showNativeView();
    },
  };

  const barActions = {
    selectStage(stageId: string | null) {
      setFilter(stageId);
    },
    refresh() {
      void refreshStatus().then(() => {
        scheduleBoard(0);
        scheduleContact(0);
        if (filter) scheduleFilterLoad(0);
      });
    },
    minimize() {
      setMinimized(true);
    },
  };

  function setMinimized(minimized: boolean) {
    // With the bar hidden there would be no way to undo a filter: always go back to all chats.
    if (minimized) setFilter(null);
    state.prefs = { ...state.prefs, minimized };
    savePrefs(state.prefs);
    renderChrome();
    applyLayout();
    if (!minimized) render();
    else renderChatList();
  }

  // ---------- lifecycle ----------
  const stopTheme = watchTheme((dark) => {
    state.dark = dark;
    renderChrome();
  });

  const tick = setInterval(
    () =>
      guard(async () => {
        if (!extensionAlive()) {
          teardown();
          return;
        }
        applyLayout(); // re-add our <style> if something removed it
        if (document.visibilityState !== "visible") return;
        await refreshStatus();
        scheduleBoard(0);
      }),
    REFRESH_MS
  );
  const onVisible = () =>
    guard(() => {
      if (document.visibilityState === "visible") barActions.refresh();
    });
  document.addEventListener("visibilitychange", onVisible);
  const onResize = () => guard(placeChatList);
  window.addEventListener("resize", onResize);

  function teardown() {
    if (torn) return;
    torn = true;
    clearInterval(tick);
    if (boardTimer) clearTimeout(boardTimer);
    if (placeTimer) clearInterval(placeTimer);
    if (summaryTimer) clearInterval(summaryTimer);
    if (activityTimer) clearTimeout(activityTimer);
    if (filter?.timer) clearTimeout(filter.timer);
    // Never leave WhatsApp's own list filtered behind us (the bridge watchdog is the backstop).
    if (filter && filter.mode !== "list") void host.setChatFilter(null);
    filter = null;
    if (contactTimer) clearTimeout(contactTimer);
    if (savedTimer) clearTimeout(savedTimer);
    stopTheme();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("resize", onResize);
    hostEl.remove();
    document.getElementById(PAGE_STYLE_ID)?.remove();
    nudgeResize();
  }

  render();
  void loadPrefs().then((prefs) =>
    guard(() => {
      if (torn) return;
      state.prefs = prefs;
      prefsLoaded = true;
      render();
      applyLayout();
    })
  );
  void refreshStatus();

  return {
    setBridge(status) {
      guard(() => {
        if (torn || state.bridge === status) return;
        state.bridge = status;
        render();
        // WhatsApp finished loading while a stage was selected: try its own list again.
        if (filter && status === "ready" && !filter.wantList && nativeSupported !== false) showNativeView();
        else if (filter && status === "ready") void loadSummaries(filter);
      });
    },
    setActiveChat(info) {
      guard(() => {
        if (torn) return;
        if (state.bridge === "waiting") state.bridge = "ready";
        const prevKey = contactKey(state.chat);
        state.chat = info;
        const key = contactKey(info);
        if (key !== prevKey) {
          state.panelError = null;
          state.contactError = null;
          state.confirmStop = false;
          state.savedField = null;
          state.selectedSequenceId = "";
          state.createName = info.name ?? "";
          state.createStageId = "";
          renderBarNow();
          renderPanel();
        }
        if (filter) {
          renderChatList();
          void loadSummaries(filter); // unread count clears once a chat is opened
        }
        scheduleContact();
      });
    },
    chatActivity() {
      guard(() => {
        if (torn || !filter) return;
        if (activityTimer) clearTimeout(activityTimer);
        activityTimer = setTimeout(() => guard(onChatActivity), 800);
      });
    },
    pairingChanged() {
      guard(() => {
        if (!torn) void refreshStatus();
      });
    },
  };
}
