import type { Db } from "../db.js";
import type { FastifyPluginAsync } from "fastify";
import { generateUlid } from "@leaddesk/shared";
import { requireOperatorSession } from "../auth.js";
import {
  quietHoursCover,
  nextOpenMinute,
  type DeskPolicy,
} from "../policy.js";

function validatePlaceholder(body: string): boolean {
  // Check for any {{ not followed by display_name}}
  const invalid = /\{\{(?!display_name\}\})/g.test(body);
  return !invalid;
}

export const sequencesRoutes: FastifyPluginAsync = async (app) => {
  // GET /sequences
  app.get("/sequences", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;

    const rows = await db.prepare(`
      SELECT
        s.*,
        (SELECT COUNT(*) FROM sequence_step WHERE sequence_id = s.id) as step_count
      FROM sequence s
      ORDER BY s.created_at DESC
    `).all() as any[];

    return reply.code(200).send({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: Boolean(r.enabled),
        stepCount: r.step_count,
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    });
  });

  // POST /sequences
  app.post("/sequences", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const body = (request.body ?? {}) as { name?: string };

    if (!body.name || !body.name.trim()) {
      return reply.code(400).send({
        error: { code: "validation", message: "name is required.", details: {} },
      });
    }

    const id = generateUlid("seq");
    const now = Date.now();
    const name = body.name.trim();

    await app.db.prepare(`
      INSERT INTO sequence (id, name, enabled, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
    `).run(id, name, now, now);

    return reply.code(201).send({
      id,
      name,
      enabled: true,
      steps: [],
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
  });

  // GET /sequences/:sequenceId
  app.get("/sequences/:sequenceId", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { sequenceId } = request.params as { sequenceId: string };
    const db = app.db;

    const seq = await db.prepare("SELECT * FROM sequence WHERE id = ?").get(sequenceId) as any;
    if (!seq) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Sequence not found.", details: {} },
      });
    }

    const steps = await db.prepare(`
      SELECT * FROM sequence_step
      WHERE sequence_id = ?
      ORDER BY position ASC
    `).all(sequenceId) as any[];

    return reply.code(200).send({
      id: seq.id,
      name: seq.name,
      enabled: Boolean(seq.enabled),
      steps: steps.map((s) => ({
        id: s.id,
        position: s.position,
        delaySeconds: s.delay_seconds,
        body: s.body,
      })),
      createdAt: new Date(seq.created_at).toISOString(),
      updatedAt: new Date(seq.updated_at).toISOString(),
    });
  });

  // PATCH /sequences/:sequenceId
  app.patch("/sequences/:sequenceId", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { sequenceId } = request.params as { sequenceId: string };
    const body = (request.body ?? {}) as { name?: string; enabled?: boolean };
    const db = app.db;

    const seq = await db.prepare("SELECT * FROM sequence WHERE id = ?").get(sequenceId) as any;
    if (!seq) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Sequence not found.", details: {} },
      });
    }

    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
      return reply.code(400).send({
        error: { code: "validation", message: "name must be a non-empty string.", details: {} },
      });
    }
    const newName = body.name !== undefined ? body.name.trim().slice(0, 200) : seq.name;
    const newEnabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : seq.enabled;
    const now = Date.now();

    await db.prepare(`
      UPDATE sequence
      SET name = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(newName, newEnabled, now, sequenceId);

    const steps = await db.prepare("SELECT * FROM sequence_step WHERE sequence_id = ? ORDER BY position ASC").all(sequenceId) as any[];

    return reply.code(200).send({
      id: sequenceId,
      name: newName,
      enabled: Boolean(newEnabled),
      steps: steps.map((s) => ({
        id: s.id,
        position: s.position,
        delaySeconds: s.delay_seconds,
        body: s.body,
      })),
      createdAt: new Date(seq.created_at).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
  });

  // DELETE /sequences/:sequenceId
  app.delete("/sequences/:sequenceId", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { sequenceId } = request.params as { sequenceId: string };
    const db = app.db;

    const seq = await db.prepare("SELECT * FROM sequence WHERE id = ?").get(sequenceId) as any;
    if (!seq) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Sequence not found.", details: {} },
      });
    }

    // 409 if any enrollment is active
    const active = await db.prepare("SELECT COUNT(*) as c FROM sequence_enrollment WHERE sequence_id = ? AND status = 'active'").get(sequenceId) as { c: number };
    if (active.c > 0) {
      return reply.code(409).send({
        error: { code: "active_enrollments", message: "Cannot delete sequence with active enrollments.", details: {} },
      });
    }

    // Past enrollments and sent steps reference this sequence (ON DELETE RESTRICT keeps the
    // send history intact). Deleting would fail with a foreign-key error, so say so clearly.
    const history = await db.prepare("SELECT COUNT(*) as c FROM sequence_enrollment WHERE sequence_id = ?").get(sequenceId) as { c: number };
    if (history.c > 0) {
      return reply.code(409).send({
        error: {
          code: "has_history",
          message: "This sequence has past enrollments and is kept for history. Disable it instead of deleting.",
          details: {},
        },
      });
    }

    await db.transaction(async () => {
      await db.prepare("DELETE FROM sequence_step WHERE sequence_id = ?").run(sequenceId);
      await db.prepare("DELETE FROM sequence WHERE id = ?").run(sequenceId);
    });

    return reply.code(204).send();
  });

  // PUT /sequences/:sequenceId/steps
  app.put("/sequences/:sequenceId/steps", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { sequenceId } = request.params as { sequenceId: string };
    const body = (request.body ?? {}) as {
      steps?: Array<{ delaySeconds: number; body: string }>;
    };
    const db = app.db;

    const seq = await db.prepare("SELECT * FROM sequence WHERE id = ?").get(sequenceId) as any;
    if (!seq) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Sequence not found.", details: {} },
      });
    }

    if (!Array.isArray(body.steps) || body.steps.length === 0) {
      return reply.code(400).send({
        error: { code: "validation", message: "steps array is required.", details: {} },
      });
    }

    if (body.steps.length > 10) {
      return reply.code(400).send({
        error: { code: "validation", message: "At most 10 steps allowed.", details: {} },
      });
    }

    // Replaces steps only when sequence has zero enrollments in any status
    const enrollmentCount = await db.prepare("SELECT COUNT(*) as c FROM sequence_enrollment WHERE sequence_id = ?").get(sequenceId) as { c: number };
    if (enrollmentCount.c > 0) {
      return reply.code(409).send({
        error: { code: "steps_in_use", message: "Cannot modify steps of a sequence that has enrollments.", details: {} },
      });
    }

    for (let i = 0; i < body.steps.length; i++) {
      const step = body.steps[i]!;
      if (!step || typeof step.delaySeconds !== "number" || !Number.isFinite(step.delaySeconds) || step.delaySeconds < 0 || step.delaySeconds > 2592000) {
        return reply.code(400).send({
          error: { code: "validation", message: `Step ${i}: delaySeconds must be between 0 and 2592000 (30 days).`, details: {} },
        });
      }
      if (!step || typeof step.body !== "string" || !step.body.trim() || step.body.length > 4096) {
        return reply.code(400).send({
          error: { code: "validation", message: `Step ${i}: body must be between 1 and 4096 characters.`, details: {} },
        });
      }
      if (!validatePlaceholder(step.body)) {
        return reply.code(400).send({
          error: { code: "validation", message: `Step ${i}: only {{display_name}} placeholder is allowed.`, details: {} },
        });
      }
    }

    const now = Date.now();
    await db.transaction(async () => {
      await db.prepare("DELETE FROM sequence_step WHERE sequence_id = ?").run(sequenceId);

      for (let i = 0; i < body.steps!.length; i++) {
        const step = body.steps![i]!;
        const stepId = generateUlid("stp");
        await db.prepare(`
          INSERT INTO sequence_step (id, sequence_id, position, delay_seconds, body)
          VALUES (?, ?, ?, ?, ?)
        `).run(stepId, sequenceId, i, Math.floor(step.delaySeconds), step.body.trim());
      }

      await db.prepare("UPDATE sequence SET updated_at = ? WHERE id = ?").run(now, sequenceId);
    });

    const updatedSteps = await db.prepare("SELECT * FROM sequence_step WHERE sequence_id = ? ORDER BY position ASC").all(sequenceId) as any[];

    return reply.code(200).send({
      id: seq.id,
      name: seq.name,
      enabled: Boolean(seq.enabled),
      steps: updatedSteps.map((s) => ({
        id: s.id,
        position: s.position,
        delaySeconds: s.delay_seconds,
        body: s.body,
      })),
      createdAt: new Date(seq.created_at).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
  });

  // POST /sequences/:sequenceId/enrollments
  app.post("/sequences/:sequenceId/enrollments", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { sequenceId } = request.params as { sequenceId: string };
    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;

    if (!idempotencyKey) {
      return reply.code(400).send({
        error: { code: "validation", message: "Idempotency-Key header is required.", details: {} },
      });
    }

    const body = (request.body ?? {}) as { leadId?: string };
    if (typeof body.leadId !== "string" || !body.leadId) {
      return reply.code(400).send({
        error: { code: "validation", message: "leadId is required.", details: {} },
      });
    }

    const result = await enrollLeadInSequence(app.db, sequenceId, body.leadId, idempotencyKey);
    return reply.code(result.code).send(result.body);
  });

  // GET /enrollments
  app.get("/enrollments", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const query = (request.query ?? {}) as { leadId?: string; status?: string };
    const db = app.db;

    const conditions: string[] = [];
    const params: string[] = [];

    if (query.leadId) {
      conditions.push("e.lead_id = ?");
      params.push(query.leadId);
    }
    if (query.status) {
      conditions.push("e.status = ?");
      params.push(query.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT
        e.*,
        s.name as sequence_name
      FROM sequence_enrollment e
      JOIN sequence s ON s.id = e.sequence_id
      ${whereClause}
      ORDER BY e.started_at DESC
    `;

    const rows = await db.prepare(sql).all(...params) as any[];

    return reply.code(200).send({
      items: rows.map((r) => ({
        id: r.id,
        sequenceId: r.sequence_id,
        sequenceName: r.sequence_name,
        leadId: r.lead_id,
        status: r.status,
        currentStepId: r.current_step_id,
        startedAt: new Date(r.started_at).toISOString(),
        stoppedAt: r.stopped_at ? new Date(r.stopped_at).toISOString() : null,
      })),
    });
  });

  // POST /enrollments/:enrollmentId/cancel
  app.post("/enrollments/:enrollmentId/cancel", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { enrollmentId } = request.params as { enrollmentId: string };
    const db = app.db;

    const enr = await db.prepare("SELECT * FROM sequence_enrollment WHERE id = ?").get(enrollmentId) as any;
    if (!enr) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Enrollment not found.", details: {} },
      });
    }
    if (enr.status !== "active") {
      return reply.code(409).send({
        error: { code: "conflict", message: `Enrollment is already ${enr.status}.`, details: {} },
      });
    }

    const now = Date.now();
    await db.transaction(async () => {
      await db.prepare(`
        UPDATE sequence_enrollment
        SET status = 'cancelled', stopped_at = ?, stop_reason = 'cancelled'
        WHERE id = ?
      `).run(now, enrollmentId);

      // Cancel current step's outbound row if still queued or needs_approval
      await db.prepare(`
        UPDATE outbound_queue
        SET status = 'cancelled'
        WHERE enrollment_id = ? AND status IN ('queued', 'needs_approval')
      `).run(enrollmentId);
    });

    return reply.code(200).send({
      id: enrollmentId,
      sequenceId: enr.sequence_id,
      leadId: enr.lead_id,
      status: "cancelled",
      currentStepId: enr.current_step_id,
      startedAt: new Date(enr.started_at).toISOString(),
      stoppedAt: new Date(now).toISOString(),
    });
  });
};

/**
 * Fill the {{display_name}} placeholder. A replacer function is used so `$&`, `$'` etc. in a
 * lead's name are inserted literally instead of being treated as replacement patterns.
 */
export function renderStepBody(template: string, displayName: string | null | undefined): string {
  const name = displayName ?? "";
  return template.replace(/\{\{display_name\}\}/g, () => name);
}

export interface RouteResult {
  code: number;
  body: any;
}

/**
 * Enroll a lead in a sequence: materializes step 0 into the outbound queue. Shared by the
 * dashboard route and the WhatsApp side panel. Idempotent on `idempotencyKey`.
 */
export async function enrollLeadInSequence(
  db: Db,
  sequenceId: string,
  leadId: string,
  idempotencyKey: string
): Promise<RouteResult> {
  const res = (code: number, body: any): RouteResult => ({ code, body });
  const now = Date.now();

  // Idempotency replay check
  const existingEnrollment = await db.prepare("SELECT * FROM sequence_enrollment WHERE idempotency_key = ?").get(idempotencyKey) as any;
  if (existingEnrollment) {
    return res(201, {
      id: existingEnrollment.id,
      sequenceId: existingEnrollment.sequence_id,
      leadId: existingEnrollment.lead_id,
      status: existingEnrollment.status,
      currentStepId: existingEnrollment.current_step_id,
      startedAt: new Date(existingEnrollment.started_at).toISOString(),
    });
  }

  const seq = await db.prepare("SELECT * FROM sequence WHERE id = ?").get(sequenceId) as any;
  if (!seq || !seq.enabled) {
    return res(409, {
      error: { code: "conflict", message: "Sequence not found or disabled.", details: {} },
    });
  }

  const step0 = await db.prepare("SELECT * FROM sequence_step WHERE sequence_id = ? AND position = 0").get(sequenceId) as any;
  if (!step0) {
    return res(409, {
      error: { code: "no_steps", message: "Sequence has no steps configured.", details: {} },
    });
  }

  const lead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(leadId) as any;
  if (!lead) {
    return res(404, {
      error: { code: "not_found", message: "Lead not found.", details: {} },
    });
  }
  if (lead.archived_at) {
    return res(409, {
      error: { code: "archived", message: "Lead is archived.", details: {} },
    });
  }

  if (lead.do_not_message) {
    return res(409, {
      error: { code: "do_not_message", message: "Lead has do_not_message set.", details: {} },
    });
  }

  // Check one active enrollment per lead across all sequences
  const existingActive = await db.prepare("SELECT * FROM sequence_enrollment WHERE lead_id = ? AND status = 'active'").get(leadId) as any;
  if (existingActive) {
    return res(409, {
      error: { code: "already_enrolled", message: "Lead already has an active sequence enrollment.", details: {} },
    });
  }

  const primaryPhone = await db.prepare("SELECT * FROM phone_identity WHERE lead_id = ? AND is_primary = 1").get(leadId) as any;
  if (!primaryPhone) {
    return res(400, {
      error: { code: "no_phone", message: "Lead has no primary phone.", details: {} },
    });
  }

  const policy = await db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as DeskPolicy;
  const operator = await db.prepare("SELECT timezone FROM operator LIMIT 1").get() as { timezone: string } | undefined;
  const tz = operator?.timezone || "UTC";

  const earliestDueAt = now + (step0.delay_seconds * 1000);
  let dueAt = earliestDueAt;
  if (quietHoursCover(earliestDueAt, policy, tz)) {
    dueAt = nextOpenMinute(earliestDueAt, policy, tz);
  }

  const concreteBody = renderStepBody(step0.body, lead.display_name);
  const enrollmentId = generateUlid("enr");
  const outboundId = generateUlid("out");
  const toJid = primaryPhone.wa_lid || primaryPhone.wa_jid || null;
  const needsResolve = toJid ? 0 : 1;
  const stepIdempotencyKey = `seq:${enrollmentId}:${step0.id}`;

  await db.transaction(async () => {
    await db.prepare(`
      INSERT INTO sequence_enrollment (
        id, sequence_id, lead_id, status, current_step_id, started_at, idempotency_key
      ) VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).run(enrollmentId, sequenceId, leadId, step0.id, now, idempotencyKey);

    await db.prepare(`
      INSERT INTO outbound_queue (
        id, lead_id, phone_id, to_e164, to_jid, needs_resolve, body, kind, status,
        earliest_due_at, due_at, enrollment_id, step_id, idempotency_key, allow_during_quiet_hours, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'sequence', 'queued', ?, ?, ?, ?, ?, 0, ?)
    `).run(
      outboundId,
      leadId,
      primaryPhone.id,
      primaryPhone.e164,
      toJid,
      needsResolve,
      concreteBody,
      earliestDueAt,
      dueAt,
      enrollmentId,
      step0.id,
      stepIdempotencyKey,
      now
    );
  });

  return res(201, {
    id: enrollmentId,
    sequenceId,
    leadId: leadId,
    status: "active",
    currentStepId: step0.id,
    startedAt: new Date(now).toISOString(),
  });
}
