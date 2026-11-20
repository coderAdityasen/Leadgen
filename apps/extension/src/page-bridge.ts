import {
  SEND_OPTIONS,
  readWaMessageId,
  classifyChatKind,
  pnLidArg,
  type SendResult,
  type InboundObserved,
  type ActiveChatInfo,
  type OpenChatResult,
  type ChatSummary,
  type ChatFilterResult,
} from "@leaddesk/shared";

if (location.origin === "https://web.whatsapp.com") {
  // Handshake once per document
  const channel = new MessageChannel();
  const port1 = channel.port1;

  window.postMessage(
    { source: "leaddesk-page", version: 1, type: "leaddesk.port" },
    "https://web.whatsapp.com",
    [channel.port2]
  );

  // Check stored probe flag
  const isForeign = Boolean((globalThis as any).__leadDeskForeignWpp);
  if (isForeign) {
    port1.postMessage({
      source: "leaddesk-page",
      version: 1,
      type: "leaddesk.bridge.auth",
      payload: {
        authenticated: false,
        streamMode: "foreign_bridge",
        ownJid: null,
        pushName: null,
      },
    });
  } else {
    initBridge(port1);
  }
}

function serializedWid(value: unknown): string | null {
  if (typeof value === "string" && value.includes("@")) return value;
  if (!value || typeof value !== "object") return null;
  const obj = value as { _serialized?: unknown; id?: unknown };
  if (typeof obj._serialized === "string" && obj._serialized.includes("@")) return obj._serialized;
  if (typeof obj.id === "string" && obj.id.includes("@")) return obj.id;
  if (obj.id && typeof obj.id === "object") {
    const nested = (obj.id as { _serialized?: unknown })._serialized;
    if (typeof nested === "string" && nested.includes("@")) return nested;
  }
  return null;
}

async function initBridge(port: MessagePort) {
  const WPP = (window as any).WPP;
  if (!WPP) {
    console.warn("[Lead Desk Bridge] window.WPP not found.");
    return;
  }

  // Wait for ready gate (up to 60s)
  const readyPromise = new Promise<boolean>((resolve) => {
    if (WPP.isReady === true) {
      resolve(true);
      return;
    }
    if (WPP.loader?.onReady) {
      WPP.loader.onReady(() => resolve(true));
    }
    const checkTimer = setInterval(() => {
      if (WPP.isReady === true) {
        clearInterval(checkTimer);
        resolve(true);
      }
    }, 250);
    setTimeout(() => {
      clearInterval(checkTimer);
      resolve(WPP.isReady === true);
    }, 60_000);
  });

  const isReady = await readyPromise;
  if (!isReady) {
    console.warn("[Lead Desk Bridge] Timed out waiting for WPP.isReady.");
    return;
  }
  const readyTimestamp = Date.now();

  // A bridge from before an extension reload may have left WhatsApp's list filtered.
  resetStaleChatFilter(WPP);

  function getStreamMode(): string | null {
    try {
      return WPP.conn?.getStreamMode?.() ?? (WPP.conn?.isAuthenticated?.() ? "MAIN" : null);
    } catch {
      return null;
    }
  }

  function getOwnJid(): string | null {
    try {
      const myId = WPP.conn?.getMyUserId?.();
      return myId?._serialized ?? (typeof myId === "string" ? myId : null);
    } catch {
      return null;
    }
  }

  function getPushName(): string | null {
    try {
      return WPP.conn?.getPushname?.() ?? null;
    } catch {
      return null;
    }
  }

  function sendAuthState() {
    const isAuthenticated = Boolean(WPP.conn?.isAuthenticated?.());
    const streamMode = getStreamMode();
    const ownJid = getOwnJid();
    const pushName = getPushName();

    port.postMessage({
      source: "leaddesk-page",
      version: 1,
      type: "leaddesk.bridge.auth",
      payload: { authenticated: isAuthenticated, streamMode, ownJid, pushName },
    });
  }

  // Announce ready
  const isAuth = Boolean(WPP.conn?.isAuthenticated?.());
  port.postMessage({
    source: "leaddesk-page",
    version: 1,
    type: "leaddesk.bridge.ready",
    payload: {
      bridge: "wa-js",
      bridgeVersion: "4.7.2",
      authenticated: isAuth,
      streamMode: getStreamMode(),
    },
  });

  sendAuthState();

  // Listen for auth/stream events if supported
  if (WPP.conn?.on) {
    try {
      WPP.conn.on("stream.change", sendAuthState);
      WPP.conn.on("auth.change", sendAuthState);
    } catch {
      // Ignored
    }
  }

  async function toInboundObserved(msg: any): Promise<InboundObserved | null> {
    if (!msg) return null;
    const waMessageId = readWaMessageId(msg);
    if (!waMessageId) return null;

    const chatJid = serializedWid(msg.chat) || serializedWid(msg.from) || serializedWid(msg.id?.remote);
    if (!chatJid) return null;

    const chatKind = classifyChatKind(chatJid);
    if (chatKind !== "direct") return null;

    const waTimestampMs = typeof msg.timestamp === "number" ? msg.timestamp * 1000 : Date.now();
    const now = Date.now();
    if (now - waTimestampMs > 120_000) return null;

    // Bridge ready for >= 15s and not SYNCING
    if (now - readyTimestamp < 15_000) return null;
    const streamMode = getStreamMode();
    if (streamMode === "SYNCING") return null;

    const rawBody = typeof msg.body === "string" ? msg.body : typeof msg.caption === "string" ? msg.caption : "";
    const body = rawBody.trim();
    if (body.length < 1 || body.length > 4096) return null;

    const fromMe = Boolean(msg.fromMe);

    let senderLid: string | null = null;
    let senderJid: string | null = null;
    let senderPhoneUser: string | null = null;

    const helperArg = pnLidArg(chatJid);
    if (helperArg && WPP.contact?.getPnLidEntry) {
      try {
        const entry = await WPP.contact.getPnLidEntry(helperArg);
        if (entry) {
          senderLid = entry.lid?._serialized || null;
          senderJid = entry.phoneNumber?._serialized || null;
          senderPhoneUser = entry.phoneNumber?.id || null;
        }
      } catch {
        // Ignored if invalid_wid
      }
    }

    return {
      waMessageId,
      chatJid,
      senderJid,
      senderLid,
      senderPhoneUser,
      fromMe,
      body,
      waTimestampMs,
      chatKind,
    };
  }

  const onNewMessage = async (msg: any) => {
    // Cheap "something changed" ping so the overlay's stage list refreshes previews/unread.
    try {
      port.postMessage({ source: "leaddesk-page", version: 1, type: "leaddesk.bridge.chatActivity", payload: {} });
    } catch {
      // port closed
    }
    let observed: InboundObserved | null = null;
    try {
      observed = await toInboundObserved(msg);
    } catch (e) {
      console.warn("[Lead Desk Bridge] Inbound mapping failed", e);
    }
    if (!observed) return;
    port.postMessage({
      source: "leaddesk-page",
      version: 1,
      type: "leaddesk.bridge.inbound",
      payload: observed,
    });
  };
  try {
    if (typeof WPP.on === "function") {
      WPP.on("chat.new_message", onNewMessage);
    } else if (typeof WPP.ev?.on === "function") {
      WPP.ev.on("chat.new_message", onNewMessage);
    } else if (typeof WPP.chat?.on === "function") {
      WPP.chat.on("chat.new_message", onNewMessage);
    } else {
      console.warn("[Lead Desk Bridge] No chat.new_message listener on this WhatsApp build.");
    }
  } catch (e) {
    console.warn("[Lead Desk Bridge] Failed to subscribe to chat.new_message", e);
  }

  // Active chat reporting for the CRM overlay. Runs in every tab where the bridge is ready
  // (not only the elected sender tab) and is read-only: it never sends or marks anything.
  let activeChatSeq = 0;
  const emitActiveChat = async (chat: unknown) => {
    const seq = ++activeChatSeq;
    let info: ActiveChatInfo;
    try {
      info = await describeChat(WPP, chat);
    } catch {
      info = { chatJid: null, kind: null, name: null, phoneUser: null, lid: null };
    }
    if (seq !== activeChatSeq) return; // a newer chat change superseded this lookup
    port.postMessage({
      source: "leaddesk-page",
      version: 1,
      type: "leaddesk.bridge.activeChat",
      payload: info,
    });
  };
  try {
    if (typeof WPP.on === "function") {
      WPP.on("chat.active_chat", (chat: unknown) => {
        void emitActiveChat(chat);
      });
    }
  } catch (e) {
    console.warn("[Lead Desk Bridge] Failed to subscribe to chat.active_chat", e);
  }
  try {
    void emitActiveChat(WPP.chat?.getActiveChat?.() ?? null);
  } catch {
    void emitActiveChat(null);
  }

  // Handle commands from content script
  port.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || msg.source !== "leaddesk-content" || msg.version !== 1) return;

    if (msg.type === "leaddesk.command.ping") {
      port.postMessage({
        source: "leaddesk-page",
        version: 1,
        type: "leaddesk.bridge.pong",
        requestId: msg.requestId,
        payload: { ready: true },
      });
      return;
    }

    if (msg.type === "leaddesk.command.resolve") {
      const resolved = await resolveSendWid(msg.payload?.toE164);
      port.postMessage({
        source: "leaddesk-page",
        version: 1,
        type: "leaddesk.bridge.resolveResult",
        requestId: msg.requestId,
        payload: resolved,
      });
      return;
    }

    if (msg.type === "leaddesk.command.openChat") {
      let result: OpenChatResult;
      try {
        result = await openChat(WPP, msg.payload?.jid);
      } catch (err: any) {
        result = { ok: false, errorClass: "open_failed", detail: String(err?.message || err).slice(0, 300) };
      }
      port.postMessage({
        source: "leaddesk-page",
        version: 1,
        type: "leaddesk.bridge.openChatResult",
        requestId: msg.requestId,
        payload: result,
      });
      return;
    }

    if (msg.type === "leaddesk.command.setChatFilter") {
      // Run filter changes strictly in order: a slow "filter to stage" must never finish after
      // a later "show all chats" and leave WhatsApp's list filtered.
      const run = filterChain.then(() => applyChatFilter(WPP, msg.payload?.items ?? null));
      filterChain = run.catch(() => undefined);
      let payload: ChatFilterResult;
      try {
        payload = await run;
      } catch (err: any) {
        payload = { ok: false, detail: String(err?.message || err).slice(0, 200) };
      }
      port.postMessage({
        source: "leaddesk-page",
        version: 1,
        type: "leaddesk.bridge.chatFilterResult",
        requestId: msg.requestId,
        payload,
      });
      return;
    }

    if (msg.type === "leaddesk.command.chatFilterKeepalive") {
      touchChatFilter(WPP);
      return;
    }

    if (msg.type === "leaddesk.command.chatSummaries") {
      let payload: ChatSummary[] = [];
      try {
        payload = await summarizeChats(WPP, msg.payload?.items);
      } catch {
        payload = [];
      }
      port.postMessage({
        source: "leaddesk-page",
        version: 1,
        type: "leaddesk.bridge.chatSummariesResult",
        requestId: msg.requestId,
        payload,
      });
      return;
    }

    if (msg.type === "leaddesk.command.sendText") {
      const { outboundId, toJid, body } = msg.payload;
      const sendResult = await executeSend(toJid, body);
      port.postMessage({
        source: "leaddesk-page",
        version: 1,
        type: "leaddesk.bridge.sendResult",
        requestId: msg.requestId,
        payload: sendResult,
      });
    }
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 200) : null;
}

/** Map a wa-js ChatModel to the overlay payload; phone/lid resolved like the inbound path. */
async function describeChat(WPP: any, chat: any): Promise<ActiveChatInfo> {
  const chatJid = chat ? serializedWid(chat.id) : null;
  if (!chatJid) return { chatJid: null, kind: null, name: null, phoneUser: null, lid: null };
  const kind = classifyChatKind(chatJid);
  let name: string | null = null;
  try {
    name =
      textOrNull(chat.formattedTitle) ||
      textOrNull(chat.name) ||
      textOrNull(chat.contact?.name) ||
      textOrNull(chat.contact?.pushname) ||
      textOrNull(chat.contact?.formattedName);
  } catch {
    name = null;
  }
  if (kind !== "direct") return { chatJid, kind, name, phoneUser: null, lid: null };

  let lid: string | null = chatJid.endsWith("@lid") ? chatJid : null;
  let phoneUser: string | null = /@(c\.us|s\.whatsapp\.net)$/.test(chatJid) ? chatJid.slice(0, chatJid.indexOf("@")) : null;
  const helperArg = pnLidArg(chatJid);
  if (helperArg && WPP.contact?.getPnLidEntry) {
    const entry: any = await withTimeout(
      Promise.resolve().then(() => WPP.contact.getPnLidEntry(helperArg)),
      5_000,
      null
    );
    if (entry) {
      lid = entry.lid?._serialized || lid;
      phoneUser = entry.phoneNumber?.id || phoneUser;
      if (!name) {
        name = textOrNull(entry.contact?.name) || textOrNull(entry.contact?.pushname) || textOrNull(entry.contact?.verifiedName);
      }
    }
  }
  if (phoneUser && !/^\d{5,20}$/.test(phoneUser)) phoneUser = null;
  return { chatJid, kind, name, phoneUser, lid };
}

const OPEN_CHAT_JID = /^[0-9A-Za-z.:_-]{1,64}@(c\.us|s\.whatsapp\.net|lid)$/;

// ---------- native chat-list filter (WPP.chat.setChatList) ----------
// wa-js keeps the filter in module state shared by every bridge in this page, so ownership is
// tracked on window: only the bridge that set it may clear it, and a watchdog clears it if the
// content script stops confirming it (extension reloaded, tab's overlay gone). Without that, a
// reload would leave WhatsApp showing a filtered list with no Lead Desk bar to undo it.
const FILTER_OWNER_KEY = "__leadDeskChatFilterOwner";
const FILTER_WATCHDOG_MS = 60_000;
const bridgeToken = Math.random().toString(36).slice(2);
let filterWatchdog: ReturnType<typeof setTimeout> | null = null;
let filterChain: Promise<unknown> = Promise.resolve();

function clearNativeFilter(WPP: any) {
  try {
    void Promise.resolve(WPP.chat?.setChatList?.("all")).catch(() => {});
  } catch {
    // ignore
  }
}

function resetStaleChatFilter(WPP: any) {
  const w = window as any;
  if (w[FILTER_OWNER_KEY] && w[FILTER_OWNER_KEY] !== bridgeToken) {
    w[FILTER_OWNER_KEY] = null;
    clearNativeFilter(WPP);
  }
}

function touchChatFilter(WPP: any) {
  if ((window as any)[FILTER_OWNER_KEY] !== bridgeToken) return;
  if (filterWatchdog) clearTimeout(filterWatchdog);
  filterWatchdog = setTimeout(() => {
    if ((window as any)[FILTER_OWNER_KEY] === bridgeToken) {
      (window as any)[FILTER_OWNER_KEY] = null;
      clearNativeFilter(WPP);
    }
  }, FILTER_WATCHDOG_MS);
}

function chatIdOf(chat: any): string | null {
  return chat ? serializedWid(chat.id) : null;
}

/** items=null clears the filter; otherwise WhatsApp's list shows only chats of these leads. */
async function applyChatFilter(WPP: any, rawItems: unknown): Promise<ChatFilterResult> {
  if (typeof WPP.chat?.setChatList !== "function") return { ok: false, detail: "setChatList unavailable" };
  if (rawItems === null) {
    if ((window as any)[FILTER_OWNER_KEY] === bridgeToken || (window as any)[FILTER_OWNER_KEY]) {
      (window as any)[FILTER_OWNER_KEY] = null;
      if (filterWatchdog) clearTimeout(filterWatchdog);
      await WPP.chat.setChatList("all");
    }
    return { ok: true, matchedKeys: [] };
  }
  if (!Array.isArray(rawItems)) return { ok: false, detail: "bad items" };
  const ids = new Set<string>();
  const matchedKeys: string[] = [];
  for (const item of rawItems.slice(0, 1000)) {
    const key = typeof item?.key === "string" ? item.key : "";
    const jids = cleanJids(item);
    for (const jid of jids) ids.add(jid);
    // Also add the id WhatsApp actually keys the chat by, so matching does not depend on
    // wa-js's lid<->phone cache being warm.
    const real = chatIdOf(findChatForJids(WPP, jids));
    if (real) {
      ids.add(real);
      if (key) matchedKeys.push(key);
    }
  }
  // An empty custom list is rejected by wa-js; use an id that can never match.
  const list = ids.size ? [...ids] : ["0@c.us"];
  await WPP.chat.setChatList("custom", list);
  (window as any)[FILTER_OWNER_KEY] = bridgeToken;
  touchChatFilter(WPP);
  return { ok: true, matchedKeys };
}

// Message types WhatsApp's chat list skips over when choosing the preview line.
const SILENT_TYPES = new Set([
  "e2e_notification",
  "notification",
  "notification_template",
  "gp2",
  "protocol",
  "call_log",
  "ciphertext",
  "debug",
  "unknown",
  "broadcast_notification",
  "biz_content_placeholder",
]);

/** Short preview text for a message model, like WhatsApp's own chat list. */
function messagePreview(msg: any): string | null {
  if (!msg) return null;
  const body = textOrNull(msg.body ?? msg.caption);
  if (msg.type === "chat") return body;
  const labels: Record<string, string> = {
    image: "📷 Photo",
    video: "🎥 Video",
    gif: "GIF",
    ptt: "🎤 Voice message",
    ptv: "🎥 Video message",
    audio: "🎵 Audio",
    document: "📄 Document",
    sticker: "Sticker",
    location: "📍 Location",
    vcard: "👤 Contact",
    multi_vcard: "👤 Contacts",
    poll_creation: "📊 Poll",
    revoked: "🚫 This message was deleted",
  };
  const label = labels[String(msg.type)];
  const caption = textOrNull(msg.caption);
  if (label && caption) return `${label.split(" ")[0]} ${caption}`;
  return label ?? body;
}

/** The newest message worth showing, walking back past system notices. */
function lastVisibleMessage(chat: any): any {
  try {
    const models: any[] = Array.isArray(chat?.msgs?._models) ? chat.msgs._models : [];
    for (let i = models.length - 1, seen = 0; i >= 0 && seen < 15; i--, seen++) {
      const m = models[i];
      if (m && !m.isNotification && !SILENT_TYPES.has(String(m.type))) return m;
    }
    if (!models.length && typeof chat?.msgs?.last === "function") return chat.msgs.last() ?? null;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Find the loaded chat for a lead, using only what is already in this browser: each known id,
 * then the lid that WhatsApp's local lid<->phone cache maps a phone id to.
 *
 * Deliberately never calls getPnLidEntry/queryExists here: on a cache miss those ask WhatsApp's
 * servers, and this runs for a whole stage on every refresh. Repeated bulk lookups are exactly
 * the kind of automated traffic that gets numbers restricted.
 */
function findChatForJids(WPP: any, jids: string[]): any {
  for (const jid of jids) {
    try {
      const chat = WPP.chat?.get?.(jid);
      if (chat) return chat;
    } catch {
      // invalid id for this build; try the next
    }
  }
  const phoneJid = jids.find((j) => j.endsWith("@c.us"));
  if (!phoneJid) return null;
  try {
    const wid = WPP.whatsapp?.WidFactory?.createWid?.(phoneJid);
    const lid = wid ? WPP.whatsapp?.lidPnCache?.getCurrentLid?.(wid) : null;
    const lidStr = lid ? String(lid._serialized ?? lid.toString?.() ?? "") : "";
    return lidStr ? WPP.chat?.get?.(lidStr) ?? null : null;
  } catch {
    return null;
  }
}

function cleanJids(item: any): string[] {
  return Array.isArray(item?.jids)
    ? item.jids.filter((j: unknown): j is string => typeof j === "string" && OPEN_CHAT_JID.test(j)).slice(0, 4)
    : [];
}

/** Read-only lookup of already-loaded chat models for the overlay's stage list. */
async function summarizeChats(WPP: any, rawItems: unknown): Promise<ChatSummary[]> {
  if (!Array.isArray(rawItems)) return [];
  const out: ChatSummary[] = [];
  for (const item of rawItems.slice(0, 300)) {
    const key = typeof item?.key === "string" ? item.key : "";
    const chat = findChatForJids(WPP, cleanJids(item));
    if (!chat) {
      out.push({ key, found: false, title: null, lastBody: null, lastAt: null, lastFromMe: false, unread: 0, picUrl: null });
      continue;
    }
    const last = lastVisibleMessage(chat);
    let picUrl: string | null = null;
    try {
      const thumb = chat.contact?.profilePicThumb ?? chat.contact?.profilePicThumbObj ?? null;
      const url = thumb?.eurl ?? thumb?.img ?? null;
      picUrl = typeof url === "string" && url.startsWith("https://") ? url : null;
    } catch {
      picUrl = null;
    }
    let title: string | null = null;
    try {
      title = textOrNull(chat.formattedTitle) || textOrNull(chat.name) || textOrNull(chat.contact?.name) || textOrNull(chat.contact?.pushname);
    } catch {
      title = null;
    }
    const tSec = Number(last?.t ?? chat.t);
    const unreadRaw = Number(chat.unreadCount);
    // -1 = "marked as unread" by the user: WhatsApp shows a dot without a number.
    const unread = Number.isFinite(unreadRaw) ? (unreadRaw > 0 ? unreadRaw : unreadRaw < 0 ? -1 : 0) : 0;
    out.push({
      key,
      found: true,
      title,
      lastBody: messagePreview(last),
      lastAt: Number.isFinite(tSec) && tSec > 0 ? tSec * 1000 : null,
      lastFromMe: Boolean(last?.id?.fromMe),
      unread,
      picUrl,
    });
  }
  return out;
}

/** Open a one-to-one chat in this tab. Prefers an existing chat model; otherwise opens by id. */
async function openChat(WPP: any, rawJid: unknown): Promise<OpenChatResult> {
  if (typeof rawJid !== "string" || !OPEN_CHAT_JID.test(rawJid)) {
    return { ok: false, errorClass: "invalid_recipient", detail: "Not a one-to-one WhatsApp id" };
  }
  if (typeof WPP.chat?.openChatBottom !== "function") {
    return { ok: false, errorClass: "bridge_not_ready", detail: "WhatsApp chat API is not ready" };
  }
  const jid = rawJid.endsWith("@s.whatsapp.net") ? `${rawJid.slice(0, rawJid.indexOf("@"))}@c.us` : rawJid;

  const candidates: string[] = [jid];
  if (WPP.contact?.getPnLidEntry) {
    const entry: any = await withTimeout(
      Promise.resolve().then(() => WPP.contact.getPnLidEntry(jid)),
      5_000,
      null
    );
    for (const wid of [entry?.lid?._serialized, entry?.phoneNumber?._serialized]) {
      if (typeof wid === "string" && wid && !candidates.includes(wid)) candidates.push(wid);
    }
  }

  // An already-loaded chat for any of the ids wins, so the operator lands on the real thread.
  let target = candidates.find((wid) => {
    try {
      return Boolean(WPP.chat?.get?.(wid));
    } catch {
      return false;
    }
  });
  // Otherwise prefer the lid (how current WhatsApp keys one-to-one chats), then the phone jid.
  if (!target) {
    target = candidates.find((wid) => wid.endsWith("@lid")) ?? candidates[candidates.length - 1] ?? jid;
    // No chat yet and only a phone number: make sure the number is on WhatsApp before opening.
    if (target.endsWith("@c.us") && typeof WPP.contact?.queryExists === "function") {
      const exists: any = await withTimeout(
        Promise.resolve().then(() => WPP.contact.queryExists(target)),
        8_000,
        undefined
      );
      if (exists === null) return { ok: false, errorClass: "not_on_whatsapp", detail: "This number is not on WhatsApp" };
      const wid = exists?.lid?._serialized ?? exists?.wid?._serialized;
      if (typeof wid === "string" && OPEN_CHAT_JID.test(wid)) target = wid;
    }
  }

  const opened = await WPP.chat.openChatBottom(target);
  if (opened === false) {
    return { ok: false, errorClass: "open_failed", detail: "WhatsApp did not open the chat" };
  }
  return { ok: true, jid: target };
}

async function resolveSendWid(toE164: unknown): Promise<
  | { ok: true; toJid: string; phoneJid: string | null }
  | { ok: false; errorClass: string; transient: boolean; detail: string }
> {
  const digits = typeof toE164 === "string" ? toE164.replace(/\D/g, "") : "";
  if (!digits) {
    return { ok: false, errorClass: "invalid_recipient", transient: false, detail: "Phone number has no digits" };
  }

  const WPP = (window as any).WPP;
  if (!WPP?.contact?.getPnLidEntry) {
    return { ok: false, errorClass: "bridge_not_ready", transient: true, detail: "WhatsApp contact lookup is not ready" };
  }

  try {
    const entry = await WPP.contact.getPnLidEntry(`${digits}@c.us`);
    const phoneJid = typeof entry?.phoneNumber?._serialized === "string" ? entry.phoneNumber._serialized : null;
    const wid = entry?.lid?._serialized || phoneJid || null;
    if (typeof wid !== "string" || wid.length === 0) {
      return { ok: false, errorClass: "not_on_whatsapp", transient: false, detail: "Number is not on WhatsApp" };
    }
    return { ok: true, toJid: wid, phoneJid };
  } catch (err: any) {
    const code = err?.code || err?.name;
    if (code === "invalid_wid") {
      return { ok: false, errorClass: "invalid_recipient", transient: false, detail: "invalid_wid" };
    }
    return {
      ok: false,
      errorClass: "lookup_failed",
      transient: true,
      detail: String(err?.message || err).slice(0, 300),
    };
  }
}

async function executeSend(toJid: string, body: string): Promise<SendResult> {
  const WPP = (window as any).WPP;
  let rawResult: unknown;

  try {
    rawResult = await WPP.chat.sendTextMessage(toJid, body, SEND_OPTIONS);
  } catch (err: any) {
    return {
      ok: false,
      outcome: "uncertain",
      errorClass: "bridge_threw",
      detail: String(err?.message || err),
    };
  }

  const waMessageId = readWaMessageId(rawResult);
  if (!waMessageId) {
    return {
      ok: false,
      outcome: "uncertain",
      errorClass: "missing_id",
      detail: "sendTextMessage resolved with no readable message id",
    };
  }

  return {
    ok: true,
    waMessageId,
    toJid,
  };
}
