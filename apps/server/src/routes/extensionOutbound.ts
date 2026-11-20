import type { FastifyPluginAsync } from "fastify";
import { requireExtensionDevice, sha256 } from "../auth.js";
import { claimNext, type OutboundQueueRow } from "../queue.js";
import { generateUlid } from "@leaddesk/shared";
import { quietHoursCover, nextOpenMinute, type DeskPolicy } from "../policy.js";
import { recipientWidMatches } from "../recipient.js";
import { renderStepBody } from "./sequences.js";
import { accountCanSend } from "../billing.js";
import { currentAccountId } from "../tenancy.js";

const TRANSIENT_BACKOFF = [30_000, 120_000, 480_000, 1800_000];

export const extensionOutboundRoutes: FastifyPluginAsync = async (app) => {
  // POST /extension/outbound/claim
  app.post("/extension/outbound/claim", async (request, reply) => {
    const device = await requireExtensionDevice(request, reply);
    const now = Date.now();
    // Unpaid (past the grace period): hand out nothing. Messages stay queued, and the catch-up
    // limit expires stale ones, so paying later does not flood contacts with old messages.
    if (!await accountCanSend(app.control, currentAccountId(), now)) {
      return reply.code(200).send({ item: null, reason: "billing_inactive", retryAfterMs: 300_000 });
    }
    const result = await claimNext(app.db, device.id, now);
    return reply.code(200).send(result);
  });

  // POST /extension/outbound/:outboundId/ack
  app.post("/extension/outbound/:outboundId/ack", async (request, reply) => {
    const device = await requireExtensionDevice(request, reply);
    const { outboundId } = request.params as { outboundId: string };
    const body = (request.body ?? {}) as {
      claimToken?: string;
      waMessageId?: string;
      toJid?: string;
      phoneJid?: string | null;
    };

    if (
      typeof body.claimToken !== "string" ||
      typeof body.waMessageId !== "string" ||
      typeof body.toJid !== "string" ||
      !body.claimToken ||
      !body.waMessageId ||
      !body.toJid
    ) {
      return reply.code(400).send({
        error: { code: "validation", message: "claimToken, waMessageId, and toJid are required.", details: {} },
      });
    }

    const db = app.db;
    const now = Date.now();
    const tokenHash = sha256(body.claimToken);
    const toJid = body.toJid;
    const phoneJid = typeof body.phoneJid === "string" ? body.phoneJid : null;
    const waMessageId = body.waMessageId;

    const tx = () => db.transaction(async (): Promise<{ code: number; body: any }> => {
      const row = await db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(outboundId) as
        | OutboundQueueRow
        | undefined;

      if (!row) {
        return {
          code: 404,
          body: { error: { code: "not_found", message: "Outbound row not found.", details: {} } },
        };
      }

      // Lost-200 replay: status already sent, same waMessageId, same device
      if (row.status === "sent") {
        if (row.wa_message_id === waMessageId && row.claimed_by_device_id === device.id) {
          return { code: 200, body: { status: "sent" } };
        }
        return {
          code: 409,
          body: { error: { code: "conflict", message: "Outbound row already sent with different message id.", details: {} } },
        };
      }

      // Check caller device
      if (row.claimed_by_device_id !== device.id) {
        return {
          code: 409,
          body: { error: { code: "conflict", message: "Device mismatch.", details: {} } },
        };
      }

      // First commit eligibility:
      const isClaimedValid = row.status === "claimed" && row.claim_token_hash === tokenHash;
      const isNeedsReviewValid =
        row.status === "needs_review" && row.ack_token_hash === tokenHash && row.claim_token_hash === null;

      if (!isClaimedValid && !isNeedsReviewValid) {
        return {
          code: 409,
          body: { error: { code: "conflict", message: "Invalid claim token or row status.", details: {} } },
        };
      }

      const recipientMatches = recipientWidMatches(row, toJid, phoneJid);

      if (!recipientMatches) {
        // Status becomes needs_review, ack is not a success
        await db.prepare(`
          UPDATE outbound_queue
          SET status = 'needs_review', claim_token_hash = NULL, last_error = 'recipient_wid_mismatch'
          WHERE id = ?
        `).run(outboundId);
        return { code: 200, body: { status: "needs_review" } };
      }

      // Commit success
      await db.prepare(`
        UPDATE outbound_queue
        SET
          status = 'sent',
          sent_at = ?,
          wa_message_id = ?,
          to_jid = ?,
          needs_resolve = 0,
          claim_token_hash = NULL,
          ack_token_hash = NULL
        WHERE id = ?
      `).run(now, waMessageId, toJid, outboundId);

      if (row.phone_id) {
        const lid = toJid.endsWith("@lid") ? toJid : null;
        const phoneWid = phoneJid?.endsWith("@c.us") || phoneJid?.endsWith("@s.whatsapp.net")
          ? phoneJid
          : toJid.endsWith("@c.us") || toJid.endsWith("@s.whatsapp.net")
            ? toJid
            : null;
        await db.prepare(`
          UPDATE phone_identity
          SET
            wa_lid = CASE WHEN ? IS NOT NULL AND wa_lid IS NULL THEN ? ELSE wa_lid END,
            wa_jid = CASE WHEN ? IS NOT NULL AND wa_jid IS NULL THEN ? ELSE wa_jid END
          WHERE id = ?
        `).run(lid, lid, phoneWid, phoneWid, row.phone_id);
      }

      // Insert message_log if wa id is new
      const existingLog = await db.prepare("SELECT id FROM message_log WHERE wa_message_id = ?").get(waMessageId);
      if (!existingLog) {
        const msgId = generateUlid("msg");
        const ownJid = device.wa_jid || "operator@c.us";
        await db.prepare(`
          INSERT INTO message_log (id, lead_id, direction, wa_message_id, body, from_jid, to_jid, from_me, wa_timestamp, outbound_id, ai_state, ai_reason, created_at)
          VALUES (?, ?, 'outbound', ?, ?, ?, ?, 1, ?, ?, NULL, NULL, ?)
        `).run(msgId, row.lead_id, waMessageId, row.body, ownJid, toJid, now, outboundId, now);
      }

      // Increment daily_counter
      const operator = await db.prepare("SELECT timezone FROM operator LIMIT 1").get() as { timezone: string } | undefined;
      const tz = operator?.timezone || "UTC";
      const dayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now));

      await db.prepare(`
        INSERT INTO daily_counter (day_local, automated_count, manual_count)
        VALUES (?, 0, 0)
        ON CONFLICT(day_local) DO NOTHING
      `).run(dayLocal);

      if (row.kind === "sequence" || row.kind === "ai_reply") {
        await db.prepare("UPDATE daily_counter SET automated_count = automated_count + 1 WHERE day_local = ?").run(dayLocal);
      } else {
        await db.prepare("UPDATE daily_counter SET manual_count = manual_count + 1 WHERE day_local = ?").run(dayLocal);
      }

      // Advance sequence step if this was part of an active sequence enrollment
      if (row.enrollment_id && row.step_id) {
        const enr = await db.prepare("SELECT * FROM sequence_enrollment WHERE id = ? AND status = 'active'").get(row.enrollment_id) as any;
        if (enr) {
          const currentStep = await db.prepare("SELECT * FROM sequence_step WHERE id = ?").get(row.step_id) as any;
          if (currentStep) {
            const nextStep = await db.prepare("SELECT * FROM sequence_step WHERE sequence_id = ? AND position = ?").get(currentStep.sequence_id, currentStep.position + 1) as any;
            if (nextStep) {
              const lead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(enr.lead_id) as any;
              if (!lead || lead.archived_at || lead.do_not_message) {
                await db.prepare(`
                  UPDATE sequence_enrollment
                  SET status = 'stopped', stopped_at = ?, stop_reason = ?
                  WHERE id = ?
                `).run(now, lead?.do_not_message ? "do_not_message" : "archived", enr.id);
              } else {
                const primaryPhone = await db.prepare("SELECT * FROM phone_identity WHERE lead_id = ? AND is_primary = 1").get(enr.lead_id) as any;
                if (!primaryPhone) {
                  await db.prepare(`
                    UPDATE sequence_enrollment
                    SET status = 'stopped', stopped_at = ?, stop_reason = 'step_failed'
                    WHERE id = ?
                  `).run(now, enr.id);
                } else {
                  // Advance current step pointer
                  await db.prepare("UPDATE sequence_enrollment SET current_step_id = ? WHERE id = ?").run(nextStep.id, enr.id);

                  const policy = await db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as DeskPolicy;
                  const earliestDueAt = now + (nextStep.delay_seconds * 1000);
                  let dueAt = earliestDueAt;
                  if (quietHoursCover(earliestDueAt, policy, tz)) {
                    dueAt = nextOpenMinute(earliestDueAt, policy, tz);
                  }

                  const concreteBody = renderStepBody(nextStep.body, lead.display_name);
                  const nextOutboundId = generateUlid("out");
                  const nextToJid = primaryPhone.wa_lid || primaryPhone.wa_jid || null;
                  const needsResolve = nextToJid ? 0 : 1;
                  const nextIdempotencyKey = `seq:${enr.id}:${nextStep.id}`;

                  await db.prepare(`
                    INSERT INTO outbound_queue (
                      id, lead_id, phone_id, to_e164, to_jid, needs_resolve, body, kind, status,
                      earliest_due_at, due_at, enrollment_id, step_id, idempotency_key, allow_during_quiet_hours, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'sequence', 'queued', ?, ?, ?, ?, ?, 0, ?)
                  `).run(
                    nextOutboundId,
                    enr.lead_id,
                    primaryPhone.id,
                    primaryPhone.e164,
                    nextToJid,
                    needsResolve,
                    concreteBody,
                    earliestDueAt,
                    dueAt,
                    enr.id,
                    nextStep.id,
                    nextIdempotencyKey,
                    now
                  );
                }
              }
            } else {
              // Last step completed
              await db.prepare("UPDATE sequence_enrollment SET status = 'completed', stopped_at = ? WHERE id = ?").run(now, enr.id);
            }
          }
        }
      }

      return { code: 200, body: { status: "sent" } };
    });

    const res = await tx();
    return reply.code(res.code).send(res.body);
  });

  // POST /extension/outbound/:outboundId/fail
  app.post("/extension/outbound/:outboundId/fail", async (request, reply) => {
    const device = await requireExtensionDevice(request, reply);
    const { outboundId } = request.params as { outboundId: string };
    const body = (request.body ?? {}) as {
      claimToken?: string;
      errorClass?: string;
      transient?: boolean;
      detail?: string;
    };

    if (body.errorClass === "bridge_threw" || body.errorClass === "missing_id") {
      return reply.code(400).send({
        error: { code: "validation", message: "bridge_threw and missing_id must use uncertain endpoint.", details: {} },
      });
    }

    if (typeof body.claimToken !== "string" || !body.claimToken) {
      return reply.code(400).send({
        error: { code: "validation", message: "claimToken is required.", details: {} },
      });
    }

    const db = app.db;
    const now = Date.now();
    const tokenHash = sha256(body.claimToken);

    const tx = () => db.transaction(async (): Promise<{ code: number; body: any }> => {
      const row = await db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(outboundId) as
        | OutboundQueueRow
        | undefined;

      if (!row) {
        return {
          code: 404,
          body: { error: { code: "not_found", message: "Outbound row not found.", details: {} } },
        };
      }

      if (
        row.status !== "claimed" ||
        row.claim_token_hash !== tokenHash ||
        row.claimed_by_device_id !== device.id
      ) {
        return {
          code: 409,
          body: { error: { code: "conflict", message: "Cannot fail row in current status or token mismatch.", details: {} } },
        };
      }

      const nextAttempt = row.attempt_count + 1;
      const detail = (typeof body.detail === "string" ? body.detail : "").slice(0, 300);

      if (body.transient === true && row.attempt_count < 4) {
        const backoff = TRANSIENT_BACKOFF[row.attempt_count] ?? 1800_000;
        const dueAt = now + backoff;

        await db.prepare(`
          UPDATE outbound_queue
          SET
            status = 'queued',
            attempt_count = ?,
            due_at = ?,
            claim_token_hash = NULL,
            ack_token_hash = NULL,
            claimed_by_device_id = NULL,
            last_error = ?
          WHERE id = ?
        `).run(nextAttempt, dueAt, detail, outboundId);

        return {
          code: 200,
          body: {
            status: "queued",
            attemptCount: nextAttempt,
            dueAt: new Date(dueAt).toISOString(),
          },
        };
      } else {
        await db.prepare(`
          UPDATE outbound_queue
          SET
            status = 'failed',
            attempt_count = ?,
            claim_token_hash = NULL,
            ack_token_hash = NULL,
            last_error = ?
          WHERE id = ?
        `).run(nextAttempt, detail, outboundId);

        if (row.enrollment_id) {
          await db.prepare(`
            UPDATE sequence_enrollment
            SET status = 'stopped', stopped_at = ?, stop_reason = 'step_failed'
            WHERE id = ? AND status = 'active'
          `).run(now, row.enrollment_id);
        }

        return {
          code: 200,
          body: {
            status: "failed",
            attemptCount: nextAttempt,
          },
        };
      }
    });

    const res = await tx();
    return reply.code(res.code).send(res.body);
  });

  // POST /extension/outbound/:outboundId/uncertain
  app.post("/extension/outbound/:outboundId/uncertain", async (request, reply) => {
    const device = await requireExtensionDevice(request, reply);
    const { outboundId } = request.params as { outboundId: string };
    const body = (request.body ?? {}) as { claimToken?: string; detail?: string };

    if (typeof body.claimToken !== "string" || !body.claimToken) {
      return reply.code(400).send({
        error: { code: "validation", message: "claimToken is required.", details: {} },
      });
    }

    const db = app.db;
    const tokenHash = sha256(body.claimToken);

    const tx = () => db.transaction(async (): Promise<{ code: number; body: any }> => {
      const row = await db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(outboundId) as
        | OutboundQueueRow
        | undefined;

      if (!row) {
        return {
          code: 404,
          body: { error: { code: "not_found", message: "Outbound row not found.", details: {} } },
        };
      }

      if (row.claimed_by_device_id !== device.id) {
        return {
          code: 409,
          body: { error: { code: "conflict", message: "Device mismatch.", details: {} } },
        };
      }

      // First commit: status claimed and token matches claim_token_hash
      if (row.status === "claimed" && row.claim_token_hash === tokenHash) {
        const detail = (typeof body.detail === "string" ? body.detail : "").slice(0, 300);
        await db.prepare(`
          UPDATE outbound_queue
          SET
            status = 'needs_review',
            claim_token_hash = NULL,
            last_error = ?
          WHERE id = ?
        `).run(detail, outboundId);

        return { code: 200, body: { status: "needs_review" } };
      }

      // Lost-200 replay: status already needs_review and token matches ack_token_hash
      if (row.status === "needs_review" && row.ack_token_hash === tokenHash) {
        return { code: 200, body: { status: "needs_review" } };
      }

      return {
        code: 409,
        body: { error: { code: "conflict", message: "Cannot mark uncertain in current status or token mismatch.", details: {} } },
      };
    });

    const res = await tx();
    return reply.code(res.code).send(res.body);
  });
};
