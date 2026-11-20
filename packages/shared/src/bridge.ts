export const SEND_OPTIONS = {
  waitForAck: false,
  linkPreview: false,
  detectMentioned: false,
  markIsRead: false,
  delay: 0,
} as const;

export type OutboxPhase = "sending" | "submitted" | "uncertain";

export interface OutboxRecord {
  outboundId: string;
  claimToken: string;
  toJid: string | null;
  phoneJid?: string | null;
  bodySha256: string;
  phase: OutboxPhase;
  waMessageId: string | null;
  updatedAt: number;
}

export function readWaMessageId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const res = result as { id?: unknown; _serialized?: unknown };
  if (typeof res.id === "string" && res.id.length > 0) {
    return res.id;
  }
  if (typeof res._serialized === "string" && res._serialized.length > 0) {
    return res._serialized;
  }
  if (res.id && typeof res.id === "object") {
    const nested = (res.id as { _serialized?: unknown })._serialized;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return null;
}

export function pnLidArg(wid: string): string | null {
  if (wid.endsWith("@c.us") || wid.endsWith("@lid")) return wid;
  if (wid.endsWith("@s.whatsapp.net")) {
    const user = wid.slice(0, wid.indexOf("@"));
    return user.length > 0 ? `${user}@c.us` : null;
  }
  return null;
}

export function classifyChatKind(jid: string): "direct" | "group" | "broadcast" | "other" {
  if (jid.endsWith("@c.us") || jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) {
    return "direct";
  }
  if (jid.endsWith("@g.us")) {
    return "group";
  }
  if (jid.includes("broadcast")) {
    return "broadcast";
  }
  return "other";
}

import type { InboundObserved, InboundWire } from "./types.js";

export function toInboundWire(observed: InboundObserved, ownJid: string): InboundWire {
  const waTimestamp = new Date(observed.waTimestampMs).toISOString();
  const fromMe = observed.fromMe;
  return {
    waMessageId: observed.waMessageId,
    chatJid: observed.chatJid,
    senderJid: observed.senderJid,
    senderLid: observed.senderLid,
    senderPhoneUser: observed.senderPhoneUser,
    fromMe,
    body: observed.body,
    waTimestamp,
    chatKind: observed.chatKind,
    fromJid: fromMe ? ownJid : (observed.senderJid ?? observed.chatJid),
    toJid: fromMe ? observed.chatJid : ownJid,
  };
}
