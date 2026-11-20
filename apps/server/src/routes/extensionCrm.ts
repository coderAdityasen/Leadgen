/**
 * CRM routes for the WhatsApp Web side panel. Authenticated with the extension's device
 * token (the operator paired that browser), never with a page-world credential: the panel
 * lives in the isolated content script and reaches these routes through the service worker.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { requireExtensionDevice } from "../auth.js";
import {
  cancelActiveEnrollment,
  createLeadFromContact,
  findLeadIdByContact,
  getBoard,
  getLeadCard,
  listSequencesBrief,
  listStagesWithCounts,
  updateLead,
  type Result,
} from "../crm.js";
import { enrollLeadInSequence } from "./sequences.js";

function sendFailure(reply: FastifyReply, result: Extract<Result<unknown>, { ok: false }>) {
  return reply.code(result.status).send({
    error: { code: result.code, message: result.message, details: {} },
  });
}

export const extensionCrmRoutes: FastifyPluginAsync = async (app) => {
  // GET /extension/crm/board?stageId=&q= — stage counts and (optionally filtered) lead list
  app.get("/extension/crm/board", async (request, reply) => {
    await requireExtensionDevice(request, reply);
    const query = (request.query ?? {}) as { q?: string; stageId?: string };
    return reply.code(200).send(
      await getBoard(app.db, { q: query.q, stageId: query.stageId || undefined, limit: 200 })
    );
  });

  // GET /extension/crm/contact?chatJid=&lid=&phoneUser= — the lead behind the open chat
  app.get("/extension/crm/contact", async (request, reply) => {
    await requireExtensionDevice(request, reply);
    const query = (request.query ?? {}) as { chatJid?: string; lid?: string; phoneUser?: string };
    const leadId = await findLeadIdByContact(app.db, query);
    return reply.code(200).send({
      lead: leadId ? await getLeadCard(app.db, leadId) : null,
      stages: await listStagesWithCounts(app.db),
      sequences: await listSequencesBrief(app.db),
    });
  });

  // POST /extension/crm/leads — save the open chat as a lead
  app.post("/extension/crm/leads", async (request, reply) => {
    await requireExtensionDevice(request, reply);
    const result = await createLeadFromContact(app.db, (request.body ?? {}) as any);
    if (!result.ok) return sendFailure(reply, result);
    return reply.code(201).send({ lead: await getLeadCard(app.db, result.value) });
  });

  // PATCH /extension/crm/leads/:leadId — stage, notes, toggles, name, email, company
  app.patch("/extension/crm/leads/:leadId", async (request, reply) => {
    await requireExtensionDevice(request, reply);
    const { leadId } = request.params as { leadId: string };
    const result = await updateLead(app.db, leadId, request.body);
    if (!result.ok) return sendFailure(reply, result);
    return reply.code(200).send({ lead: await getLeadCard(app.db, leadId) });
  });

  // POST /extension/crm/leads/:leadId/enroll { sequenceId }
  app.post("/extension/crm/leads/:leadId/enroll", async (request, reply) => {
    await requireExtensionDevice(request, reply);
    const { leadId } = request.params as { leadId: string };
    const body = (request.body ?? {}) as { sequenceId?: unknown };
    if (typeof body.sequenceId !== "string" || !body.sequenceId) {
      return reply.code(400).send({
        error: { code: "validation", message: "sequenceId is required.", details: {} },
      });
    }
    const headerKey = request.headers["idempotency-key"];
    const key = typeof headerKey === "string" && headerKey ? headerKey : randomUUID();
    const result = await enrollLeadInSequence(app.db, body.sequenceId, leadId, `ext:${key}`);
    if (result.code >= 400) return reply.code(result.code).send(result.body);
    return reply.code(result.code).send({ enrollment: result.body, lead: await getLeadCard(app.db, leadId) });
  });

  // POST /extension/crm/leads/:leadId/enrollment/cancel
  app.post("/extension/crm/leads/:leadId/enrollment/cancel", async (request, reply) => {
    await requireExtensionDevice(request, reply);
    const { leadId } = request.params as { leadId: string };
    const result = await cancelActiveEnrollment(app.db, leadId);
    if (!result.ok) return sendFailure(reply, result);
    return reply.code(200).send({ lead: await getLeadCard(app.db, leadId) });
  });
};
