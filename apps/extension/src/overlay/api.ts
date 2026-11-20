import type { CrmOp, CrmResponse, CrmStatus } from "@leaddesk/shared";

/** True while this content script still belongs to a live extension (false after a reload/update). */
export function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/** One CRM call through the service worker. The worker adds the device token; we never see it. */
export async function crm<T>(op: CrmOp, params: Record<string, unknown> = {}): Promise<CrmResponse<T>> {
  if (!extensionAlive()) {
    return { ok: false, status: 0, error: { code: "extension_unavailable", message: "Lead Desk was updated. Reload this tab." } };
  }
  try {
    const res = (await chrome.runtime.sendMessage({
      channel: "leaddesk",
      type: "leaddesk.crm.request",
      payload: { op, params },
    })) as CrmResponse<T> | undefined;
    if (!res || typeof res.ok !== "boolean") {
      return { ok: false, status: 0, error: { code: "no_response", message: "Lead Desk extension did not answer." } };
    }
    return res;
  } catch {
    return { ok: false, status: 0, error: { code: "extension_unavailable", message: "Lead Desk extension is not reachable." } };
  }
}

export async function crmStatus(): Promise<CrmStatus | null> {
  if (!extensionAlive()) return null;
  try {
    const res = (await chrome.runtime.sendMessage({ channel: "leaddesk", type: "leaddesk.crm.status" })) as CrmStatus | undefined;
    if (!res || typeof res.paired !== "boolean") return null;
    return res;
  } catch {
    return null;
  }
}

export function errorText(res: { error: { code: string; message?: string } }): string {
  return res.error.message || res.error.code.replace(/_/g, " ");
}

export type OverlayPrefs = { minimized: boolean; panelCollapsed: boolean };
const PREFS_KEY = "leaddesk.overlayPrefs";

export async function loadPrefs(): Promise<OverlayPrefs> {
  const fallback: OverlayPrefs = { minimized: false, panelCollapsed: false };
  if (!extensionAlive()) return fallback;
  try {
    // Ask for this one key only, so nothing else in storage is read into the content script.
    const data = (await chrome.storage.local.get(PREFS_KEY)) as Record<string, unknown>;
    const raw = data[PREFS_KEY] as Partial<OverlayPrefs> | undefined;
    return {
      minimized: Boolean(raw?.minimized),
      panelCollapsed: Boolean(raw?.panelCollapsed),
    };
  } catch {
    return fallback;
  }
}

export function savePrefs(prefs: OverlayPrefs) {
  if (!extensionAlive()) return;
  try {
    chrome.storage.local.set({ [PREFS_KEY]: prefs }).catch(() => {});
  } catch {
    // storage unavailable; the in-memory state still applies
  }
}
