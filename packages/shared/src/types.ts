import type { CrmRequest } from "./crm.js";

// --- Page <-> Content (via MessagePort) ---
export type BridgeReady = {
  bridge: "wa-js";
  bridgeVersion: "4.7.2";
  authenticated: boolean;
  streamMode: string | null;
};

export type AuthState = {
  authenticated: boolean;
  streamMode: string | null;
  ownJid: string | null;
  pushName: string | null;
};

export type InboundObserved = {
  waMessageId: string;
  chatJid: string;
  senderJid: string | null;
  senderLid: string | null;
  senderPhoneUser: string | null;
  fromMe: boolean;
  body: string;
  waTimestampMs: number;
  chatKind: "direct" | "group" | "broadcast" | "other";
};

export type ActiveChatKind = "direct" | "group" | "broadcast" | "other";

/** The chat open in this WhatsApp tab, as reported by the page bridge. All null when no chat is open. */
export type ActiveChatInfo = {
  chatJid: string | null;
  kind: ActiveChatKind | null;
  name: string | null;
  phoneUser: string | null;
  lid: string | null;
};

export type OpenChatResult = { ok: true; jid: string } | { ok: false; errorClass: string; detail: string };

/** Result of filtering WhatsApp's own chat list; matchedKeys = leads that have a chat there. */
export type ChatFilterResult = { ok: true; matchedKeys: string[] } | { ok: false; detail: string };

/** A lead's possible WhatsApp ids, keyed by lead id, for bridge lookups. */
export interface ChatLookupItem {
  key: string;
  jids: string[];
}

/** What WhatsApp already knows about a lead's chat, for the overlay's filtered chat list. */
export interface ChatSummary {
  /** the lead-side key the overlay asked with */
  key: string;
  found: boolean;
  title: string | null;
  lastBody: string | null;
  /** unix ms of the last message, or null */
  lastAt: number | null;
  lastFromMe: boolean;
  /** -1 = the user marked the chat unread (WhatsApp shows a dot) */
  unread: number;
  picUrl: string | null;
}

export type SendResult =
  | { ok: true; waMessageId: string; toJid: string }
  | { ok: false; outcome: "failed" | "uncertain"; errorClass: string; detail: string };

export type PageToContent =
  | { source: "leaddesk-page"; version: 1; type: "leaddesk.bridge.ready"; payload: BridgeReady }
  | { source: "leaddesk-page"; version: 1; type: "leaddesk.bridge.auth"; payload: AuthState }
  | { source: "leaddesk-page"; version: 1; type: "leaddesk.bridge.inbound"; payload: InboundObserved }
  | { source: "leaddesk-page"; version: 1; type: "leaddesk.bridge.pong"; requestId: string; payload: { ready: boolean } }
  | { source: "leaddesk-page"; version: 1; type: "leaddesk.bridge.sendResult"; requestId: string; payload: SendResult }
  | { source: "leaddesk-page"; version: 1; type: "leaddesk.bridge.activeChat"; payload: ActiveChatInfo }
  | { source: "leaddesk-page"; version: 1; type: "leaddesk.bridge.openChatResult"; requestId: string; payload: OpenChatResult };

export type ContentToPage =
  | { source: "leaddesk-content"; version: 1; type: "leaddesk.command.ping"; requestId: string }
  | { source: "leaddesk-content"; version: 1; type: "leaddesk.command.sendText"; requestId: string; payload: { outboundId: string; toJid: string; body: string } }
  | { source: "leaddesk-content"; version: 1; type: "leaddesk.command.openChat"; requestId: string; payload: { jid: string } };

// --- Content <-> Service worker (chrome.runtime) ---
export type ExtMessage =
  | { channel: "leaddesk"; type: "leaddesk.tab.hello"; payload: { ready: boolean; authenticated: boolean; href: string } }
  | { channel: "leaddesk"; type: "leaddesk.tab.tick" }
  | { channel: "leaddesk"; type: "leaddesk.tab.inbound"; payload: InboundObserved }
  | { channel: "leaddesk"; type: "leaddesk.tab.sendResult"; requestId: string; payload: SendResult }
  | { channel: "leaddesk"; type: "leaddesk.tab.auth"; payload: AuthState }
  | { channel: "leaddesk"; type: "leaddesk.worker.assign"; payload: { role: "sender" | "standby" } }
  | { channel: "leaddesk"; type: "leaddesk.worker.sendText"; requestId: string; payload: { outboundId: string; toJid: string; body: string } }
  | { channel: "leaddesk"; type: "leaddesk.crm.request"; payload: CrmRequest }
  | { channel: "leaddesk"; type: "leaddesk.crm.status" }
  | { channel: "leaddesk"; type: "leaddesk.crm.pairingChanged" };

// --- HTTP wire (server) ---
export type InboundWire = {
  waMessageId: string;
  chatJid: string;
  senderJid: string | null;
  senderLid: string | null;
  senderPhoneUser: string | null;
  fromMe: boolean;
  body: string;
  waTimestamp: string;
  chatKind: "direct" | "group" | "broadcast" | "other";
  fromJid: string;
  toJid: string;
};
