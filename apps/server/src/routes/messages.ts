import type { FastifyPluginAsync } from "fastify";
import { requireOperatorSession } from "../auth.js";

export const messagesRoutes: FastifyPluginAsync = async (app) => {
  // GET /messages
  app.get("/messages", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const query = (request.query ?? {}) as {
      leadId?: string;
      limit?: string;
      cursor?: string;
    };

    const limit = Math.min(Math.max(parseInt(query.limit ?? "50", 10) || 50, 1), 100);
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (query.leadId) {
      conditions.push("lead_id = ?");
      params.push(query.leadId);
    }

    if (query.cursor) {
      conditions.push("id < ?");
      params.push(query.cursor);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT * FROM message_log
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `;
    params.push(limit + 1);

    const rows = await app.db.prepare(sql).all(...params) as any[];
    const hasNext = rows.length > limit;
    const items = hasNext ? rows.slice(0, limit) : rows;
    const nextCursor = hasNext && items.length > 0 ? items[items.length - 1]!.id : null;

    return reply.code(200).send({
      items: items.map((r) => ({
        id: r.id,
        leadId: r.lead_id,
        direction: r.direction,
        waMessageId: r.wa_message_id,
        body: r.body,
        fromMe: Boolean(r.from_me),
        waTimestamp: new Date(r.wa_timestamp).toISOString(),
        aiState: r.ai_state,
        aiReason: r.ai_reason,
        outboundId: r.outbound_id,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor,
    });
  });
};
