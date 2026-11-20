import type { FastifyPluginAsync } from "fastify";
import { generateUlid, type InboundWire } from "@leaddesk/shared";
import { requireExtensionDevice } from "../auth.js";
import { quietHoursCover, type DeskPolicy } from "../policy.js";
import {
  type AiSettingsRow,
  decryptApiKey,
  buildUserPrompt,
  completeReply,
} from "../ai.js";

const DIRECT_SUFFIXES = ["@c.us", "@s.whatsapp.net", "@lid"];
const isDirectWid = (wid: string) => DIRECT_SUFFIXES.some((suffix) => wid.endsWith(suffix));
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const optStr = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

// Rate limit: 120 per minute per device
const deviceRateLimits = new Map<string, number[]>();

function checkRateLimit(deviceId: string, now: number): boolean {
  const windowStart = now - 60_000;
  let timestamps = deviceRateLimits.get(deviceId);
  if (!timestamps) {
    timestamps = [];
    deviceRateLimits.set(deviceId, timestamps);
  }
  timestamps = timestamps.filter((t) => t > windowStart);
  if (timestamps.length >= 120) {
    deviceRateLimits.set(deviceId, timestamps);
    return false;
  }
  timestamps.push(now);
  deviceRateLimits.set(deviceId, timestamps);
  return true;
}

export const inboundRoutes: FastifyPluginAsync = async (app) => {
  // POST /extension/inbound
  app.post("/extension/inbound", async (request, reply) => {
    const device = await requireExtensionDevice(request, reply);
    const now = Date.now();

    if (!checkRateLimit(device.id, now)) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: "Rate limit exceeded (120/min).", details: {} },
      });
    }

    const body = (request.body ?? {}) as Partial<InboundWire>;

    if (
      !isStr(body.waMessageId) ||
      !isStr(body.chatJid) ||
      !isStr(body.fromJid) ||
      !isStr(body.toJid) ||
      !isStr(body.waTimestamp) ||
      !isStr(body.chatKind) ||
      (body.body !== undefined && body.body !== null && typeof body.body !== "string")
    ) {
      return reply.code(400).send({
        error: {
          code: "validation",
          message: "waMessageId, chatJid, fromJid, toJid, waTimestamp, and chatKind are required.",
          details: {},
        },
      });
    }

    // chatKind check: non-direct returns 200 stored: false, reason: "not_direct".
    // Don't trust the client label alone: the chat jid itself must be a 1:1 address, so a
    // group (@g.us), broadcast or newsletter can never reach the AI path.
    if (body.chatKind !== "direct" || !isDirectWid(body.chatJid)) {
      return reply.code(200).send({
        stored: false,
        reason: "not_direct",
      });
    }

    const waTimestampMs = new Date(body.waTimestamp).getTime();
    if (isNaN(waTimestampMs)) {
      return reply.code(400).send({
        error: { code: "validation", message: "Invalid waTimestamp.", details: {} },
      });
    }

    // Stale check: older than 120s relative to server time (or implausibly far in the future)
    if (now - waTimestampMs > 120_000 || waTimestampMs - now > 120_000) {
      return reply.code(200).send({
        stored: false,
        reason: "stale",
      });
    }

    const textBody = (body.body ?? "").trim();
    if (!textBody) {
      return reply.code(200).send({ stored: false, reason: "empty_body" });
    }
    if (textBody.length > 4096) {
      return reply.code(400).send({
        error: { code: "validation", message: "body must be at most 4096 characters.", details: {} },
      });
    }

    const db = app.db;

    // Deduplication check on wa_message_id
    const existing = await db
      .prepare("SELECT * FROM message_log WHERE wa_message_id = ?")
      .get(body.waMessageId) as any;

    if (existing) {
      return reply.code(200).send({
        stored: true,
        duplicate: true,
        messageId: existing.id,
        leadId: existing.lead_id,
        aiState: existing.ai_state,
        aiReason: existing.ai_reason,
        outboundId: existing.outbound_id,
      });
    }

    const fromMe = Boolean(body.fromMe);

    // Identify contact information for lead resolution:
    let contactLid: string | null = null;
    let contactJid: string | null = null;
    let contactPhoneUser: string | null = null;

    const senderLid = optStr(body.senderLid);
    const senderJid = optStr(body.senderJid);
    const senderPhoneUser = optStr(body.senderPhoneUser);

    if (fromMe) {
      const recipientWid = isDirectWid(body.toJid) ? body.toJid : body.chatJid;
      if (recipientWid.endsWith("@lid")) {
        contactLid = recipientWid;
      } else if (recipientWid.endsWith("@c.us") || recipientWid.endsWith("@s.whatsapp.net")) {
        contactJid = recipientWid;
        contactPhoneUser = recipientWid.replace(/@.*$/, "");
      }
    } else {
      contactLid = senderLid || (body.chatJid.endsWith("@lid") ? body.chatJid : null);
      contactJid =
        senderJid ||
        (body.chatJid.endsWith("@c.us") || body.chatJid.endsWith("@s.whatsapp.net")
          ? body.chatJid
          : null);
      contactPhoneUser = senderPhoneUser || (contactJid ? contactJid.replace(/@.*$/, "") : null);
    }
    if (contactPhoneUser && !/^\d{5,20}$/.test(contactPhoneUser)) {
      contactPhoneUser = null; // never build an E.164 from a non-numeric user part
    }
    if (!contactLid && !contactJid && !contactPhoneUser) {
      return reply.code(200).send({ stored: false, reason: "unresolvable_contact" });
    }

    // Lead resolution: match by lid, then jid, then E.164; create the lead otherwise.
    // Runs in one transaction so a failed phone insert never leaves a phoneless lead.
    const resolved = await db.transaction(async () => {
      let matchedPhone: any = null;
      if (contactLid) {
        matchedPhone = await db.prepare("SELECT * FROM phone_identity WHERE wa_lid = ?").get(contactLid);
      }
      if (!matchedPhone && contactJid) {
        matchedPhone = await db.prepare("SELECT * FROM phone_identity WHERE wa_jid = ?").get(contactJid);
      }
      if (!matchedPhone && contactPhoneUser) {
        const withPlus = `+${contactPhoneUser}`;
        matchedPhone = await db
          .prepare("SELECT * FROM phone_identity WHERE e164 = ? OR e164 = ?")
          .get(withPlus, contactPhoneUser);
      }

      if (matchedPhone) {
        // Fill a missing identity only when no other phone row already owns it; the unique
        // indexes would otherwise throw and every later message from this contact would 500.
        if (contactLid && !matchedPhone.wa_lid) {
          await db.prepare(`
            UPDATE phone_identity SET wa_lid = ?
            WHERE id = ? AND NOT EXISTS (SELECT 1 FROM phone_identity WHERE wa_lid = ?)
          `).run(contactLid, matchedPhone.id, contactLid);
        }
        if (contactJid && !matchedPhone.wa_jid) {
          await db.prepare(`
            UPDATE phone_identity SET wa_jid = ?
            WHERE id = ? AND NOT EXISTS (SELECT 1 FROM phone_identity WHERE wa_jid = ?)
          `).run(contactJid, matchedPhone.id, contactJid);
        }
        return {
          leadId: matchedPhone.lead_id as string,
          leadRow: await db.prepare("SELECT * FROM lead WHERE id = ?").get(matchedPhone.lead_id) as any,
        };
      }

      // Create new lead with ai_enabled: 0
      const newLeadId = generateUlid("led");
      const defaultStage = await db
        .prepare("SELECT id FROM stage ORDER BY position ASC LIMIT 1")
        .get() as { id: string } | undefined;
      const stageId = defaultStage?.id || "stg_default";
      const displayName = contactPhoneUser
        ? `+${contactPhoneUser}`
        : contactLid || contactJid || body.chatJid!;

      await db.prepare(`
        INSERT INTO lead (id, display_name, notes, stage_id, ai_enabled, require_approval, automation_paused, do_not_message, created_at, updated_at)
        VALUES (?, ?, '', ?, 0, 0, 0, 0, ?, ?)
      `).run(newLeadId, displayName, stageId, now, now);

      const phoneId = generateUlid("phn");
      const e164 = contactPhoneUser ? `+${contactPhoneUser}` : null;
      await db.prepare(`
        INSERT INTO phone_identity (id, lead_id, e164, wa_jid, wa_lid, is_primary, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(phoneId, newLeadId, e164, contactJid, contactLid, now);

      return {
        leadId: newLeadId,
        leadRow: await db.prepare("SELECT * FROM lead WHERE id = ?").get(newLeadId) as any,
      };
    });

    const leadId = resolved.leadId;
    const leadRow = resolved.leadRow;

    const msgId = generateUlid("msg");

    // fromMe handling: direction 'outbound', ai_state null, do not call model
    if (fromMe) {
      await db.prepare(`
        INSERT INTO message_log (
          id, lead_id, direction, wa_message_id, body, from_jid, to_jid, from_me,
          wa_timestamp, outbound_id, ai_state, ai_reason, created_at
        ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, ?)
      `).run(msgId, leadId, body.waMessageId, textBody, body.fromJid, body.toJid, waTimestampMs, now);

      await db.prepare("UPDATE lead SET last_outbound_at = ?, updated_at = ? WHERE id = ?").run(
        waTimestampMs,
        now,
        leadId
      );

      return reply.code(200).send({
        stored: true,
        duplicate: false,
        messageId: msgId,
        leadId,
        aiState: null,
        aiReason: null,
        outboundId: null,
      });
    }

    // Incoming direct message: evaluate decision table before model call
    const aiSettings = await db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() as
      | AiSettingsRow
      | undefined;
    const globalMode = aiSettings?.mode || "off";
    const policy = await db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as DeskPolicy;
    const operator = await db.prepare("SELECT timezone FROM operator LIMIT 1").get() as
      | { timezone: string }
      | undefined;
    const tz = operator?.timezone || "UTC";

    let skipReason: string | null = null;

    if (globalMode === "off") {
      skipReason = "global_off";
    } else if (leadRow.archived_at) {
      skipReason = "archived";
    } else if (leadRow.do_not_message) {
      skipReason = "do_not_message";
    } else if (leadRow.automation_paused) {
      skipReason = "automation_paused";
    } else if (!leadRow.ai_enabled) {
      skipReason = "lead_opt_out";
    } else if (quietHoursCover(now, policy, tz)) {
      skipReason = "quiet_hours";
    } else if (process.env["LEAD_DESK_AI_ENABLED"] === "false") {
      skipReason = "killed";
    } else {
      // Check hourly AI cap (default 30)
      const hourUtc = new Date(now).toISOString().slice(0, 13);
      const hourlyRow = await db
        .prepare("SELECT count FROM ai_hourly_counter WHERE hour_utc = ?")
        .get(hourUtc) as { count: number } | undefined;
      const hourlyCap = policy.ai_hourly_cap || 30;
      if ((hourlyRow?.count ?? 0) >= hourlyCap) {
        skipReason = "ai_hourly_cap";
      } else {
        // Check daily automated send cap
        const dayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now));
        const dailyRow = await db
          .prepare("SELECT automated_count FROM daily_counter WHERE day_local = ?")
          .get(dayLocal) as { automated_count: number } | undefined;
        if ((dailyRow?.automated_count ?? 0) >= policy.daily_automated_cap) {
          skipReason = "daily_cap";
        } else {
          // Check same-lead automated gap
          const lastSameLeadRow = await db
            .prepare(`
              SELECT sent_at FROM outbound_queue
              WHERE lead_id = ? AND kind IN ('sequence', 'ai_reply') AND status = 'sent' AND sent_at IS NOT NULL
              ORDER BY sent_at DESC LIMIT 1
            `)
            .get(leadId) as { sent_at: number } | undefined;

          if (
            lastSameLeadRow &&
            now - lastSameLeadRow.sent_at < policy.min_same_lead_gap_seconds * 1000
          ) {
            skipReason = "min_gap";
          }
        }
      }
    }

    // If decision is to skip: store message with ai_state = 'skipped'
    if (skipReason) {
      await db.prepare(`
        INSERT INTO message_log (
          id, lead_id, direction, wa_message_id, body, from_jid, to_jid, from_me,
          wa_timestamp, outbound_id, ai_state, ai_reason, created_at
        ) VALUES (?, ?, 'inbound', ?, ?, ?, ?, 0, ?, NULL, 'skipped', ?, ?)
      `).run(msgId, leadId, body.waMessageId, textBody, body.fromJid, body.toJid, waTimestampMs, skipReason, now);

      await db.prepare("UPDATE lead SET last_inbound_at = ?, updated_at = ? WHERE id = ?").run(
        waTimestampMs,
        now,
        leadId
      );

      return reply.code(200).send({
        stored: true,
        duplicate: false,
        messageId: msgId,
        leadId,
        aiState: "skipped",
        aiReason: skipReason,
        outboundId: null,
      });
    }

    // Step 5: Compare-and-set to 'pending' and increment ai_hourly_counter
    const hourUtc = new Date(now).toISOString().slice(0, 13);
    const casSucceeded = await db.transaction(async () => {
      await db.prepare(`
        INSERT INTO message_log (
          id, lead_id, direction, wa_message_id, body, from_jid, to_jid, from_me,
          wa_timestamp, outbound_id, ai_state, ai_reason, created_at
        ) VALUES (?, ?, 'inbound', ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?)
      `).run(msgId, leadId, body.waMessageId, textBody, body.fromJid, body.toJid, waTimestampMs, now);

      const updateRes = await db
        .prepare("UPDATE message_log SET ai_state = 'pending' WHERE id = ? AND ai_state IS NULL")
        .run(msgId);

      if (updateRes.changes !== 1) {
        return false;
      }

      await db.prepare(`
        INSERT INTO ai_hourly_counter (hour_utc, count)
        VALUES (?, 1)
        ON CONFLICT(hour_utc) DO UPDATE SET count = count + 1
      `).run(hourUtc);

      await db.prepare("UPDATE lead SET last_inbound_at = ?, updated_at = ? WHERE id = ?").run(
        waTimestampMs,
        now,
        leadId
      );

      return true;
    });

    if (!casSucceeded) {
      return reply.code(200).send({
        stored: true,
        duplicate: true,
        messageId: msgId,
        leadId,
        aiState: "pending",
        aiReason: null,
        outboundId: null,
      });
    }

    // Step 6: Build prompt
    const stage = await db.prepare("SELECT name FROM stage WHERE id = ?").get(leadRow.stage_id) as
      | { name: string }
      | undefined;
    // Only the last 12 messages are used by the prompt builder; don't load the whole history.
    const historyMessages = (
      await db
        .prepare(
          "SELECT from_me, body FROM message_log WHERE lead_id = ? AND id != ? ORDER BY created_at DESC, id DESC LIMIT 12"
        )
        .all(leadId, msgId) as Array<{ from_me: number; body: string }>
    ).reverse();

    const userPrompt = buildUserPrompt({
      leadDisplayName: leadRow.display_name,
      stageName: stage?.name || "New Lead",
      notes: leadRow.notes || "",
      historyMessages,
      triggeringBody: textBody,
    });

    if (!aiSettings?.api_key_ciphertext || !aiSettings?.api_key_nonce) {
      await db.prepare("UPDATE message_log SET ai_state = 'failed', ai_reason = 'ai_error' WHERE id = ?").run(
        msgId
      );
      return reply.code(200).send({
        stored: true,
        duplicate: false,
        messageId: msgId,
        leadId,
        aiState: "failed",
        aiReason: "ai_error",
        outboundId: null,
      });
    }

    let apiKey: string;
    try {
      apiKey = decryptApiKey(aiSettings.api_key_ciphertext, aiSettings.api_key_nonce);
    } catch {
      await db.prepare("UPDATE message_log SET ai_state = 'failed', ai_reason = 'ai_error' WHERE id = ?").run(
        msgId
      );
      return reply.code(200).send({
        stored: true,
        duplicate: false,
        messageId: msgId,
        leadId,
        aiState: "failed",
        aiReason: "ai_error",
        outboundId: null,
      });
    }

    // Step 7: Call model outside transaction
    try {
      const result = await completeReply(
        {
          providerBaseUrl: aiSettings.provider_base_url,
          model: aiSettings.model,
          maxCompletionTokens: aiSettings.max_completion_tokens,
          systemInstructions: aiSettings.system_instructions,
        },
        apiKey,
        userPrompt,
        leadId
      );

      const draftText = result.text.trim();

      // Step 9 checks
      if (draftText === "LEAD_DESK_NO_REPLY") {
        await db.prepare(
          "UPDATE message_log SET ai_state = 'skipped', ai_reason = 'model_declined' WHERE id = ?"
        ).run(msgId);
        return reply.code(200).send({
          stored: true,
          duplicate: false,
          messageId: msgId,
          leadId,
          aiState: "skipped",
          aiReason: "model_declined",
          outboundId: null,
        });
      }

      if (!draftText || draftText.length > 1000 || draftText.includes("LEAD_DESK_NO_REPLY")) {
        await db.prepare(
          "UPDATE message_log SET ai_state = 'failed', ai_reason = 'empty_draft' WHERE id = ?"
        ).run(msgId);
        return reply.code(200).send({
          stored: true,
          duplicate: false,
          messageId: msgId,
          leadId,
          aiState: "failed",
          aiReason: "empty_draft",
          outboundId: null,
        });
      }

      // Step 8: Usable text -> create outbound_queue row
      const primaryPhone = await db
        .prepare("SELECT * FROM phone_identity WHERE lead_id = ? AND is_primary = 1")
        .get(leadId) as
        | { id: string; e164: string | null; wa_jid: string | null; wa_lid: string | null }
        | undefined;

      const toJid = primaryPhone?.wa_lid || primaryPhone?.wa_jid || null;
      const needsResolve = toJid ? 0 : 1;
      const outboundId = generateUlid("out");

      // The model call can take up to 25s. Re-read the settings and the lead now, so an
      // operator who switched AI off, opted the lead out, archived it, or required approval
      // while the call was running is respected.
      const afterNow = Date.now();
      const freshSettings = await db.prepare("SELECT mode FROM ai_settings WHERE id = 1").get() as
        | { mode: string }
        | undefined;
      const freshLead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(leadId) as any;
      const freshMode = freshSettings?.mode || "off";
      let lateSkip: string | null = null;
      if (freshMode === "off") lateSkip = "global_off";
      else if (process.env["LEAD_DESK_AI_ENABLED"] === "false") lateSkip = "killed";
      else if (!freshLead || freshLead.archived_at) lateSkip = "archived";
      else if (freshLead.do_not_message) lateSkip = "do_not_message";
      else if (freshLead.automation_paused) lateSkip = "automation_paused";
      else if (!freshLead.ai_enabled) lateSkip = "lead_opt_out";

      if (lateSkip) {
        await db.prepare("UPDATE message_log SET ai_state = 'skipped', ai_reason = ? WHERE id = ?").run(lateSkip, msgId);
        return reply.code(200).send({
          stored: true,
          duplicate: false,
          messageId: msgId,
          leadId,
          aiState: "skipped",
          aiReason: lateSkip,
          outboundId: null,
        });
      }

      // Status determination
      let status: "needs_approval" | "queued" = "needs_approval";
      const isAuto = freshMode === "auto" && !freshLead.require_approval;

      if (isAuto) {
        // If quiet hours are active in what would have been the auto path, insert nothing and set ai_state = skipped, ai_reason = quiet_hours
        if (quietHoursCover(afterNow, policy, tz)) {
          await db.prepare(
            "UPDATE message_log SET ai_state = 'skipped', ai_reason = 'quiet_hours' WHERE id = ?"
          ).run(msgId);
          return reply.code(200).send({
            stored: true,
            duplicate: false,
            messageId: msgId,
            leadId,
            aiState: "skipped",
            aiReason: "quiet_hours",
            outboundId: null,
          });
        }
        status = "queued";
      }

      await db.transaction(async () => {
        await db.prepare(`
          INSERT INTO outbound_queue (
            id, lead_id, phone_id, to_e164, to_jid, needs_resolve, body, kind, status,
            earliest_due_at, due_at, inbound_message_id, idempotency_key, allow_during_quiet_hours, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai_reply', ?, ?, ?, ?, ?, 0, ?)
        `).run(
          outboundId,
          leadId,
          primaryPhone?.id ?? null,
          primaryPhone?.e164 ?? null,
          toJid,
          needsResolve,
          draftText,
          status,
          now,
          now,
          msgId,
          `ai:${msgId}`,
          now
        );

        await db.prepare(
          "UPDATE message_log SET outbound_id = ?, ai_state = 'drafted', ai_reason = NULL WHERE id = ?"
        ).run(outboundId, msgId);
      });

      return reply.code(200).send({
        stored: true,
        duplicate: false,
        messageId: msgId,
        leadId,
        aiState: "drafted",
        aiReason: null,
        outboundId,
      });
    } catch (err: any) {
      const isTimeout =
        err.name === "AbortError" ||
        err.name === "TimeoutError" ||
        (err.message && err.message.toLowerCase().includes("timeout"));
      const failReason = isTimeout ? "ai_timeout" : "ai_error";

      await db.prepare("UPDATE message_log SET ai_state = 'failed', ai_reason = ? WHERE id = ?").run(
        failReason,
        msgId
      );

      return reply.code(200).send({
        stored: true,
        duplicate: false,
        messageId: msgId,
        leadId,
        aiState: "failed",
        aiReason: failReason,
        outboundId: null,
      });
    }
  });
};
