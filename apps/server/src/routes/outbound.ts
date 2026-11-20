import type { FastifyPluginAsync } from "fastify";
import { generateUlid } from "@leaddesk/shared";
import { requireOperatorSession } from "../auth.js";
import {
  quietHoursCover,
  nextOpenMinute,
  type DeskPolicy,
} from "../policy.js";
import type { OutboundQueueRow } from "../queue.js";

const MAX_BODY_CHARS = 4096;

/** Returns an error message when `value` is not a usable WhatsApp text body. */
function invalidBody(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "body is required.";
  if (value.trim().length > MAX_BODY_CHARS) return `body must be at most ${MAX_BODY_CHARS} characters.`;
  return null;
}

function formatOutboundRow(row: OutboundQueueRow) {
  return {
    id: row.id,
    leadId: row.lead_id,
    toE164: row.to_e164,
    toJid: row.to_jid,
    body: row.body,
    kind: row.kind,
    status: row.status,
    dueAt: new Date(row.due_at).toISOString(),
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    waMessageId: row.wa_message_id,
    createdAt: new Date(row.created_at).toISOString(),
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
  };
}

export const outboundRoutes: FastifyPluginAsync = async (app) => {
  // === SEND NOW ===
  // POST /leads/:leadId/send
  app.post("/leads/:leadId/send", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { leadId } = request.params as { leadId: string };
    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;

    if (!idempotencyKey) {
      return reply.code(400).send({
        error: { code: "validation", message: "Idempotency-Key header is required.", details: {} },
      });
    }

    const body = (request.body ?? {}) as { body?: string; allowDuringQuietHours?: boolean };
    const bodyError = invalidBody(body.body);
    if (bodyError || !body.body) {
      return reply.code(400).send({
        error: { code: "validation", message: bodyError ?? "body is required.", details: {} },
      });
    }

    const db = app.db;
    const now = Date.now();

    // Idempotent check
    const existing = await db.prepare("SELECT * FROM outbound_queue WHERE idempotency_key = ?").get(idempotencyKey) as
      | OutboundQueueRow
      | undefined;
    if (existing) {
      return reply.code(201).send({
        outboundId: existing.id,
        status: existing.status,
        dueAt: new Date(existing.due_at).toISOString(),
      });
    }

    const lead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(leadId) as
      | { id: string; do_not_message: number; archived_at: number | null }
      | undefined;

    if (!lead || lead.archived_at) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Lead not found or archived.", details: {} },
      });
    }

    if (lead.do_not_message) {
      return reply.code(409).send({
        error: { code: "do_not_message", message: "Lead has do_not_message set.", details: {} },
      });
    }

    const primaryPhone = await db
      .prepare("SELECT * FROM phone_identity WHERE lead_id = ? AND is_primary = 1")
      .get(leadId) as { id: string; e164: string | null; wa_jid: string | null; wa_lid: string | null } | undefined;

    if (!primaryPhone) {
      return reply.code(400).send({
        error: { code: "no_phone", message: "Lead has no primary phone.", details: {} },
      });
    }

    const policy = await db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as DeskPolicy;
    const operator = await db.prepare("SELECT timezone FROM operator LIMIT 1").get() as { timezone: string } | undefined;
    const tz = operator?.timezone || "UTC";

    // Check quiet hours
    if (!body.allowDuringQuietHours && quietHoursCover(now, policy, tz)) {
      return reply.code(409).send({
        error: { code: "quiet_hours", message: "Current time is inside quiet hours.", details: {} },
      });
    }

    // Check daily manual cap
    const dayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now));
    const counter = (await db.prepare("SELECT * FROM daily_counter WHERE day_local = ?").get(dayLocal) as
      | { manual_count: number }
      | undefined) ?? { manual_count: 0 };

    if (counter.manual_count >= policy.daily_manual_cap) {
      return reply.code(409).send({
        error: { code: "cap_reached", message: "Daily manual send cap reached.", details: {} },
      });
    }

    const outboundId = generateUlid("out");
    const toJid = primaryPhone.wa_lid || primaryPhone.wa_jid || null;
    const needsResolve = toJid ? 0 : 1;

    await db.prepare(`
      INSERT INTO outbound_queue (
        id, lead_id, phone_id, to_e164, to_jid, needs_resolve, body, kind, status,
        earliest_due_at, due_at, idempotency_key, allow_during_quiet_hours, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'queued', ?, ?, ?, ?, ?)
    `).run(
      outboundId,
      leadId,
      primaryPhone.id,
      primaryPhone.e164,
      toJid,
      needsResolve,
      body.body.trim(),
      now,
      now,
      idempotencyKey,
      body.allowDuringQuietHours ? 1 : 0,
      now
    );

    return reply.code(201).send({
      outboundId,
      status: "queued",
      dueAt: new Date(now).toISOString(),
    });
  });

  // === SCHEDULED MESSAGES ===
  // POST /scheduled-messages
  app.post("/scheduled-messages", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;

    if (!idempotencyKey) {
      return reply.code(400).send({
        error: { code: "validation", message: "Idempotency-Key header is required.", details: {} },
      });
    }

    const body = (request.body ?? {}) as {
      leadId?: string;
      body?: string;
      dueAt?: string;
      allowDuringQuietHours?: boolean;
    };

    if (typeof body.leadId !== "string" || typeof body.dueAt !== "string" || !body.body) {
      return reply.code(400).send({
        error: { code: "validation", message: "leadId, body, and dueAt are required.", details: {} },
      });
    }
    const schBodyError = invalidBody(body.body);
    if (schBodyError) {
      return reply.code(400).send({ error: { code: "validation", message: schBodyError, details: {} } });
    }

    const dueAtMs = new Date(body.dueAt).getTime();
    if (isNaN(dueAtMs)) {
      return reply.code(400).send({
        error: { code: "validation", message: "Invalid dueAt timestamp.", details: {} },
      });
    }

    const db = app.db;
    const now = Date.now();

    // Idempotency check
    const existing = await db.prepare("SELECT * FROM scheduled_message WHERE idempotency_key = ?").get(idempotencyKey) as
      | { id: string; lead_id: string; body: string; requested_at: number; allow_during_quiet_hours: number; status: string }
      | undefined;

    if (existing) {
      const linkedOut = await db.prepare("SELECT id FROM outbound_queue WHERE scheduled_message_id = ?").get(existing.id) as
        | { id: string }
        | undefined;
      return reply.code(201).send({
        id: existing.id,
        status: existing.status,
        outboundId: linkedOut?.id,
      });
    }

    const lead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(body.leadId) as
      | { id: string; do_not_message: number; archived_at: number | null }
      | undefined;

    if (!lead || lead.archived_at) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Lead not found or archived.", details: {} },
      });
    }

    if (lead.do_not_message) {
      return reply.code(409).send({
        error: { code: "do_not_message", message: "Lead has do_not_message set.", details: {} },
      });
    }

    const primaryPhone = await db
      .prepare("SELECT * FROM phone_identity WHERE lead_id = ? AND is_primary = 1")
      .get(body.leadId) as { id: string; e164: string | null; wa_jid: string | null; wa_lid: string | null } | undefined;

    if (!primaryPhone) {
      return reply.code(400).send({
        error: { code: "no_phone", message: "Lead has no primary phone.", details: {} },
      });
    }

    const policy = await db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as DeskPolicy;
    const operator = await db.prepare("SELECT timezone FROM operator LIMIT 1").get() as { timezone: string } | undefined;
    const tz = operator?.timezone || "UTC";

    // Quiet hours roll for due_at
    const allowDuringQuietHours = Boolean(body.allowDuringQuietHours);
    let effectiveDueAt = dueAtMs;
    if (!allowDuringQuietHours && quietHoursCover(dueAtMs, policy, tz)) {
      effectiveDueAt = nextOpenMinute(dueAtMs, policy, tz);
    }

    const messageBody = body.body.trim();
    const leadId = body.leadId;
    const schId = generateUlid("sch");
    const outboundId = generateUlid("out");
    const toJid = primaryPhone.wa_lid || primaryPhone.wa_jid || null;
    const needsResolve = toJid ? 0 : 1;

    await db.transaction(async () => {
      await db.prepare(`
        INSERT INTO scheduled_message (id, lead_id, body, requested_at, allow_during_quiet_hours, status, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, 'materialized', ?, ?)
      `).run(schId, leadId, messageBody, dueAtMs, allowDuringQuietHours ? 1 : 0, idempotencyKey, now);

      await db.prepare(`
        INSERT INTO outbound_queue (
          id, lead_id, phone_id, to_e164, to_jid, needs_resolve, body, kind, status,
          earliest_due_at, due_at, scheduled_message_id, idempotency_key, allow_during_quiet_hours, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 'queued', ?, ?, ?, ?, ?, ?)
      `).run(
        outboundId,
        leadId,
        primaryPhone.id,
        primaryPhone.e164,
        toJid,
        needsResolve,
        messageBody,
        dueAtMs,
        effectiveDueAt,
        schId,
        `sch:${schId}`,
        allowDuringQuietHours ? 1 : 0,
        now
      );
    });

    return reply.code(201).send({
      id: schId,
      status: "materialized",
      outboundId,
    });
  });

  // GET /scheduled-messages
  app.get("/scheduled-messages", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const query = (request.query ?? {}) as { status?: string };
    const db = app.db;

    let rows;
    if (query.status) {
      rows = await db.prepare("SELECT * FROM scheduled_message WHERE status = ? ORDER BY created_at DESC").all(query.status);
    } else {
      rows = await db.prepare("SELECT * FROM scheduled_message ORDER BY created_at DESC").all();
    }

    return reply.code(200).send({
      items: rows.map((r: any) => ({
        id: r.id,
        leadId: r.lead_id,
        body: r.body,
        requestedAt: new Date(r.requested_at).toISOString(),
        allowDuringQuietHours: Boolean(r.allow_during_quiet_hours),
        status: r.status,
      })),
    });
  });

  // POST /scheduled-messages/:id/cancel
  app.post("/scheduled-messages/:id/cancel", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { id } = request.params as { id: string };
    const db = app.db;

    const sch = await db.prepare("SELECT * FROM scheduled_message WHERE id = ?").get(id) as
      | { id: string; status: string }
      | undefined;

    if (!sch) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Scheduled message not found.", details: {} },
      });
    }

    const linkedOut = await db.prepare("SELECT * FROM outbound_queue WHERE scheduled_message_id = ?").get(id) as
      | OutboundQueueRow
      | undefined;

    if (linkedOut && (linkedOut.status === "sent" || linkedOut.status === "claimed")) {
      return reply.code(409).send({
        error: {
          code: "conflict",
          message: linkedOut.status === "sent" ? "Message already sent." : "Message is being sent right now.",
          details: {},
        },
      });
    }

    await db.transaction(async () => {
      await db.prepare("UPDATE scheduled_message SET status = 'cancelled' WHERE id = ?").run(id);
      if (linkedOut && linkedOut.status === "queued") {
        await db.prepare("UPDATE outbound_queue SET status = 'cancelled' WHERE id = ?").run(linkedOut.id);
      }
    });

    return reply.code(200).send({ id, status: "cancelled" });
  });

  // === QUEUE MANAGEMENT ===
  // GET /outbound
  app.get("/outbound", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const query = (request.query ?? {}) as {
      status?: string;
      leadId?: string;
      limit?: string;
      cursor?: string;
    };

    const limit = Math.min(Math.max(parseInt(query.limit ?? "50", 10) || 50, 1), 100);
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (query.status) {
      conditions.push("status = ?");
      params.push(query.status);
    }
    if (query.leadId) {
      conditions.push("lead_id = ?");
      params.push(query.leadId);
    }
    if (query.cursor) {
      conditions.push("id > ?");
      params.push(query.cursor);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT * FROM outbound_queue
      ${whereClause}
      ORDER BY id ASC
      LIMIT ?
    `;
    params.push(limit + 1);

    const rows = await app.db.prepare(sql).all(...params) as OutboundQueueRow[];
    const hasNext = rows.length > limit;
    const items = hasNext ? rows.slice(0, limit) : rows;
    const nextCursor = hasNext && items.length > 0 ? items[items.length - 1]!.id : null;

    return reply.code(200).send({
      items: items.map(formatOutboundRow),
      nextCursor,
    });
  });

  // POST /outbound/:id/approve
  app.post("/outbound/:id/approve", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { body?: string };
    const db = app.db;

    const row = await db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(id) as OutboundQueueRow | undefined;
    if (!row) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Outbound row not found.", details: {} },
      });
    }

    if (row.status !== "needs_approval") {
      return reply.code(409).send({
        error: { code: "conflict", message: "Row is not awaiting approval.", details: {} },
      });
    }

    const policy = await db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as DeskPolicy;
    const operator = await db.prepare("SELECT timezone FROM operator LIMIT 1").get() as { timezone: string } | undefined;
    const tz = operator?.timezone || "UTC";
    const now = Date.now();

    // If quiet hours are active, return 409 and leave status needs_approval
    if (quietHoursCover(now, policy, tz)) {
      return reply.code(409).send({
        error: { code: "quiet_hours", message: "Cannot approve during quiet hours.", details: {} },
      });
    }

    if (body.body !== undefined) {
      const approveBodyError = invalidBody(body.body);
      if (approveBodyError) {
        return reply.code(400).send({ error: { code: "validation", message: approveBodyError, details: {} } });
      }
    }

    if (row.lead_id) {
      const lead = await db.prepare("SELECT do_not_message, archived_at FROM lead WHERE id = ?").get(row.lead_id) as
        | { do_not_message: number; archived_at: number | null }
        | undefined;
      if (lead?.do_not_message) {
        return reply.code(409).send({
          error: { code: "do_not_message", message: "Lead has do_not_message set.", details: {} },
        });
      }
    }

    const newBody = typeof body.body === "string" ? body.body.trim() : row.body;
    await db.prepare(`
      UPDATE outbound_queue
      SET status = 'queued', body = ?, earliest_due_at = ?, due_at = ?
      WHERE id = ?
    `).run(newBody, now, now, id);

    const updated = await db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(id) as OutboundQueueRow;
    return reply.code(200).send(formatOutboundRow(updated));
  });

  // POST /outbound/:id/discard
  app.post("/outbound/:id/discard", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { id } = request.params as { id: string };
    const db = app.db;

    const row = await db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(id) as OutboundQueueRow | undefined;
    if (!row) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Outbound row not found.", details: {} },
      });
    }

    // Discarding must never rewrite history: a sent row stays sent, and a claimed row is
    // in the sender's hands (its ack/uncertain will settle it).
    if (row.status === "claimed" || row.status === "sent") {
      return reply.code(409).send({
        error: { code: "conflict", message: "Cannot discard a claimed or sent message.", details: {} },
      });
    }

    const now = Date.now();
    await db.transaction(async () => {
      await db.prepare("UPDATE outbound_queue SET status = 'cancelled' WHERE id = ?").run(id);
      if (row.enrollment_id) {
        await db.prepare(`
          UPDATE sequence_enrollment
          SET status = 'cancelled', stopped_at = ?, stop_reason = 'cancelled'
          WHERE id = ? AND status = 'active'
        `).run(now, row.enrollment_id);
      }
      if (row.scheduled_message_id) {
        await db.prepare("UPDATE scheduled_message SET status = 'cancelled' WHERE id = ?").run(row.scheduled_message_id);
      }
    });

    return reply.code(200).send({ id, status: "cancelled" });
  });

  // POST /outbound/:id/cancel
  app.post("/outbound/:id/cancel", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { id } = request.params as { id: string };
    const db = app.db;

    const row = await db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(id) as OutboundQueueRow | undefined;
    if (!row) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Outbound row not found.", details: {} },
      });
    }

    if (row.status === "claimed" || row.status === "sent") {
      return reply.code(409).send({
        error: { code: "conflict", message: "Cannot cancel claimed or sent message.", details: {} },
      });
    }

    const now = Date.now();
    await db.transaction(async () => {
      await db.prepare("UPDATE outbound_queue SET status = 'cancelled' WHERE id = ?").run(id);
      if (row.enrollment_id) {
        await db.prepare(`
          UPDATE sequence_enrollment
          SET status = 'cancelled', stopped_at = ?, stop_reason = 'cancelled'
          WHERE id = ? AND status = 'active'
        `).run(now, row.enrollment_id);
      }
      if (row.scheduled_message_id) {
        await db.prepare("UPDATE scheduled_message SET status = 'cancelled' WHERE id = ?").run(row.scheduled_message_id);
      }
    });

    return reply.code(200).send({ id, status: "cancelled" });
  });

  // POST /outbound/:id/retry
  app.post("/outbound/:id/retry", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { id } = request.params as { id: string };
    const db = app.db;

    const row = await db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(id) as OutboundQueueRow | undefined;
    if (!row) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Outbound row not found.", details: {} },
      });
    }

    if (row.status !== "failed" && row.status !== "needs_review") {
      return reply.code(409).send({
        error: { code: "conflict", message: "Can only retry failed or needs_review messages.", details: {} },
      });
    }

    const now = Date.now();
    await db.prepare(`
      UPDATE outbound_queue
      SET
        status = 'queued',
        due_at = ?,
        attempt_count = 0,
        claim_token_hash = NULL,
        ack_token_hash = NULL,
        claimed_by_device_id = NULL
      WHERE id = ?
    `).run(now, id);

    const updated = await db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(id) as OutboundQueueRow;
    return reply.code(200).send(formatOutboundRow(updated));
  });
};
