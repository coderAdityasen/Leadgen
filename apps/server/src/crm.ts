/**
 * CRM board helpers shared by the dashboard routes (operator session) and the WhatsApp
 * side-panel routes (extension device token).
 */
import type { Db } from "./db.js";
import { generateUlid } from "@leaddesk/shared";
import { parseAndNormalizePhone } from "./phone.js";

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string) =>
  ({ ok: false, status, code, message }) as const;

export interface StageWithCount {
  id: string;
  name: string;
  position: number;
  count: number;
}

export interface LeadCard {
  id: string;
  displayName: string;
  email: string | null;
  company: string | null;
  notes: string;
  stageId: string;
  stageName: string;
  aiEnabled: boolean;
  requireApproval: boolean;
  automationPaused: boolean;
  doNotMessage: boolean;
  archivedAt: string | null;
  primaryPhone: string | null;
  waJid: string | null;
  waLid: string | null;
  createdAt: string;
  updatedAt: string;
  stageChangedAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  enrollment: {
    id: string;
    sequenceId: string;
    sequenceName: string;
    stepNumber: number | null;
    totalSteps: number;
  } | null;
  nextMessage: {
    outboundId: string;
    kind: string;
    body: string;
    dueAt: string;
    status: string;
  } | null;
  pendingScheduled: number;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export async function listStagesWithCounts(db: Db): Promise<StageWithCount[]> {
  return await db
    .prepare(`
      SELECT s.id, s.name, s.position,
        (SELECT COUNT(*) FROM lead l WHERE l.stage_id = s.id AND l.archived_at IS NULL) AS count
      FROM stage s
      ORDER BY s.position ASC
    `)
    .all() as StageWithCount[];
}

export async function listSequencesBrief(db: Db) {
  const rows = await db
    .prepare(`
      SELECT q.id, q.name, q.enabled,
        (SELECT COUNT(*) FROM sequence_step st WHERE st.sequence_id = q.id) AS step_count
      FROM sequence q
      ORDER BY q.name COLLATE NOCASE ASC
    `)
    .all() as { id: string; name: string; enabled: number; step_count: number }[];
  return rows.map((r) => ({ id: r.id, name: r.name, enabled: Boolean(r.enabled), stepCount: r.step_count }));
}

/** Load lead rows joined with their stage and primary phone, then attach sequence/queue info. */
async function buildCards(db: Db, rows: any[]): Promise<LeadCard[]> {
  if (rows.length === 0) return [];
  const ids = new Set(rows.map((r) => r.id as string));

  const enrollments = new Map<string, LeadCard["enrollment"]>();
  const enrRows = await db
    .prepare(`
      SELECT e.id, e.lead_id, e.sequence_id, q.name AS sequence_name, st.position AS step_position,
        (SELECT COUNT(*) FROM sequence_step x WHERE x.sequence_id = e.sequence_id) AS total_steps
      FROM sequence_enrollment e
      JOIN sequence q ON q.id = e.sequence_id
      LEFT JOIN sequence_step st ON st.id = e.current_step_id
      WHERE e.status = 'active'
    `)
    .all() as any[];
  for (const e of enrRows) {
    if (!ids.has(e.lead_id)) continue;
    enrollments.set(e.lead_id, {
      id: e.id,
      sequenceId: e.sequence_id,
      sequenceName: e.sequence_name,
      stepNumber: e.step_position == null ? null : e.step_position + 1,
      totalSteps: e.total_steps,
    });
  }

  const nextByLead = new Map<string, LeadCard["nextMessage"]>();
  const scheduledByLead = new Map<string, number>();
  const pending = await db
    .prepare(`
      SELECT id, lead_id, kind, body, due_at, status FROM outbound_queue
      WHERE status IN ('queued', 'needs_approval', 'claimed') AND lead_id IS NOT NULL
      ORDER BY due_at ASC, id ASC
    `)
    .all() as any[];
  for (const o of pending) {
    if (!ids.has(o.lead_id)) continue;
    if (!nextByLead.has(o.lead_id)) {
      nextByLead.set(o.lead_id, {
        outboundId: o.id,
        kind: o.kind,
        body: String(o.body).slice(0, 160),
        dueAt: new Date(o.due_at).toISOString(),
        status: o.status,
      });
    }
    if (o.kind === "scheduled" && o.status === "queued") {
      scheduledByLead.set(o.lead_id, (scheduledByLead.get(o.lead_id) ?? 0) + 1);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    email: r.email ?? null,
    company: r.company ?? null,
    notes: r.notes ?? "",
    stageId: r.stage_id,
    stageName: r.stage_name ?? "",
    aiEnabled: Boolean(r.ai_enabled),
    requireApproval: Boolean(r.require_approval),
    automationPaused: Boolean(r.automation_paused),
    doNotMessage: Boolean(r.do_not_message),
    archivedAt: iso(r.archived_at),
    primaryPhone: r.primary_e164 ?? null,
    waJid: r.primary_wa_jid ?? null,
    waLid: r.primary_wa_lid ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    stageChangedAt: new Date(r.stage_changed_at ?? r.created_at).toISOString(),
    lastInboundAt: iso(r.last_inbound_at),
    lastOutboundAt: iso(r.last_outbound_at),
    enrollment: enrollments.get(r.id) ?? null,
    nextMessage: nextByLead.get(r.id) ?? null,
    pendingScheduled: scheduledByLead.get(r.id) ?? 0,
  }));
}

const LEAD_SELECT = `
  SELECT l.*, s.name AS stage_name,
    p.e164 AS primary_e164, p.wa_jid AS primary_wa_jid, p.wa_lid AS primary_wa_lid
  FROM lead l
  JOIN stage s ON s.id = l.stage_id
  LEFT JOIN phone_identity p ON p.lead_id = l.id AND p.is_primary = 1
`;

export async function getLeadCard(db: Db, leadId: string): Promise<LeadCard | null> {
  const row = await db.prepare(`${LEAD_SELECT} WHERE l.id = ?`).get(leadId);
  return row ? (await buildCards(db, [row]))[0]! : null;
}

export interface BoardQuery {
  q?: string;
  stageId?: string;
  includeArchived?: boolean;
  limit?: number;
}

/** Everything the stage board needs in one call: stage counts plus enriched lead cards. */
export async function getBoard(db: Db, query: BoardQuery) {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (!query.includeArchived) conditions.push("l.archived_at IS NULL");
  if (query.stageId) {
    conditions.push("l.stage_id = ?");
    params.push(query.stageId);
  }
  const q = query.q?.trim();
  if (q) {
    const term = `%${q}%`;
    const digits = q.replace(/\D/g, "");
    conditions.push(
      `(l.display_name LIKE ? OR l.email LIKE ? OR l.company LIKE ? OR l.notes LIKE ?${digits ? " OR p.e164 LIKE ?" : ""})`
    );
    params.push(term, term, term, term);
    if (digits) params.push(`%${digits}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(query.limit ?? 500, 1), 1000);
  const rows = await db
    .prepare(`${LEAD_SELECT} ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ?`)
    .all(...params, limit + 1) as any[];
  const truncated = rows.length > limit;
  return {
    stages: await listStagesWithCounts(db),
    items: await buildCards(db, truncated ? rows.slice(0, limit) : rows),
    truncated,
  };
}

const optionalText = (value: unknown, field: string, max: number): Result<string | null> => {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return fail(400, "validation", `${field} must be a string or null.`);
  const trimmed = value.trim();
  if (trimmed.length > max) return fail(400, "validation", `${field} must be at most ${max} characters.`);
  return { ok: true, value: trimmed || null };
};

/** Validate optional email/company inputs (shared with POST /leads). */
export function checkContactFields(email: unknown, company: unknown): Result<null> {
  if (email !== undefined) {
    const r = optionalText(email, "email", 200);
    if (!r.ok) return r;
    if (r.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.value)) return fail(400, "validation", "email is not a valid address.");
  }
  if (company !== undefined) {
    const r = optionalText(company, "company", 200);
    if (!r.ok) return r;
  }
  return { ok: true, value: null };
}

/**
 * Apply a partial update to a lead. Used by PATCH /leads/:id and the WhatsApp panel.
 * Moving stage stamps stage_changed_at; turning on do-not-message cancels pending sends.
 */
export async function updateLead(db: Db, leadId: string, body: unknown): Promise<Result<null>> {
  const lead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(leadId) as any;
  if (!lead) return fail(404, "not_found", "Lead not found.");
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  if (b["displayName"] !== undefined && (typeof b["displayName"] !== "string" || !b["displayName"].trim())) {
    return fail(400, "validation", "displayName must be a non-empty string.");
  }
  if (b["notes"] !== undefined && (typeof b["notes"] !== "string" || b["notes"].length > 10000)) {
    return fail(400, "validation", "notes must be a string of at most 10,000 characters.");
  }
  for (const flag of ["aiEnabled", "requireApproval", "automationPaused", "doNotMessage"]) {
    if (b[flag] !== undefined && typeof b[flag] !== "boolean") {
      return fail(400, "validation", `${flag} must be true or false.`);
    }
  }
  let email = lead.email as string | null;
  if (b["email"] !== undefined) {
    const r = optionalText(b["email"], "email", 200);
    if (!r.ok) return r;
    if (r.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.value)) {
      return fail(400, "validation", "email is not a valid address.");
    }
    email = r.value;
  }
  let company = lead.company as string | null;
  if (b["company"] !== undefined) {
    const r = optionalText(b["company"], "company", 200);
    if (!r.ok) return r;
    company = r.value;
  }
  if (b["stageId"] !== undefined) {
    if (typeof b["stageId"] !== "string" || !await db.prepare("SELECT id FROM stage WHERE id = ?").get(b["stageId"])) {
      return fail(400, "validation", "Invalid stageId.");
    }
  }

  const now = Date.now();
  const flag = (key: string, current: number) => (b[key] !== undefined ? (b[key] ? 1 : 0) : current);
  const stageId = (b["stageId"] as string | undefined) ?? lead.stage_id;
  const stageChangedAt = stageId !== lead.stage_id ? now : lead.stage_changed_at ?? lead.created_at;

  await db.transaction(async () => {
    await db.prepare(`
      UPDATE lead
      SET display_name = ?, notes = ?, stage_id = ?, ai_enabled = ?, require_approval = ?,
          automation_paused = ?, do_not_message = ?, email = ?, company = ?, stage_changed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      typeof b["displayName"] === "string" ? b["displayName"].trim() : lead.display_name,
      typeof b["notes"] === "string" ? b["notes"] : lead.notes,
      stageId,
      flag("aiEnabled", lead.ai_enabled),
      flag("requireApproval", lead.require_approval),
      flag("automationPaused", lead.automation_paused),
      flag("doNotMessage", lead.do_not_message),
      email,
      company,
      stageChangedAt,
      now,
      leadId
    );

    // doNotMessage = true cancels queued and needs_approval outbound rows and active sequence enrollments
    if (b["doNotMessage"] === true) {
      await db.prepare(`
        UPDATE outbound_queue SET status = 'cancelled', last_error = 'do_not_message'
        WHERE lead_id = ? AND status IN ('queued', 'needs_approval')
      `).run(leadId);
      await db.prepare(`
        UPDATE sequence_enrollment
        SET status = 'stopped', stop_reason = 'do_not_message', stopped_at = ?
        WHERE lead_id = ? AND status = 'active'
      `).run(now, leadId);
    }
  });

  return { ok: true, value: null };
}

export interface ContactRef {
  chatJid?: string | null;
  lid?: string | null;
  phoneUser?: string | null;
}

function normalizeContact(ref: ContactRef) {
  const chatJid = typeof ref.chatJid === "string" ? ref.chatJid : null;
  const lid = typeof ref.lid === "string" && ref.lid.endsWith("@lid") ? ref.lid : chatJid?.endsWith("@lid") ? chatJid : null;
  const jid = chatJid && (chatJid.endsWith("@c.us") || chatJid.endsWith("@s.whatsapp.net")) ? chatJid : null;
  let digits = typeof ref.phoneUser === "string" ? ref.phoneUser.replace(/\D/g, "") : "";
  if (!digits && jid) digits = jid.replace(/@.*$/, "").replace(/\D/g, "");
  return { lid, jid, digits: /^\d{5,20}$/.test(digits) ? digits : null };
}

/** Match a WhatsApp contact to a lead: by lid, then jid, then E.164 (same order as inbound). */
export async function findLeadIdByContact(db: Db, ref: ContactRef): Promise<string | null> {
  const { lid, jid, digits } = normalizeContact(ref);
  const hit =
    (lid && (await db.prepare("SELECT lead_id FROM phone_identity WHERE wa_lid = ?").get(lid) as any)) ||
    (jid && (await db.prepare("SELECT lead_id FROM phone_identity WHERE wa_jid = ?").get(jid) as any)) ||
    (digits && (await db.prepare("SELECT lead_id FROM phone_identity WHERE e164 = ?").get(`+${digits}`) as any)) ||
    null;
  return hit?.lead_id ?? null;
}

/** Create a lead for a WhatsApp chat (from the side panel's "Create lead"). */
export async function createLeadFromContact(
  db: Db,
  input: ContactRef & {
    displayName?: unknown;
    stageId?: unknown;
    notes?: unknown;
    email?: unknown;
    company?: unknown;
  }
): Promise<Result<string>> {
  const { lid, jid, digits } = normalizeContact(input);
  if (!lid && !jid && !digits) {
    return fail(400, "validation", "This chat has no phone number or WhatsApp id to save.");
  }
  if (typeof input.chatJid === "string" && !/@(c\.us|s\.whatsapp\.net|lid)$/.test(input.chatJid)) {
    return fail(400, "validation", "Only one-to-one chats can be saved as leads.");
  }
  const existing = await findLeadIdByContact(db, input);
  if (existing) return fail(409, "conflict", "This contact is already a lead.");

  let e164: string | null = null;
  if (digits) {
    try {
      e164 = parseAndNormalizePhone(`+${digits}`, null).e164;
    } catch {
      e164 = null; // keep the WhatsApp ids; the number may be a non-dialable lid user part
    }
  }
  const displayName =
    typeof input.displayName === "string" && input.displayName.trim()
      ? input.displayName.trim().slice(0, 200)
      : e164 ?? jid ?? lid!;

  let stageId = typeof input.stageId === "string" ? input.stageId : null;
  if (stageId && !await db.prepare("SELECT id FROM stage WHERE id = ?").get(stageId)) {
    return fail(400, "validation", "Invalid stageId.");
  }
  if (!stageId) {
    const first = await db.prepare("SELECT id FROM stage ORDER BY position ASC LIMIT 1").get() as { id: string } | undefined;
    if (!first) return fail(400, "validation", "No stage available.");
    stageId = first.id;
  }
  const notes = typeof input.notes === "string" ? input.notes.slice(0, 10000) : "";
  const email = input.email === undefined ? { ok: true as const, value: null } : optionalText(input.email, "email", 200);
  if (!email.ok) return email;
  const company =
    input.company === undefined ? { ok: true as const, value: null } : optionalText(input.company, "company", 200);
  if (!company.ok) return company;

  const leadId = generateUlid("led");
  const now = Date.now();
  await db.transaction(async () => {
    await db.prepare(`
      INSERT INTO lead (id, display_name, notes, stage_id, ai_enabled, require_approval, automation_paused,
        do_not_message, archived_at, created_at, updated_at, email, company, stage_changed_at)
      VALUES (?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?, ?, ?, ?)
    `).run(leadId, displayName, notes, stageId, now, now, email.value, company.value, now);
    await db.prepare(`
      INSERT INTO phone_identity (id, lead_id, e164, wa_jid, wa_lid, is_primary, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(generateUlid("phn"), leadId, e164, jid, lid, now);
  });
  return { ok: true, value: leadId };
}

/** Cancel the lead's active enrollment and its pending step. */
export async function cancelActiveEnrollment(db: Db, leadId: string): Promise<Result<null>> {
  const enr = await db
    .prepare("SELECT id FROM sequence_enrollment WHERE lead_id = ? AND status = 'active'")
    .get(leadId) as { id: string } | undefined;
  if (!enr) return fail(409, "conflict", "Lead has no active sequence.");
  const now = Date.now();
  await db.transaction(async () => {
    await db.prepare(`
      UPDATE sequence_enrollment SET status = 'cancelled', stopped_at = ?, stop_reason = 'cancelled'
      WHERE id = ? AND status = 'active'
    `).run(now, enr.id);
    await db.prepare(`
      UPDATE outbound_queue SET status = 'cancelled'
      WHERE enrollment_id = ? AND status IN ('queued', 'needs_approval')
    `).run(enr.id);
  });
  return { ok: true, value: null };
}
