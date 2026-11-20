import type { ActiveChatInfo, ChatFilterResult, ChatLookupItem, ChatSummary, OpenChatResult } from "@leaddesk/shared";
import { startOverlay, type OverlayController } from "./overlay/index.js";

let heldPort: MessagePort | null = null;
let assignedRole: "sender" | "standby" = "standby";
const pendingResolve = new Map<string, (payload: unknown) => void>();
const pendingOpenChat = new Map<string, (payload: OpenChatResult) => void>();
let openChatCounter = 0;
const pendingSummaries = new Map<string, (payload: ChatSummary[]) => void>();
const pendingFilter = new Map<string, (payload: ChatFilterResult) => void>();
// True while WhatsApp's own chat list is filtered by us. The page bridge clears the filter by
// itself unless this script keeps confirming it, so a dead content script cannot leave it stuck.
let chatFilterActive = false;
// CRM overlay (top stage bar + lead panel). Created at start; never blocks the port handshake.
let overlay: OverlayController | null = null;
// Bridge state, re-reported on every tick so a restarted service worker can rebuild its tab map.
let bridgeReady = false;
let bridgeAuthenticated = false;
let lastAuth: Record<string, unknown> | null = null;

// 1. One-shot handshake listener on window
function setupPortHandshake() {
  const onWindowMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== "https://web.whatsapp.com") return;
    if (event.data?.source !== "leaddesk-page" || event.data?.type !== "leaddesk.port") return;
    if (!event.ports || event.ports.length !== 1) return;

    // Accept port once
    heldPort = event.ports[0]!;
    window.removeEventListener("message", onWindowMessage);

    // Listen on held port
    heldPort.onmessage = (portEvent) => {
      const msg = portEvent.data;
      if (!msg || msg.source !== "leaddesk-page" || msg.version !== 1) return;

      if (msg.type === "leaddesk.bridge.ready") {
        bridgeReady = true;
        overlay?.setBridge("ready");
        bridgeAuthenticated = Boolean(msg.payload?.authenticated);
        chrome.runtime.sendMessage({
          channel: "leaddesk",
          type: "leaddesk.tab.hello",
          payload: {
            ready: true,
            authenticated: bridgeAuthenticated,
            href: location.href,
          },
        }).catch(() => {});
      } else if (msg.type === "leaddesk.bridge.auth") {
        bridgeAuthenticated = Boolean(msg.payload?.authenticated);
        lastAuth = msg.payload ?? null;
        if (msg.payload?.streamMode === "foreign_bridge") overlay?.setBridge("foreign");
        chrome.runtime.sendMessage({
          channel: "leaddesk",
          type: "leaddesk.tab.auth",
          payload: msg.payload,
        }).catch(() => {});
      } else if (msg.type === "leaddesk.bridge.sendResult") {
        chrome.runtime.sendMessage({
          channel: "leaddesk",
          type: "leaddesk.tab.sendResult",
          requestId: msg.requestId,
          payload: msg.payload,
        }).catch(() => {});
      } else if (msg.type === "leaddesk.bridge.inbound") {
        chrome.runtime.sendMessage({
          channel: "leaddesk",
          type: "leaddesk.tab.inbound",
          payload: msg.payload,
        }).catch(() => {});
      } else if (msg.type === "leaddesk.bridge.activeChat") {
        if (msg.payload && typeof msg.payload === "object") {
          overlay?.setActiveChat(msg.payload as ActiveChatInfo);
        }
      } else if (msg.type === "leaddesk.bridge.openChatResult") {
        const done = pendingOpenChat.get(msg.requestId);
        if (done) {
          pendingOpenChat.delete(msg.requestId);
          done(msg.payload as OpenChatResult);
        }
      } else if (msg.type === "leaddesk.bridge.chatFilterResult") {
        const done = pendingFilter.get(msg.requestId);
        if (done) {
          pendingFilter.delete(msg.requestId);
          const p = msg.payload as ChatFilterResult | undefined;
          done(p && typeof p.ok === "boolean" ? p : { ok: false, detail: "bad reply" });
        }
      } else if (msg.type === "leaddesk.bridge.chatActivity") {
        overlay?.chatActivity();
      } else if (msg.type === "leaddesk.bridge.chatSummariesResult") {
        const done = pendingSummaries.get(msg.requestId);
        if (done) {
          pendingSummaries.delete(msg.requestId);
          done(Array.isArray(msg.payload) ? (msg.payload as ChatSummary[]) : []);
        }
      } else if (msg.type === "leaddesk.bridge.resolveResult") {
        const done = pendingResolve.get(msg.requestId);
        if (done) {
          pendingResolve.delete(msg.requestId);
          done(msg.payload);
        }
      }
    };

    // Ping bridge to confirm communication
    heldPort.postMessage({
      source: "leaddesk-content",
      version: 1,
      type: "leaddesk.command.ping",
      requestId: "init_ping",
    });
  };

  window.addEventListener("message", onWindowMessage);
}

/** Ask the page bridge to open a chat in this tab (used by the overlay's stage lists). */
function openChatViaBridge(jid: string): Promise<OpenChatResult> {
  return new Promise((resolve) => {
    if (!heldPort || !bridgeReady) {
      resolve({ ok: false, errorClass: "bridge_not_ready", detail: "WhatsApp is still loading" });
      return;
    }
    const requestId = `open_${Date.now().toString(36)}_${++openChatCounter}`;
    let settled = false;
    const finish = (payload: OpenChatResult) => {
      if (settled) return;
      settled = true;
      pendingOpenChat.delete(requestId);
      resolve(payload);
    };
    pendingOpenChat.set(requestId, finish);
    try {
      heldPort.postMessage({
        source: "leaddesk-content",
        version: 1,
        type: "leaddesk.command.openChat",
        requestId,
        payload: { jid },
      });
    } catch {
      finish({ ok: false, errorClass: "bridge_not_ready", detail: "Bridge not connected" });
      return;
    }
    setTimeout(() => finish({ ok: false, errorClass: "timeout", detail: "WhatsApp did not respond" }), 10_000);
  });
}

/** Ask the page bridge what WhatsApp already shows for these chats (preview, time, unread). */
/** Filter WhatsApp's own chat list to these leads' chats; null shows every chat again. */
function setChatFilterViaBridge(items: ChatLookupItem[] | null): Promise<ChatFilterResult> {
  return new Promise((resolve) => {
    if (!heldPort || !bridgeReady) {
      if (items === null) chatFilterActive = false;
      resolve({ ok: false, detail: "WhatsApp is still loading" });
      return;
    }
    const requestId = `flt_${Date.now().toString(36)}_${++openChatCounter}`;
    let settled = false;
    const finish = (payload: ChatFilterResult) => {
      if (settled) return;
      settled = true;
      pendingFilter.delete(requestId);
      if (items === null) chatFilterActive = false;
      else if (payload.ok) chatFilterActive = true;
      resolve(payload);
    };
    pendingFilter.set(requestId, finish);
    try {
      heldPort.postMessage({
        source: "leaddesk-content",
        version: 1,
        type: "leaddesk.command.setChatFilter",
        requestId,
        payload: { items },
      });
    } catch {
      finish({ ok: false, detail: "Bridge not connected" });
      return;
    }
    setTimeout(() => finish({ ok: false, detail: "WhatsApp did not respond" }), 10_000);
  });
}

setInterval(() => {
  if (!chatFilterActive || !heldPort) return;
  try {
    heldPort.postMessage({ source: "leaddesk-content", version: 1, type: "leaddesk.command.chatFilterKeepalive" });
  } catch {
    chatFilterActive = false;
  }
}, 20_000);

function chatSummariesViaBridge(items: ChatLookupItem[]): Promise<ChatSummary[]> {
  return new Promise((resolve) => {
    if (!heldPort || !bridgeReady || items.length === 0) {
      resolve([]);
      return;
    }
    const requestId = `sum_${Date.now().toString(36)}_${++openChatCounter}`;
    let settled = false;
    const finish = (payload: ChatSummary[]) => {
      if (settled) return;
      settled = true;
      pendingSummaries.delete(requestId);
      resolve(payload);
    };
    pendingSummaries.set(requestId, finish);
    try {
      heldPort.postMessage({
        source: "leaddesk-content",
        version: 1,
        type: "leaddesk.command.chatSummaries",
        requestId,
        payload: { items },
      });
    } catch {
      finish([]);
      return;
    }
    setTimeout(() => finish([]), 8_000);
  });
}

// 2. Wait for #pane-side, then 5 seconds, then request injection
function waitForPaneSideAndInject() {
  const startTime = Date.now();
  const checkInterval = setInterval(() => {
    const pane = document.querySelector("#pane-side");
    if (pane) {
      clearInterval(checkInterval);
      console.debug("[Lead Desk] WhatsApp UI #pane-side detected. Waiting 5s before injection...");
      setTimeout(() => {
        setupPortHandshake();
        chrome.runtime.sendMessage({
          channel: "leaddesk",
          type: "leaddesk.tab.requestInjection",
        }).catch(() => {});
      }, 5000);
      return;
    }

    if (Date.now() - startTime > 60_000) {
      clearInterval(checkInterval);
      console.warn("[Lead Desk] #pane-side not found after 60s. Will retry checking periodically.");
      // Retry every 15s as per architecture
      setTimeout(waitForPaneSideAndInject, 15_000);
    }
  }, 500);
}

// 3. Periodic 5-second tick loop
function startTickLoop() {
  setInterval(() => {
    chrome.runtime.sendMessage({
      channel: "leaddesk",
      type: "leaddesk.tab.tick",
      payload: {
        ready: bridgeReady,
        authenticated: bridgeAuthenticated,
        href: location.href,
        auth: lastAuth,
      },
    }).catch(() => {});
  }, 5000);
}

// 4. Runtime listener from service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel !== "leaddesk") return;

  if (message.type === "leaddesk.crm.pairingChanged") {
    overlay?.pairingChanged();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "leaddesk.worker.assign") {
    assignedRole = message.payload?.role || "standby";
    console.debug("[Lead Desk] Tab role assigned:", assignedRole);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "leaddesk.worker.resolve") {
    if (!heldPort || !bridgeReady) {
      sendResponse({
        ok: false,
        errorClass: "bridge_not_ready",
        transient: true,
        detail: "Bridge not connected.",
      });
      return;
    }
    const requestId = message.requestId as string;
    let settled = false;
    const finish = (payload: unknown) => {
      if (settled) return;
      settled = true;
      pendingResolve.delete(requestId);
      sendResponse(payload);
    };
    pendingResolve.set(requestId, finish);
    heldPort.postMessage({
      source: "leaddesk-content",
      version: 1,
      type: "leaddesk.command.resolve",
      requestId,
      payload: message.payload,
    });
    setTimeout(() => {
      finish({
        ok: false,
        errorClass: "lookup_failed",
        transient: true,
        detail: "WhatsApp lookup timed out",
      });
    }, 15_000);
    return true;
  }

  if (message.type === "leaddesk.worker.sendText") {
    if (!heldPort || !bridgeReady) {
      // Not posted to the bridge, so sendTextMessage was never entered: the worker may fail it.
      sendResponse({
        ok: false,
        errorClass: "bridge_not_ready",
        transient: true,
        detail: "Bridge not connected.",
      });
      return;
    }
    heldPort.postMessage({
      source: "leaddesk-content",
      version: 1,
      type: "leaddesk.command.sendText",
      requestId: message.requestId,
      payload: message.payload,
    });
    sendResponse({ ok: true });
  }
});

// Start if on WhatsApp Web
if (location.href.startsWith("https://web.whatsapp.com/")) {
  startTickLoop();
  // Overlay first, but isolated: any failure inside it must not stop injection or the tick loop.
  try {
    overlay = startOverlay({ openChat: openChatViaBridge, chatSummaries: chatSummariesViaBridge, setChatFilter: setChatFilterViaBridge });
  } catch (err) {
    console.warn("[Lead Desk] overlay failed to start", err);
  }
  if (document.readyState === "complete") {
    waitForPaneSideAndInject();
  } else {
    window.addEventListener("load", () => {
      waitForPaneSideAndInject();
    });
  }
}
