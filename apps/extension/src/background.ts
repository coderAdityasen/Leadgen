import { isLoopbackOrigin, originPattern, parseServerOrigin } from "./serverOrigin.js";
import {
  type TabRecord,
  isTabEligible,
  computeHasEligibleTab,
  electSenderTab,
} from "./tabElection.js";
import {
  type OutboxRecord,
  classifyChatKind,
  toInboundWire,
  type InboundObserved,
  type CrmRequest,
  type CrmResponse,
  type CrmStatus,
} from "@leaddesk/shared";

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";
const FETCH_TIMEOUT_MS = 10_000;
/** A "sending" record younger than this may still get a sendResult; do not mark it uncertain yet. */
const SENDING_STALE_MS = 60_000;
/** Minimum spacing for non-urgent lease calls (ticks/heartbeats while standby or grace). */
const LEASE_MIN_INTERVAL_MS = 10_000;
/** Delay before the first lease call after start, so tabs can report in first (worker restart). */
const INITIAL_LEASE_DELAY_MS = 6_000;
const PENDING_INBOUND_MAX = 200;
const PENDING_INBOUND_MAX_AGE_MS = 10 * 60_000;
// 1x1 PNG: chrome.notifications requires an icon and the extension ships none.
const NOTIFICATION_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

interface ExtensionState {
  deviceToken: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  serverUrl: string;
  lastRole: "sender" | "grace" | "standby" | null;
  lastLeaseUntil: number | null;
  ownJid: string | null;
  pushName: string | null;
  streamMode: string | null;
  authenticated: boolean;
}

const state: ExtensionState = {
  deviceToken: null,
  deviceId: null,
  deviceLabel: null,
  serverUrl: DEFAULT_SERVER_URL,
  lastRole: null,
  lastLeaseUntil: null,
  ownJid: null,
  pushName: null,
  streamMode: null,
  authenticated: false,
};

interface AuthPayload {
  authenticated?: unknown;
  streamMode?: unknown;
  ownJid?: unknown;
  pushName?: unknown;
}

const tabs = new Map<number, TabRecord>();
let currentSenderTabId: number | null = null;
let renewTimer: ReturnType<typeof setTimeout> | null = null;
let initialLeaseTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let claimTimer: ReturnType<typeof setInterval> | null = null;
let isRenewLoopRunning = false;
let lastSendTimestamp = 0;

// Single-flight guards
let claimInFlight = false;
let leaseInFlight = false;
let leasePendingSenderTab: boolean | null = null;
let lastLeaseCallAt = 0;
let leaseSeq = 0;

// Inbound held while identity is unknown or after a failed POST
interface PendingInbound {
  observed: InboundObserved;
  firstSeenAt: number;
}
const pendingInbound: PendingInbound[] = [];
const inboundInFlight = new Set<string>();
let inboundFlushRunning = false;

// === SERIALIZED STORAGE ===
let storageChain: Promise<unknown> = Promise.resolve();
function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storageChain.then(fn, fn);
  storageChain = run.catch(() => {});
  return run;
}

async function loadConfig() {
  const data = (await chrome.storage.local.get([
    "leaddesk.deviceToken",
    "leaddesk.deviceId",
    "leaddesk.deviceLabel",
    "leaddesk.serverUrl",
  ])) as Record<string, any>;
  state.deviceToken = (data["leaddesk.deviceToken"] as string) || null;
  state.deviceId = (data["leaddesk.deviceId"] as string) || null;
  state.deviceLabel = (data["leaddesk.deviceLabel"] as string) || null;
  state.serverUrl = (data["leaddesk.serverUrl"] as string) || DEFAULT_SERVER_URL;
}

function updateBadge() {
  if (!state.deviceToken) {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setBadgeBackgroundColor({ color: "#666666" });
    return;
  }
  if (state.lastRole === "sender") {
    chrome.action.setBadgeText({ text: "SEND" });
    chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  } else if (state.lastRole === "grace") {
    chrome.action.setBadgeText({ text: "GRC" });
    chrome.action.setBadgeBackgroundColor({ color: "#eab308" });
  } else {
    chrome.action.setBadgeText({ text: "STBY" });
    chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
  }
}

/** Idempotent: the token is cleared synchronously, so concurrent 401s run this once. Outbox is kept. */
async function handleUnpair(notify = true) {
  if (!state.deviceToken) return;
  stopLoops();
  state.deviceToken = null;
  state.deviceId = null;
  state.lastRole = null;
  state.lastLeaseUntil = null;
  currentSenderTabId = null;
  pendingInbound.length = 0;
  updateBadge();
  notifyCrmTabs();

  try {
    await chrome.storage.local.remove([
      "leaddesk.deviceToken",
      "leaddesk.deviceId",
      "leaddesk.deviceLabel",
    ]);
  } catch (err) {
    console.warn("[Lead Desk] Failed to clear device token:", err);
  }

  if (notify) {
    try {
      chrome.notifications.create(
        {
          type: "basic",
          iconUrl: NOTIFICATION_ICON,
          title: "Lead Desk",
          message: "This browser was signed out and must be paired again.",
          priority: 1,
        },
        () => void chrome.runtime.lastError,
      );
    } catch {
      // Notification failure must not break unpair
    }
  }
}

function stopLoops() {
  if (renewTimer) {
    clearTimeout(renewTimer);
    renewTimer = null;
  }
  if (initialLeaseTimer) {
    clearTimeout(initialLeaseTimer);
    initialLeaseTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (claimTimer) {
    clearInterval(claimTimer);
    claimTimer = null;
  }
  isRenewLoopRunning = false;
  leasePendingSenderTab = null;
  leaseSeq++; // invalidate any in-flight lease response
}

function startLoops() {
  stopLoops();
  if (!state.deviceToken) return;

  heartbeatTimer = setInterval(callHeartbeat, 10_000);
  claimTimer = setInterval(checkAndClaim, 5_000);

  // Do not send senderTab:false straight away: after a worker restart the tab map is empty
  // until the tabs tick, and a false here would push a held lease into grace.
  const hasEligible = computeHasEligibleTab(tabs.values(), Date.now());
  if (hasEligible) {
    requestLease(true, true);
  } else {
    initialLeaseTimer = setTimeout(() => {
      initialLeaseTimer = null;
      if (lastLeaseCallAt === 0) {
        requestLease(computeHasEligibleTab(tabs.values(), Date.now()), true);
      }
    }, INITIAL_LEASE_DELAY_MS);
  }
}

// === HTTP ===
async function apiFetch(path: string, body: unknown): Promise<Response> {
  return fetch(`${state.serverUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.deviceToken}`,
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// === WHATSAPP CRM OVERLAY ===
// The overlay in the content script asks the worker; the worker adds the bearer token and
// returns only the server's JSON. The token never leaves this worker.
const CRM_BASE = "/api/v1/extension/crm";
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isWhatsAppContentSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (!sender.tab || sender.tab.id == null) return false;
  const url = sender.url ?? sender.tab.url ?? "";
  if (!url.startsWith("https://web.whatsapp.com/")) return false;
  if (sender.origin != null && sender.origin !== "https://web.whatsapp.com") return false;
  return true;
}

function crmStatus(): CrmStatus {
  return { paired: Boolean(state.deviceToken), serverOrigin: state.deviceToken ? state.serverUrl : null };
}

/** Tell WhatsApp tabs that pairing changed so the overlay refreshes (no token in the message). */
function notifyCrmTabs() {
  try {
    chrome.tabs.query({ url: "https://web.whatsapp.com/*" }, (found) => {
      void chrome.runtime.lastError;
      for (const tab of found ?? []) {
        if (tab.id == null) continue;
        chrome.tabs
          .sendMessage(tab.id, { channel: "leaddesk", type: "leaddesk.crm.pairingChanged" })
          .catch(() => {});
      }
    });
  } catch {
    // Tabs API failure must not break pairing state changes
  }
}

const optStr = (v: unknown, max = 500): string | undefined =>
  typeof v === "string" && v.length <= max ? v : undefined;

function pick(src: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

type CrmCall = { method: "GET" | "POST" | "PATCH"; path: string; body?: unknown; headers?: Record<string, string> };

function buildCrmCall(req: CrmRequest): CrmCall | string {
  const p = (req.params && typeof req.params === "object" ? req.params : {}) as Record<string, unknown>;
  const leadId = optStr(p["leadId"], 64);
  const leadPath = () => (leadId && SAFE_ID.test(leadId) ? encodeURIComponent(leadId) : null);
  switch (req.op) {
    case "board": {
      const qs = new URLSearchParams();
      const stageId = optStr(p["stageId"], 64);
      const q = optStr(p["q"], 200);
      if (stageId) qs.set("stageId", stageId);
      if (q) qs.set("q", q);
      const tail = qs.toString();
      return { method: "GET", path: `${CRM_BASE}/board${tail ? `?${tail}` : ""}` };
    }
    case "contact": {
      const qs = new URLSearchParams();
      for (const k of ["chatJid", "lid", "phoneUser"]) {
        const v = optStr(p[k], 128);
        if (v) qs.set(k, v);
      }
      return { method: "GET", path: `${CRM_BASE}/contact?${qs.toString()}` };
    }
    case "createLead":
      return {
        method: "POST",
        path: `${CRM_BASE}/leads`,
        body: pick(p, ["chatJid", "lid", "phoneUser", "displayName", "stageId", "notes"]),
      };
    case "updateLead": {
      const id = leadPath();
      if (!id) return "leadId is required.";
      const patch = (p["patch"] && typeof p["patch"] === "object" ? p["patch"] : {}) as Record<string, unknown>;
      return {
        method: "PATCH",
        path: `${CRM_BASE}/leads/${id}`,
        body: pick(patch, [
          "displayName",
          "notes",
          "stageId",
          "aiEnabled",
          "automationPaused",
          "doNotMessage",
          "email",
          "company",
        ]),
      };
    }
    case "enroll": {
      const id = leadPath();
      if (!id) return "leadId is required.";
      const key = optStr(p["idempotencyKey"], 100);
      return {
        method: "POST",
        path: `${CRM_BASE}/leads/${id}/enroll`,
        body: { sequenceId: p["sequenceId"] },
        headers: key && /^[A-Za-z0-9_-]+$/.test(key) ? { "Idempotency-Key": key } : undefined,
      };
    }
    case "cancelEnrollment": {
      const id = leadPath();
      if (!id) return "leadId is required.";
      return { method: "POST", path: `${CRM_BASE}/leads/${id}/enrollment/cancel`, body: {} };
    }
    default:
      return "Unknown CRM operation.";
  }
}

async function handleCrmRequest(req: CrmRequest | undefined): Promise<CrmResponse> {
  await configLoaded.catch(() => {});
  if (!req || typeof req !== "object") {
    return { ok: false, status: 400, error: { code: "validation", message: "Bad CRM request." } };
  }
  const call = buildCrmCall(req);
  if (typeof call === "string") return { ok: false, status: 400, error: { code: "validation", message: call } };
  if (!state.deviceToken) return { ok: false, status: 0, error: { code: "not_paired" } };

  let res: Response;
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${state.deviceToken}`, ...(call.headers ?? {}) };
    if (call.body !== undefined) headers["Content-Type"] = "application/json";
    res = await fetch(`${state.serverUrl}${call.path}`, {
      method: call.method,
      headers,
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: {
        code: timedOut ? "timeout" : "network",
        message: timedOut ? "Lead Desk server did not answer in time." : "Cannot reach the Lead Desk server.",
      },
    };
  }

  if (isAuthFailure(res)) {
    await handleUnpair();
    return { ok: false, status: res.status, error: { code: "not_paired" } };
  }
  const data: any = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data };
  const error = data?.error && typeof data.error === "object" ? data.error : {};
  return {
    ok: false,
    status: res.status,
    error: {
      code: typeof error.code === "string" ? error.code : `http_${res.status}`,
      message: typeof error.message === "string" ? error.message : `Request failed (${res.status}).`,
    },
  };
}

function isAuthFailure(res: Response): boolean {
  return res.status === 401 || res.status === 403;
}

// === OUTBOX STORAGE HELPERS ===
async function getOutbox(): Promise<Record<string, OutboxRecord>> {
  const data = (await chrome.storage.local.get("leaddesk.outbox")) as Record<string, any>;
  return (data["leaddesk.outbox"] as Record<string, OutboxRecord>) || {};
}

function setOutboxRecord(record: OutboxRecord): Promise<void> {
  return withStorageLock(async () => {
    const outbox = await getOutbox();
    outbox[record.outboundId] = record;
    await chrome.storage.local.set({ "leaddesk.outbox": outbox });
  });
}

function removeOutboxRecord(outboundId: string): Promise<void> {
  return withStorageLock(async () => {
    const outbox = await getOutbox();
    delete outbox[outboundId];
    await chrome.storage.local.set({ "leaddesk.outbox": outbox });
  });
}

// === HEARTBEAT & LEASE ===
async function callHeartbeat() {
  if (!state.deviceToken) return;

  try {
    const res = await apiFetch("/api/v1/extension/heartbeat", {
      extensionVersion: "0.1.0",
      bridgeVersion: "4.7.2",
      ownJid: state.ownJid,
      pushName: state.pushName,
      streamMode: state.streamMode,
      authenticated: state.authenticated,
    });

    if (isAuthFailure(res)) {
      await handleUnpair();
      return;
    }

    if (res.ok) {
      const data = await res.json();
      const hasEligible = computeHasEligibleTab(tabs.values(), Date.now());
      if ((data.role === "sender" || data.role === "grace") && !isRenewLoopRunning) {
        requestLease(hasEligible);
      } else if (hasEligible && state.lastRole !== "sender" && !isRenewLoopRunning) {
        requestLease(true);
      }
    }
  } catch {
    // Network blip, retry next tick
  }

  void flushPendingInbound();
}

/**
 * Single-flight lease request. A call made while one is in flight is coalesced and
 * re-run afterwards with the latest senderTab value. Non-urgent calls are throttled.
 */
function requestLease(senderTab: boolean, urgent = false) {
  if (!state.deviceToken) return;
  if (leaseInFlight) {
    leasePendingSenderTab = senderTab || (leasePendingSenderTab ?? false);
    return;
  }
  if (!urgent && Date.now() - lastLeaseCallAt < LEASE_MIN_INTERVAL_MS) return;
  void callLease(senderTab);
}

async function callLease(senderTab: boolean) {
  if (!state.deviceToken) return;

  if (renewTimer) {
    clearTimeout(renewTimer);
    renewTimer = null;
  }

  leaseInFlight = true;
  lastLeaseCallAt = Date.now();
  const seq = ++leaseSeq;
  const token = state.deviceToken;

  try {
    const res = await apiFetch("/api/v1/extension/lease", { senderTab });
    if (seq !== leaseSeq || token !== state.deviceToken) return; // stale

    if (isAuthFailure(res)) {
      await handleUnpair();
      return;
    }

    if (!res.ok) {
      isRenewLoopRunning = false;
      return;
    }

    const data = (await res.json()) as {
      role: "sender" | "grace" | "standby";
      leaseUntil: string | null;
      holderDeviceId?: string | null;
    };
    if (seq !== leaseSeq || token !== state.deviceToken) return; // stale

    state.lastRole = data.role;
    state.lastLeaseUntil = data.leaseUntil ? new Date(data.leaseUntil).getTime() : null;
    updateBadge();
    reassignTabs();

    if (data.role === "sender" || data.role === "grace") {
      isRenewLoopRunning = true;
      renewTimer = setTimeout(() => {
        renewTimer = null;
        requestLease(computeHasEligibleTab(tabs.values(), Date.now()), true);
      }, 10_000);
    } else {
      isRenewLoopRunning = false;
      if (data.leaseUntil) {
        const waitMs = Math.max(new Date(data.leaseUntil).getTime() - Date.now(), 500);
        renewTimer = setTimeout(() => {
          renewTimer = null;
          requestLease(computeHasEligibleTab(tabs.values(), Date.now()), true);
        }, waitMs);
      }
    }
  } catch {
    if (seq === leaseSeq) isRenewLoopRunning = false;
  } finally {
    leaseInFlight = false;
    const pending = leasePendingSenderTab;
    leasePendingSenderTab = null;
    if (pending !== null && state.deviceToken) {
      requestLease(pending, true);
    }
  }
}

// === CLAIM & SEND DISPATCH ===
async function checkAndClaim() {
  if (claimInFlight) return;
  claimInFlight = true;
  try {
    await checkAndClaimOnce();
  } catch (err) {
    console.warn("[Lead Desk] Claim tick error:", err);
  } finally {
    claimInFlight = false;
  }
}

async function checkAndClaimOnce() {
  if (!state.deviceToken || state.lastRole !== "sender" || currentSenderTabId == null) {
    return;
  }

  const outbox = await getOutbox();
  const now = Date.now();
  let blocked = false;

  for (const rec of Object.values(outbox)) {
    if (!state.deviceToken) return;
    if (rec.phase === "submitted" && rec.waMessageId) {
      // A submitted record only retries ack; it does not block a different outbound.
      await retryAck(rec);
      continue;
    }
    if (rec.phase === "sending" && now - rec.updatedAt < SENDING_STALE_MS) {
      // The bridge may still answer; wait for its sendResult.
      blocked = true;
      continue;
    }
    // Stale "sending", "uncertain", or a malformed "submitted": uncertain only, never resend.
    if (rec.phase !== "uncertain") {
      await setOutboxRecord({ ...rec, phase: "uncertain", updatedAt: Date.now() });
    }
    const cleared = await retryUncertain(rec);
    if (!cleared) blocked = true;
  }

  if (blocked || !state.deviceToken) return;
  if (state.lastRole !== "sender" || currentSenderTabId == null) return;

  // Local floor check: at least 5s since last send
  if (Date.now() - lastSendTimestamp < 5000) return;

  try {
    const res = await apiFetch("/api/v1/extension/outbound/claim", {});

    if (isAuthFailure(res)) {
      await handleUnpair();
      return;
    }

    if (!res.ok) return;

    const data = await res.json();
    if (!data.item) return; // nothing to do

    const item = data.item as {
      outboundId: string;
      claimToken: string;
      toJid: string | null;
      toE164: string | null;
      body: string;
      needsResolve: boolean;
    };

    const senderTabId = currentSenderTabId;
    if (senderTabId == null) {
      await postFail(item.outboundId, item.claimToken, "bridge_not_ready", true, "No sender tab");
      return;
    }

    let toJid = item.toJid;
    let phoneJid: string | null = null;
    if (!toJid && item.needsResolve && item.toE164) {
      const resolved = await resolveOnTab(senderTabId, item.outboundId, item.toE164);
      if (!resolved.ok) {
        await postFail(
          item.outboundId,
          item.claimToken,
          resolved.errorClass,
          resolved.transient,
          resolved.detail,
        );
        return;
      }
      toJid = resolved.toJid;
      phoneJid = resolved.phoneJid;
    }

    if (!toJid) {
      await postFail(item.outboundId, item.claimToken, "invalid_recipient", false, "Missing toJid");
      return;
    }

    const kind = classifyChatKind(toJid);
    if (kind === "group" || kind === "broadcast" || kind === "other") {
      await postFail(item.outboundId, item.claimToken, "invalid_recipient", false, `Invalid chat kind: ${kind}`);
      return;
    }

    if (!item.body.trim()) {
      await postFail(item.outboundId, item.claimToken, "body_empty", false, "Empty message body");
      return;
    }

    // Write durable sending record before bridge call
    const record: OutboxRecord = {
      outboundId: item.outboundId,
      claimToken: item.claimToken,
      toJid,
      phoneJid,
      bodySha256: "",
      phase: "sending",
      waMessageId: null,
      updatedAt: Date.now(),
    };
    await setOutboxRecord(record);

    lastSendTimestamp = Date.now();

    let reply: { ok?: boolean; errorClass?: string; transient?: boolean; detail?: string } | undefined;
    try {
      reply = await chrome.tabs.sendMessage(senderTabId, {
        channel: "leaddesk",
        type: "leaddesk.worker.sendText",
        requestId: item.outboundId,
        payload: {
          outboundId: item.outboundId,
          toJid,
          body: item.body,
        },
      });
    } catch {
      // Unknown whether the bridge was reached: uncertain, never resend.
      const uncertain: OutboxRecord = { ...record, phase: "uncertain", updatedAt: Date.now() };
      await setOutboxRecord(uncertain);
      await retryUncertain(uncertain);
      return;
    }

    if (reply && reply.ok === false) {
      // The content script refused before posting to the bridge: sendTextMessage was not entered.
      await removeOutboxRecord(item.outboundId);
      await postFail(
        item.outboundId,
        item.claimToken,
        reply.errorClass || "bridge_not_ready",
        reply.transient !== false,
        reply.detail || "Bridge not connected.",
      );
    }
    // ok:true → wait for leaddesk.tab.sendResult
  } catch {
    // Network blip
  }
}

function resolveOnTab(
  tabId: number,
  outboundId: string,
  toE164: string,
): Promise<
  | { ok: true; toJid: string; phoneJid: string | null }
  | { ok: false; errorClass: string; transient: boolean; detail: string }
> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        channel: "leaddesk",
        type: "leaddesk.worker.resolve",
        requestId: outboundId,
        payload: { toE164 },
      },
      (res) => {
        if (chrome.runtime.lastError || !res?.ok || typeof res.toJid !== "string") {
          resolve({
            ok: false,
            errorClass: res?.errorClass || "bridge_not_ready",
            transient: res?.transient !== false,
            detail: res?.detail || chrome.runtime.lastError?.message || "Could not resolve the phone on WhatsApp",
          });
          return;
        }
        resolve({
          ok: true,
          toJid: res.toJid,
          phoneJid: typeof res.phoneJid === "string" ? res.phoneJid : null,
        });
      },
    );
  });
}

async function postFail(outboundId: string, claimToken: string, errorClass: string, transient: boolean, detail: string) {
  if (!state.deviceToken) return;
  try {
    const res = await apiFetch(`/api/v1/extension/outbound/${outboundId}/fail`, {
      claimToken,
      errorClass,
      transient,
      detail: detail.slice(0, 300),
    });
    if (isAuthFailure(res)) await handleUnpair();
  } catch {
    // Server-side claim expiry moves the row to needs_review if this never lands.
  }
}

/**
 * Applies the server answer for an ack/uncertain POST. 2xx, 409 and 404 are terminal for the
 * local record. 401/403 unpair but keep the outbox. Returns true when the record was cleared.
 */
async function settleRecord(rec: OutboxRecord, res: Response): Promise<boolean> {
  if (res.ok || res.status === 409 || res.status === 404) {
    await removeOutboxRecord(rec.outboundId);
    return true;
  }
  if (isAuthFailure(res)) {
    await handleUnpair();
  }
  return false;
}

async function retryAck(rec: OutboxRecord): Promise<boolean> {
  if (!state.deviceToken) return false;
  try {
    const res = await apiFetch(`/api/v1/extension/outbound/${rec.outboundId}/ack`, {
      claimToken: rec.claimToken,
      waMessageId: rec.waMessageId,
      toJid: rec.toJid,
      phoneJid: rec.phoneJid ?? null,
    });
    return await settleRecord(rec, res);
  } catch {
    return false;
  }
}

async function retryUncertain(rec: OutboxRecord): Promise<boolean> {
  if (!state.deviceToken) return false;
  try {
    const res = await apiFetch(`/api/v1/extension/outbound/${rec.outboundId}/uncertain`, {
      claimToken: rec.claimToken,
      detail: "Uncertain outcome",
    });
    return await settleRecord(rec, res);
  } catch {
    return false;
  }
}

function reassignTabs() {
  const now = Date.now();
  const newSenderId = electSenderTab(tabs, currentSenderTabId, state.lastRole, now);

  if (newSenderId !== currentSenderTabId) {
    currentSenderTabId = newSenderId;
  }

  for (const tabId of tabs.keys()) {
    const role = tabId === currentSenderTabId ? "sender" : "standby";
    chrome.tabs.sendMessage(tabId, {
      channel: "leaddesk",
      type: "leaddesk.worker.assign",
      payload: { role },
    }).catch(() => {});
  }
}

// === TAB STATE ===
/** Upserts a tab from a hello/tick payload and asks for a lease or re-election as needed. */
function upsertTab(
  tabId: number,
  info: { ready?: unknown; authenticated?: unknown; href?: unknown } | undefined,
  urgentOnBecomingEligible: boolean,
) {
  const now = Date.now();
  const wasEligible = computeHasEligibleTab(tabs.values(), now);
  const existing = tabs.get(tabId);
  if (info && typeof info.ready === "boolean") {
    tabs.set(tabId, {
      tabId,
      ready: info.ready,
      authenticated: Boolean(info.authenticated),
      lastSeenAt: now,
      href: typeof info.href === "string" ? info.href : existing?.href || "",
    });
  } else if (existing) {
    existing.lastSeenAt = now;
  } else {
    return;
  }
  const isEligible = computeHasEligibleTab(tabs.values(), now);

  if (!wasEligible && isEligible) {
    requestLease(true, urgentOnBecomingEligible);
  } else if (isEligible && state.lastRole !== "sender") {
    requestLease(true);
  } else {
    reassignTabs();
  }
}

/** Global identity is taken only from the elected sender tab, or an authenticated tab when none is elected. */
function applyIdentity(tabId: number | undefined, p: AuthPayload) {
  const authenticated = Boolean(p.authenticated);
  const fromSender = tabId != null && tabId === currentSenderTabId;
  if (!fromSender && !(currentSenderTabId == null && authenticated)) return;
  state.authenticated = authenticated;
  state.streamMode = typeof p.streamMode === "string" ? p.streamMode : null;
  state.ownJid = typeof p.ownJid === "string" && p.ownJid ? p.ownJid : null;
  state.pushName = typeof p.pushName === "string" ? p.pushName : null;
  if (state.ownJid) void flushPendingInbound();
}

// === INBOUND ===
function queueInbound(observed: InboundObserved) {
  if (pendingInbound.some((p) => p.observed.waMessageId === observed.waMessageId)) return;
  pendingInbound.push({ observed, firstSeenAt: Date.now() });
  while (pendingInbound.length > PENDING_INBOUND_MAX) pendingInbound.shift();
}

async function getRecentWaIds(): Promise<string[]> {
  const sess = ((await chrome.storage.session.get("leaddesk.recentWaIds")) || {}) as {
    "leaddesk.recentWaIds"?: string[];
  };
  return sess["leaddesk.recentWaIds"] || [];
}

function rememberWaId(waMessageId: string): Promise<void> {
  return withStorageLock(async () => {
    const recentIds = await getRecentWaIds();
    if (recentIds.includes(waMessageId)) return;
    recentIds.push(waMessageId);
    while (recentIds.length > 1000) recentIds.shift();
    await chrome.storage.session.set({ "leaddesk.recentWaIds": recentIds });
  });
}

/** Returns "done" (posted, duplicate, or permanently rejected) or "retry" (keep for later). */
async function postInbound(observed: InboundObserved): Promise<"done" | "retry"> {
  if (!state.deviceToken || !state.ownJid) return "retry";
  if (inboundInFlight.has(observed.waMessageId)) return "done";
  inboundInFlight.add(observed.waMessageId);
  try {
    const recentIds = await getRecentWaIds();
    if (recentIds.includes(observed.waMessageId)) return "done";

    const wire = toInboundWire(observed, state.ownJid);
    const res = await apiFetch("/api/v1/extension/inbound", wire);
    if (res.ok) {
      await rememberWaId(observed.waMessageId);
      return "done";
    }
    if (isAuthFailure(res)) {
      await handleUnpair();
      return "done";
    }
    if (res.status === 429 || res.status >= 500) return "retry";
    console.warn("[Lead Desk] Inbound rejected with status", res.status);
    return "done";
  } catch {
    return "retry";
  } finally {
    inboundInFlight.delete(observed.waMessageId);
  }
}

async function flushPendingInbound() {
  if (inboundFlushRunning || !state.deviceToken || !state.ownJid) return;
  inboundFlushRunning = true;
  try {
    while (pendingInbound.length > 0 && state.deviceToken && state.ownJid) {
      const next = pendingInbound[0]!;
      if (Date.now() - next.firstSeenAt > PENDING_INBOUND_MAX_AGE_MS) {
        pendingInbound.shift();
        continue;
      }
      const outcome = await postInbound(next.observed);
      if (outcome === "retry") break;
      pendingInbound.shift();
    }
  } finally {
    inboundFlushRunning = false;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.has(tabId)) {
    tabs.delete(tabId);
    if (tabId === currentSenderTabId) {
      currentSenderTabId = null;
    }
    reassignTabs();
  }
});

// Runtime message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== "leaddesk") return;

  const tabId = sender.tab?.id;

  switch (message.type) {
    case "leaddesk.tab.requestInjection": {
      if (tabId != null) {
        (async () => {
          try {
            // 1. Probe WPP first
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ["probe-wpp.js"],
              world: "MAIN",
            });

            // 2. Read probe flag
            const [flagResult] = await chrome.scripting.executeScript({
              target: { tabId },
              func: () => Boolean((globalThis as any).__leadDeskForeignWpp),
              world: "MAIN",
            });

            const isForeign = Boolean(flagResult?.result);
            if (isForeign) {
              // Foreign copy detected: inject page-bridge only
              await chrome.scripting.executeScript({
                target: { tabId },
                files: ["page-bridge.js"],
                world: "MAIN",
              });
            } else {
              // Inject vendored wa-js, then page-bridge
              await chrome.scripting.executeScript({
                target: { tabId },
                files: ["vendor/wppconnect-wa.js"],
                world: "MAIN",
              });
              await chrome.scripting.executeScript({
                target: { tabId },
                files: ["page-bridge.js"],
                world: "MAIN",
              });
            }
          } catch (err) {
            console.warn("[Lead Desk] Script injection error:", err);
          }
        })();
      }
      sendResponse({ ok: true });
      break;
    }

    case "leaddesk.tab.sendResult": {
      const { requestId, payload } = message;
      (async () => {
        try {
          const outbox = await getOutbox();
          const rec = outbox[requestId];
          if (!rec) return;

          if (payload?.ok === true && typeof payload.waMessageId === "string") {
            const submitted: OutboxRecord = {
              ...rec,
              phase: "submitted",
              waMessageId: payload.waMessageId,
              updatedAt: Date.now(),
            };
            await setOutboxRecord(submitted);
            await retryAck(submitted);
          } else {
            const uncertain: OutboxRecord = { ...rec, phase: "uncertain", updatedAt: Date.now() };
            await setOutboxRecord(uncertain);
            await retryUncertain(uncertain);
          }
        } catch (err) {
          console.warn("[Lead Desk] sendResult handling error:", err);
        }
      })();
      sendResponse({ ok: true });
      break;
    }

    case "leaddesk.tab.hello": {
      if (tabId != null) {
        upsertTab(tabId, { ...message.payload, ready: Boolean(message.payload?.ready) }, true);
      }
      sendResponse({ ok: true });
      break;
    }

    case "leaddesk.tab.tick": {
      // Ticks carry ready/authenticated/href so the tab map rebuilds after a worker restart.
      if (tabId != null) {
        upsertTab(tabId, message.payload, true);
        if (message.payload?.auth) applyIdentity(tabId, message.payload.auth as AuthPayload);
      }
      sendResponse({ ok: true });
      break;
    }

    case "leaddesk.tab.auth": {
      if (tabId != null && message.payload) {
        const p = message.payload as AuthPayload;
        const existing = tabs.get(tabId);
        if (existing) {
          const wasEligible = computeHasEligibleTab(tabs.values(), Date.now());
          existing.authenticated = Boolean(p.authenticated);
          existing.lastSeenAt = Date.now();
          const isEligible = computeHasEligibleTab(tabs.values(), Date.now());
          if (!wasEligible && isEligible) {
            requestLease(true, true);
          } else if (isEligible && state.lastRole !== "sender") {
            requestLease(true);
          } else {
            reassignTabs();
          }
        }
        applyIdentity(tabId, p);
      }
      sendResponse({ ok: true });
      break;
    }

    case "leaddesk.tab.inbound": {
      const targetTab = tabId != null ? tabs.get(tabId) : undefined;
      const fromReadyTab = targetTab != null && isTabEligible(targetTab, Date.now());
      if (tabId == null || (tabId !== currentSenderTabId && !fromReadyTab)) {
        sendResponse({ ok: false, reason: "not_sender_tab" });
        break;
      }

      const observed = message.payload as InboundObserved;
      if (observed && observed.waMessageId) {
        (async () => {
          // Hold until our own jid is known; never post a placeholder identity.
          if (!state.ownJid) {
            queueInbound(observed);
            return;
          }
          const outcome = await postInbound(observed);
          if (outcome === "retry") queueInbound(observed);
        })().catch((err) => console.warn("[Lead Desk] Inbound dispatch error:", err));
      }
      sendResponse({ ok: true });
      break;
    }

    case "leaddesk.crm.request": {
      if (!isWhatsAppContentSender(sender)) {
        sendResponse({ ok: false, status: 0, error: { code: "forbidden", message: "Not a WhatsApp Web tab." } });
        break;
      }
      handleCrmRequest(message.payload as CrmRequest | undefined).then(sendResponse, (err) =>
        sendResponse({ ok: false, status: 0, error: { code: "internal", message: String(err?.message || err) } })
      );
      return true;
    }

    case "leaddesk.crm.status": {
      if (!isWhatsAppContentSender(sender)) {
        sendResponse({ paired: false, serverOrigin: null });
        break;
      }
      configLoaded.catch(() => {}).then(() => sendResponse(crmStatus()));
      return true;
    }

    case "leaddesk.popup.status": {
      sendResponse({
        paired: Boolean(state.deviceToken),
        role: state.lastRole,
        serverUrl: state.serverUrl,
        deviceId: state.deviceId,
        deviceLabel: state.deviceLabel,
        senderTabId: currentSenderTabId,
        hasEligibleTab: computeHasEligibleTab(tabs.values(), Date.now()),
      });
      break;
    }

    case "leaddesk.popup.pair": {
      (async () => {
        try {
          const { pairingCode, label } = message.payload;
          const parsed = parseServerOrigin(String(message.payload?.serverUrl ?? ""));
          if ("error" in parsed) {
            sendResponse({ ok: false, error: parsed.error });
            return;
          }
          const serverUrl = parsed.origin;
          if (
            !isLoopbackOrigin(serverUrl) &&
            !(await chrome.permissions.contains({ origins: [originPattern(serverUrl)] }))
          ) {
            sendResponse({ ok: false, error: `The extension has no access to ${serverUrl}. Try pairing again and allow access.` });
            return;
          }

          const res = await fetch(`${serverUrl}/api/v1/extension/pair`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: pairingCode, label: label || "Chrome Extension" }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            sendResponse({ ok: false, error: err.error?.message || "Pairing failed." });
            return;
          }

          const data = await res.json();
          state.deviceToken = data.deviceToken;
          state.deviceId = data.deviceId;
          state.deviceLabel = label || "Chrome Extension";
          state.serverUrl = serverUrl;

          await chrome.storage.local.set({
            "leaddesk.deviceToken": data.deviceToken,
            "leaddesk.deviceId": data.deviceId,
            "leaddesk.deviceLabel": state.deviceLabel,
            "leaddesk.serverUrl": serverUrl,
          });

          lastLeaseCallAt = 0;
          updateBadge();
          startLoops();
          notifyCrmTabs();
          sendResponse({ ok: true });
        } catch (err: any) {
          sendResponse({ ok: false, error: err.message || "Network error." });
        }
      })();
      return true;
    }

    case "leaddesk.popup.forget": {
      handleUnpair(false).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: true }),
      );
      return true;
    }
  }
});

// Initialization
const configLoaded = loadConfig();
configLoaded
  .then(() => {
    updateBadge();
    startLoops();
  })
  .catch((err) => console.warn("[Lead Desk] Init error:", err));
