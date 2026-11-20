import type { FastifyPluginAsync } from "fastify";
import { requireOperatorSession } from "../auth.js";
import type { DeskPolicy } from "../policy.js";

function isValidHHMM(time: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
}

function formatPolicy(row: DeskPolicy) {
  const sendingKillSwitch = process.env["LEAD_DESK_SENDING_ENABLED"] === "false";
  const aiKillSwitch = process.env["LEAD_DESK_AI_ENABLED"] === "false";

  return {
    quietHoursEnabled: Boolean(row.quiet_hours_enabled),
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    dailyAutomatedCap: row.daily_automated_cap,
    dailyManualCap: row.daily_manual_cap,
    minAutomatedGapSeconds: row.min_automated_gap_seconds,
    minSameLeadGapSeconds: row.min_same_lead_gap_seconds,
    aiHourlyCap: row.ai_hourly_cap,
    maxCatchupAgeSeconds: row.max_catchup_age_seconds,
    sendingKillSwitch,
    aiKillSwitch,
  };
}

export const policyRoutes: FastifyPluginAsync = async (app) => {
  // GET /desk-policy
  app.get("/desk-policy", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const row = await app.db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as DeskPolicy;
    return reply.code(200).send(formatPolicy(row));
  });

  // PUT /desk-policy
  app.put("/desk-policy", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const body = (request.body ?? {}) as {
      quietHoursEnabled?: boolean;
      quietStart?: string;
      quietEnd?: string;
      dailyAutomatedCap?: number;
      dailyManualCap?: number;
      minAutomatedGapSeconds?: number;
      minSameLeadGapSeconds?: number;
      aiHourlyCap?: number;
      maxCatchupAgeSeconds?: number;
    };

    if (body.quietStart !== undefined && !isValidHHMM(body.quietStart)) {
      return reply.code(400).send({
        error: { code: "validation", message: "quietStart must be HH:MM in 24-hour format.", details: {} },
      });
    }

    if (body.quietEnd !== undefined && !isValidHHMM(body.quietEnd)) {
      return reply.code(400).send({
        error: { code: "validation", message: "quietEnd must be HH:MM in 24-hour format.", details: {} },
      });
    }

    if (
      body.dailyAutomatedCap !== undefined &&
      (!Number.isInteger(body.dailyAutomatedCap) || body.dailyAutomatedCap < 1 || body.dailyAutomatedCap > 500)
    ) {
      return reply.code(400).send({
        error: { code: "validation", message: "dailyAutomatedCap must be an integer between 1 and 500.", details: {} },
      });
    }

    if (
      body.dailyManualCap !== undefined &&
      (!Number.isInteger(body.dailyManualCap) || body.dailyManualCap < 1 || body.dailyManualCap > 500)
    ) {
      return reply.code(400).send({
        error: { code: "validation", message: "dailyManualCap must be an integer between 1 and 500.", details: {} },
      });
    }

    if (
      body.minAutomatedGapSeconds !== undefined &&
      (!Number.isInteger(body.minAutomatedGapSeconds) || body.minAutomatedGapSeconds < 5 || body.minAutomatedGapSeconds > 3600)
    ) {
      return reply.code(400).send({
        error: { code: "validation", message: "minAutomatedGapSeconds must be an integer between 5 and 3600.", details: {} },
      });
    }

    if (
      body.minSameLeadGapSeconds !== undefined &&
      (!Number.isInteger(body.minSameLeadGapSeconds) || body.minSameLeadGapSeconds < 5 || body.minSameLeadGapSeconds > 3600)
    ) {
      return reply.code(400).send({
        error: { code: "validation", message: "minSameLeadGapSeconds must be an integer between 5 and 3600.", details: {} },
      });
    }

    const current = await app.db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as DeskPolicy;
    const automatedGap = body.minAutomatedGapSeconds ?? current.min_automated_gap_seconds;
    const sameLeadGap = body.minSameLeadGapSeconds ?? current.min_same_lead_gap_seconds;

    if (sameLeadGap < automatedGap) {
      return reply.code(400).send({
        error: {
          code: "validation",
          message: "minSameLeadGapSeconds must be at least minAutomatedGapSeconds.",
          details: {},
        },
      });
    }

    if (
      body.aiHourlyCap !== undefined &&
      (!Number.isInteger(body.aiHourlyCap) || body.aiHourlyCap < 1 || body.aiHourlyCap > 100)
    ) {
      return reply.code(400).send({
        error: { code: "validation", message: "aiHourlyCap must be an integer between 1 and 100.", details: {} },
      });
    }

    if (
      body.maxCatchupAgeSeconds !== undefined &&
      (!Number.isInteger(body.maxCatchupAgeSeconds) || body.maxCatchupAgeSeconds < 300 || body.maxCatchupAgeSeconds > 86400)
    ) {
      return reply.code(400).send({
        error: { code: "validation", message: "maxCatchupAgeSeconds must be between 300 and 86400.", details: {} },
      });
    }

    const now = Date.now();
    await app.db.prepare(`
      UPDATE desk_policy
      SET
        quiet_hours_enabled = ?,
        quiet_start = ?,
        quiet_end = ?,
        daily_automated_cap = ?,
        daily_manual_cap = ?,
        min_automated_gap_seconds = ?,
        min_same_lead_gap_seconds = ?,
        ai_hourly_cap = ?,
        max_catchup_age_seconds = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      body.quietHoursEnabled !== undefined ? (body.quietHoursEnabled ? 1 : 0) : current.quiet_hours_enabled,
      body.quietStart ?? current.quiet_start,
      body.quietEnd ?? current.quiet_end,
      body.dailyAutomatedCap ?? current.daily_automated_cap,
      body.dailyManualCap ?? current.daily_manual_cap,
      automatedGap,
      sameLeadGap,
      body.aiHourlyCap ?? current.ai_hourly_cap,
      body.maxCatchupAgeSeconds ?? current.max_catchup_age_seconds,
      now
    );

    const updated = await app.db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as DeskPolicy;
    return reply.code(200).send(formatPolicy(updated));
  });
};
