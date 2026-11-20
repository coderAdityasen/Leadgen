import type { FastifyPluginAsync } from "fastify";
import { generateUlid } from "@leaddesk/shared";
import { requireOperatorSession } from "../auth.js";
import { parseAndNormalizePhone } from "../phone.js";
import { checkContactFields, getBoard, updateLead } from "../crm.js";

function validatePlaceholder(body: string): void {
  const matches = body.match(/\{\{([^}]+)\}\}/g);
  if (matches) {
    for (const match of matches) {
      if (match !== "{{display_name}}") {
        throw Object.assign(new Error("Only {{display_name}} placeholder is allowed."), { code: "validation" });
      }
    }
  }
}

interface LeadRow {
  id: string;
  display_name: string;
  notes: string;
  stage_id: string;
  ai_enabled: number;
  require_approval: number;
  automation_paused: number;
  do_not_message: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  email?: string | null;
  company?: string | null;
  stage_changed_at?: number | null;
}

interface PhoneRow {
  id: string;
  lead_id: string;
  e164: string | null;
  wa_jid: string | null;
  wa_lid: string | null;
  is_primary: number;
  created_at: number;
}

function formatLeadDetail(lead: LeadRow, phones: PhoneRow[], stageName?: string) {
  return {
    id: lead.id,
    displayName: lead.display_name,
    notes: lead.notes,
    email: lead.email ?? null,
    company: lead.company ?? null,
    stageId: lead.stage_id,
    stageName: stageName ?? "",
    aiEnabled: Boolean(lead.ai_enabled),
    requireApproval: Boolean(lead.require_approval),
    automationPaused: Boolean(lead.automation_paused),
    doNotMessage: Boolean(lead.do_not_message),
    archivedAt: lead.archived_at ? new Date(lead.archived_at).toISOString() : null,
    phones: phones.map((p) => ({
      id: p.id,
      e164: p.e164,
      waJid: p.wa_jid,
      waLid: p.wa_lid,
      primary: Boolean(p.is_primary),
      createdAt: new Date(p.created_at).toISOString(),
    })),
    createdAt: new Date(lead.created_at).toISOString(),
    updatedAt: new Date(lead.updated_at).toISOString(),
    stageChangedAt: new Date(lead.stage_changed_at ?? lead.created_at).toISOString(),
    lastInboundAt: lead.last_inbound_at ? new Date(lead.last_inbound_at).toISOString() : null,
    lastOutboundAt: lead.last_outbound_at ? new Date(lead.last_outbound_at).toISOString() : null,
  };
}

export const leadsRoutes: FastifyPluginAsync = async (app) => {
  // === LEADS ===

  // GET /leads/board — stage counts + enriched lead cards for the CRM board
  app.get("/leads/board", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const query = (request.query ?? {}) as { q?: string; stageId?: string; includeArchived?: string; limit?: string };
    const board = await getBoard(app.db, {
      q: query.q,
      stageId: query.stageId || undefined,
      includeArchived: query.includeArchived === "true",
      limit: query.limit ? parseInt(query.limit, 10) || undefined : undefined,
    });
    return reply.code(200).send(board);
  });

  // GET /leads
  app.get("/leads", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;
    const query = (request.query ?? {}) as {
      q?: string;
      stageId?: string;
      limit?: string;
      cursor?: string;
      includeArchived?: string;
    };

    const limit = Math.min(Math.max(parseInt(query.limit ?? "50", 10) || 50, 1), 100);
    const includeArchived = query.includeArchived === "true";

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (!includeArchived) {
      conditions.push("l.archived_at IS NULL");
    }

    if (query.stageId) {
      conditions.push("l.stage_id = ?");
      params.push(query.stageId);
    }

    if (query.q) {
      conditions.push("(l.display_name LIKE ? OR p.e164 LIKE ?)");
      const term = `%${query.q}%`;
      params.push(term, term);
    }

    if (query.cursor) {
      conditions.push("l.id > ?");
      params.push(query.cursor);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT l.*, s.name as stage_name, p.e164 as primary_phone
      FROM lead l
      JOIN stage s ON l.stage_id = s.id
      LEFT JOIN phone_identity p ON l.id = p.lead_id AND p.is_primary = 1
      ${whereClause}
      ORDER BY l.id ASC
      LIMIT ?
    `;
    params.push(limit + 1);

    const rows = await db.prepare(sql).all(...params) as (LeadRow & { stage_name: string; primary_phone: string | null })[];
    const hasNext = rows.length > limit;
    const items = hasNext ? rows.slice(0, limit) : rows;
    const nextCursor = hasNext && items.length > 0 ? items[items.length - 1]!.id : null;

    return reply.code(200).send({
      items: items.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        stageId: r.stage_id,
        stageName: r.stage_name,
        aiEnabled: Boolean(r.ai_enabled),
        requireApproval: Boolean(r.require_approval),
        automationPaused: Boolean(r.automation_paused),
        doNotMessage: Boolean(r.do_not_message),
        primaryPhone: r.primary_phone,
        lastInboundAt: r.last_inbound_at ? new Date(r.last_inbound_at).toISOString() : null,
        lastOutboundAt: r.last_outbound_at ? new Date(r.last_outbound_at).toISOString() : null,
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
      nextCursor,
    });
  });

  // POST /leads
  app.post("/leads", async (request, reply) => {
    const operator = await requireOperatorSession(request, reply);
    const db = app.db;
    const body = (request.body ?? {}) as {
      displayName?: string;
      notes?: string;
      stageId?: string;
      phoneE164?: string;
      email?: string;
      company?: string;
    };

    if (!body.displayName || typeof body.displayName !== "string" || !body.displayName.trim()) {
      return reply.code(400).send({
        error: { code: "validation", message: "displayName is required.", details: {} },
      });
    }

    let stageId = body.stageId;
    if (!stageId) {
      const defaultStage = await db.prepare("SELECT id FROM stage ORDER BY position ASC LIMIT 1").get() as { id: string } | undefined;
      if (!defaultStage) {
        return reply.code(400).send({
          error: { code: "validation", message: "No stage available.", details: {} },
        });
      }
      stageId = defaultStage.id;
    } else {
      const stage = await db.prepare("SELECT id FROM stage WHERE id = ?").get(stageId);
      if (!stage) {
        return reply.code(400).send({
          error: { code: "validation", message: "Invalid stageId.", details: {} },
        });
      }
    }

    let normalizedPhone: string | null = null;
    if (body.phoneE164) {
      try {
        normalizedPhone = parseAndNormalizePhone(body.phoneE164, operator.default_country).e164;
      } catch (err: unknown) {
        const errObj = err as { code?: string; message?: string };
        const code = errObj.code === "country_required" ? "country_required" : "validation";
        return reply.code(400).send({
          error: { code, message: errObj.message ?? "Invalid phone number.", details: {} },
        });
      }

      // Phone uniqueness check across leads
      const existingPhone = await db.prepare("SELECT id FROM phone_identity WHERE e164 = ?").get(normalizedPhone);
      if (existingPhone) {
        return reply.code(409).send({
          error: { code: "conflict", message: "A lead with this phone number already exists.", details: {} },
        });
      }
    }

    const contactCheck = checkContactFields(body.email, body.company);
    if (!contactCheck.ok) {
      return reply.code(contactCheck.status).send({
        error: { code: contactCheck.code, message: contactCheck.message, details: {} },
      });
    }

    const leadId = generateUlid("led");
    const now = Date.now();
    const notes = body.notes ?? "";
    const displayName = body.displayName.trim();

    await db.transaction(async () => {
      await db.prepare(`
        INSERT INTO lead (id, display_name, notes, stage_id, ai_enabled, require_approval, automation_paused, do_not_message, archived_at, created_at, updated_at, stage_changed_at)
        VALUES (?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?, ?)
      `).run(leadId, displayName, notes, stageId, now, now, now);
      if (body.email !== undefined || body.company !== undefined) {
        await updateLead(db, leadId, { email: body.email ?? null, company: body.company ?? null });
      }

      if (normalizedPhone) {
        const phoneId = generateUlid("phn");
        await db.prepare(`
          INSERT INTO phone_identity (id, lead_id, e164, wa_jid, wa_lid, is_primary, created_at)
          VALUES (?, ?, ?, NULL, NULL, 1, ?)
        `).run(phoneId, leadId, normalizedPhone, now);
      }
    });

    const lead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(leadId) as LeadRow;
    const phones = await db.prepare("SELECT * FROM phone_identity WHERE lead_id = ?").all(leadId) as PhoneRow[];
    const stage = await db.prepare("SELECT name FROM stage WHERE id = ?").get(lead.stage_id) as { name: string };

    return reply.code(201).send(formatLeadDetail(lead, phones, stage.name));
  });

  // GET /leads/:leadId
  app.get("/leads/:leadId", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;
    const { leadId } = request.params as { leadId: string };

    const lead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(leadId) as LeadRow | undefined;
    if (!lead) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Lead not found.", details: {} },
      });
    }

    const phones = await db.prepare("SELECT * FROM phone_identity WHERE lead_id = ? ORDER BY is_primary DESC, id ASC").all(leadId) as PhoneRow[];
    const stage = await db.prepare("SELECT name FROM stage WHERE id = ?").get(lead.stage_id) as { name: string } | undefined;

    return reply.code(200).send(formatLeadDetail(lead, phones, stage?.name));
  });

  // PATCH /leads/:leadId
  app.patch("/leads/:leadId", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;
    const { leadId } = request.params as { leadId: string };

    const lead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(leadId) as LeadRow | undefined;
    if (!lead) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Lead not found.", details: {} },
      });
    }

    const result = await updateLead(db, leadId, request.body);
    if (!result.ok) {
      return reply.code(result.status).send({
        error: { code: result.code, message: result.message, details: {} },
      });
    }

    const updated = await db.prepare("SELECT * FROM lead WHERE id = ?").get(leadId) as LeadRow;
    const phones = await db.prepare("SELECT * FROM phone_identity WHERE lead_id = ? ORDER BY is_primary DESC, id ASC").all(leadId) as PhoneRow[];
    const stage = await db.prepare("SELECT name FROM stage WHERE id = ?").get(updated.stage_id) as { name: string } | undefined;

    return reply.code(200).send(formatLeadDetail(updated, phones, stage?.name));
  });

  // POST /leads/:leadId/archive
  app.post("/leads/:leadId/archive", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;
    const { leadId } = request.params as { leadId: string };

    const lead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(leadId) as LeadRow | undefined;
    if (!lead) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Lead not found.", details: {} },
      });
    }

    const now = Date.now();
    await db.transaction(async () => {
      await db.prepare("UPDATE lead SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, leadId);
      await db.prepare(`
        UPDATE outbound_queue
        SET status = 'cancelled'
        WHERE lead_id = ? AND status IN ('queued', 'needs_approval')
      `).run(leadId);
      await db.prepare(`
        UPDATE sequence_enrollment
        SET status = 'cancelled', stopped_at = ?
        WHERE lead_id = ? AND status = 'active'
      `).run(now, leadId);
    });

    const updated = await db.prepare("SELECT * FROM lead WHERE id = ?").get(leadId) as LeadRow;
    const phones = await db.prepare("SELECT * FROM phone_identity WHERE lead_id = ?").all(leadId) as PhoneRow[];
    const stage = await db.prepare("SELECT name FROM stage WHERE id = ?").get(updated.stage_id) as { name: string } | undefined;

    return reply.code(200).send(formatLeadDetail(updated, phones, stage?.name));
  });

  // === PHONES ===

  // POST /leads/:leadId/phones
  app.post("/leads/:leadId/phones", async (request, reply) => {
    const operator = await requireOperatorSession(request, reply);
    const db = app.db;
    const { leadId } = request.params as { leadId: string };

    const lead = await db.prepare("SELECT id FROM lead WHERE id = ?").get(leadId);
    if (!lead) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Lead not found.", details: {} },
      });
    }

    const body = (request.body ?? {}) as { e164?: string; primary?: boolean };
    if (!body.e164) {
      return reply.code(400).send({
        error: { code: "validation", message: "e164 is required.", details: {} },
      });
    }

    let normalizedPhone: string;
    try {
      normalizedPhone = parseAndNormalizePhone(body.e164, operator.default_country).e164;
    } catch (err: unknown) {
      const errObj = err as { code?: string; message?: string };
      const code = errObj.code === "country_required" ? "country_required" : "validation";
      return reply.code(400).send({
        error: { code, message: errObj.message ?? "Invalid phone number.", details: {} },
      });
    }

    // Phone uniqueness check across leads
    const existingPhone = await db.prepare("SELECT id FROM phone_identity WHERE e164 = ?").get(normalizedPhone);
    if (existingPhone) {
      return reply.code(409).send({
        error: { code: "conflict", message: "A lead with this phone number already exists.", details: {} },
      });
    }

    const phoneId = generateUlid("phn");
    const isPrimary = body.primary ? 1 : 0;
    const now = Date.now();

    await db.transaction(async () => {
      if (isPrimary) {
        await db.prepare("UPDATE phone_identity SET is_primary = 0 WHERE lead_id = ?").run(leadId);
      }
      await db.prepare(`
        INSERT INTO phone_identity (id, lead_id, e164, wa_jid, wa_lid, is_primary, created_at)
        VALUES (?, ?, ?, NULL, NULL, ?, ?)
      `).run(phoneId, leadId, normalizedPhone, isPrimary, now);
    });

    const phone = await db.prepare("SELECT * FROM phone_identity WHERE id = ?").get(phoneId) as PhoneRow;
    return reply.code(201).send({
      id: phone.id,
      e164: phone.e164,
      waJid: phone.wa_jid,
      waLid: phone.wa_lid,
      primary: Boolean(phone.is_primary),
      createdAt: new Date(phone.created_at).toISOString(),
    });
  });

  // PATCH /phones/:phoneId
  app.patch("/phones/:phoneId", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;
    const { phoneId } = request.params as { phoneId: string };

    const phone = await db.prepare("SELECT * FROM phone_identity WHERE id = ?").get(phoneId) as PhoneRow | undefined;
    if (!phone) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Phone not found.", details: {} },
      });
    }

    const body = (request.body ?? {}) as { primary?: boolean };
    if (body.primary === true) {
      await db.transaction(async () => {
        await db.prepare("UPDATE phone_identity SET is_primary = 0 WHERE lead_id = ?").run(phone.lead_id);
        await db.prepare("UPDATE phone_identity SET is_primary = 1 WHERE id = ?").run(phoneId);
      });
    }

    const updated = await db.prepare("SELECT * FROM phone_identity WHERE id = ?").get(phoneId) as PhoneRow;
    return reply.code(200).send({
      id: updated.id,
      e164: updated.e164,
      waJid: updated.wa_jid,
      waLid: updated.wa_lid,
      primary: Boolean(updated.is_primary),
      createdAt: new Date(updated.created_at).toISOString(),
    });
  });

  // DELETE /phones/:phoneId
  app.delete("/phones/:phoneId", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;
    const { phoneId } = request.params as { phoneId: string };

    const phone = await db.prepare("SELECT * FROM phone_identity WHERE id = ?").get(phoneId) as PhoneRow | undefined;
    if (!phone) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Phone not found.", details: {} },
      });
    }

    // Refused with 409 if a queued or claimed outbound row still points at the phone
    const activeOutbound = await db
      .prepare("SELECT COUNT(*) as count FROM outbound_queue WHERE phone_id = ? AND status IN ('queued', 'claimed')")
      .get(phoneId) as { count: number };

    if (activeOutbound.count > 0) {
      return reply.code(409).send({
        error: {
          code: "conflict",
          message: "Outbound rows still point at this phone. Cancel those first.",
          details: {},
        },
      });
    }

    await db.prepare("DELETE FROM phone_identity WHERE id = ?").run(phoneId);
    return reply.code(204).send();
  });

  // === STAGES ===

  // GET /stages
  app.get("/stages", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const stages = await app.db
      .prepare("SELECT id, name, position FROM stage ORDER BY position ASC")
      .all() as { id: string; name: string; position: number }[];
    return reply.code(200).send({ items: stages });
  });

  // POST /stages
  app.post("/stages", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const body = (request.body ?? {}) as { name?: string };
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return reply.code(400).send({
        error: { code: "validation", message: "Stage name is required.", details: {} },
      });
    }

    const db = app.db;
    const maxPos = await db.prepare("SELECT MAX(position) as maxPos FROM stage").get() as { maxPos: number | null };
    const nextPos = (maxPos?.maxPos ?? -1) + 1;
    const stageId = generateUlid("stg");

    await db.prepare("INSERT INTO stage (id, pipeline_id, name, position) VALUES (?, 'pip_leads', ?, ?)").run(
      stageId,
      body.name.trim(),
      nextPos,
    );

    return reply.code(201).send({
      id: stageId,
      name: body.name.trim(),
      position: nextPos,
    });
  });

  // PATCH /stages/:stageId
  app.patch("/stages/:stageId", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { stageId } = request.params as { stageId: string };
    const body = (request.body ?? {}) as { name?: string };

    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return reply.code(400).send({
        error: { code: "validation", message: "Stage name is required.", details: {} },
      });
    }

    const db = app.db;
    const stage = await db.prepare("SELECT * FROM stage WHERE id = ?").get(stageId) as { id: string; name: string; position: number } | undefined;
    if (!stage) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Stage not found.", details: {} },
      });
    }

    await db.prepare("UPDATE stage SET name = ? WHERE id = ?").run(body.name.trim(), stageId);
    return reply.code(200).send({
      id: stageId,
      name: body.name.trim(),
      position: stage.position,
    });
  });

  // PUT /stages/order
  app.put("/stages/order", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const body = (request.body ?? {}) as { ids?: string[] };
    if (!body.ids || !Array.isArray(body.ids)) {
      return reply.code(400).send({
        error: { code: "validation", message: "ids array is required.", details: {} },
      });
    }

    const db = app.db;
    const allStages = await db.prepare("SELECT id FROM stage").all() as { id: string }[];
    const allSet = new Set(allStages.map((s) => s.id));

    if (
      body.ids.length !== allStages.length ||
      new Set(body.ids).size !== body.ids.length ||
      !body.ids.every((id) => allSet.has(id))
    ) {
      return reply.code(400).send({
        error: { code: "validation", message: "Must provide the exact full set of existing stage IDs.", details: {} },
      });
    }

    await db.transaction(async () => {
      // Offset positions to avoid unique constraint collision
      for (let i = 0; i < body.ids!.length; i++) {
        await db.prepare("UPDATE stage SET position = ? WHERE id = ?").run(1000 + i, body.ids![i]);
      }
      for (let i = 0; i < body.ids!.length; i++) {
        await db.prepare("UPDATE stage SET position = ? WHERE id = ?").run(i, body.ids![i]);
      }
    });

    const updated = await db.prepare("SELECT id, name, position FROM stage ORDER BY position ASC").all();
    return reply.code(200).send({ items: updated });
  });

  // === QUICK REPLIES ===

  // GET /quick-replies
  app.get("/quick-replies", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const items = await app.db
      .prepare("SELECT id, title, body, position FROM quick_reply ORDER BY position ASC")
      .all() as { id: string; title: string; body: string; position: number }[];
    return reply.code(200).send({ items });
  });

  // POST /quick-replies
  app.post("/quick-replies", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const body = (request.body ?? {}) as { title?: string; body?: string };

    if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
      return reply.code(400).send({
        error: { code: "validation", message: "title is required.", details: {} },
      });
    }
    if (!body.body || typeof body.body !== "string" || !body.body.trim()) {
      return reply.code(400).send({
        error: { code: "validation", message: "body is required.", details: {} },
      });
    }

    try {
      validatePlaceholder(body.body);
    } catch (err: unknown) {
      return reply.code(400).send({
        error: { code: "validation", message: (err as Error).message, details: {} },
      });
    }

    const db = app.db;
    const maxPos = await db.prepare("SELECT MAX(position) as maxPos FROM quick_reply").get() as { maxPos: number | null };
    const nextPos = (maxPos?.maxPos ?? -1) + 1;
    const qkrId = generateUlid("qkr");
    const now = Date.now();

    await db.prepare("INSERT INTO quick_reply (id, title, body, position, created_at) VALUES (?, ?, ?, ?, ?)").run(
      qkrId,
      body.title.trim(),
      body.body,
      nextPos,
      now,
    );

    return reply.code(201).send({
      id: qkrId,
      title: body.title.trim(),
      body: body.body,
      position: nextPos,
    });
  });

  // PATCH /quick-replies/:quickReplyId
  app.patch("/quick-replies/:quickReplyId", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { quickReplyId } = request.params as { quickReplyId: string };
    const db = app.db;

    const existing = await db.prepare("SELECT * FROM quick_reply WHERE id = ?").get(quickReplyId) as
      | { id: string; title: string; body: string; position: number }
      | undefined;

    if (!existing) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Quick reply not found.", details: {} },
      });
    }

    const body = (request.body ?? {}) as { title?: string; body?: string; position?: number };
    if (body.body !== undefined) {
      try {
        validatePlaceholder(body.body);
      } catch (err: unknown) {
        return reply.code(400).send({
          error: { code: "validation", message: (err as Error).message, details: {} },
        });
      }
    }

    if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim())) {
      return reply.code(400).send({
        error: { code: "validation", message: "title must be a non-empty string.", details: {} },
      });
    }
    if (body.body !== undefined && (typeof body.body !== "string" || !body.body.trim())) {
      return reply.code(400).send({
        error: { code: "validation", message: "body must be a non-empty string.", details: {} },
      });
    }
    const title = body.title !== undefined ? body.title.trim() : existing.title;
    const qBody = body.body !== undefined ? body.body : existing.body;
    const position = body.position !== undefined ? body.position : existing.position;

    await db.prepare("UPDATE quick_reply SET title = ?, body = ?, position = ? WHERE id = ?").run(
      title,
      qBody,
      position,
      quickReplyId,
    );

    return reply.code(200).send({
      id: quickReplyId,
      title,
      body: qBody,
      position,
    });
  });

  // DELETE /quick-replies/:quickReplyId
  app.delete("/quick-replies/:quickReplyId", async (request, reply) => {
    await requireOperatorSession(request, reply);
    await app.db.prepare("DELETE FROM quick_reply WHERE id = ?").run((request.params as { quickReplyId: string }).quickReplyId);
    return reply.code(204).send();
  });
};
