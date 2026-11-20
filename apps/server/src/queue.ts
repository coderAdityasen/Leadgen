import type { Db } from "./db.js";
import { generateUlid } from "@leaddesk/shared";
import { sha256, generateToken } from "./auth.js";
import {
  quietHoursCover,
  nextOpenMinute,
  nextOpenAtOrAfter,
  capBlocks,
  gapBlocks,
  msUntilKindGap,
  msUntilLocalMidnight,
  olderThanCatchup,
  type DeskPolicy,
  type OutboundCandidate,
} from "./policy.js";

export interface OutboundQueueRow {
  id: string;
  lead_id: string | null;
  phone_id: string | null;
  to_e164: string | null;
  to_jid: string | null;
  needs_resolve: number;
  body: string;
  kind: "manual" | "scheduled" | "sequence" | "ai_reply";
  status: "queued" | "claimed" | "sent" | "failed" | "needs_review" | "needs_approval" | "cancelled" | "expired";
  earliest_due_at: number;
  due_at: number;
  claim_token_hash: string | null;
  ack_token_hash: string | null;
  claimed_by_device_id: string | null;
  claimed_at: number | null;
  claim_expires_at: number | null;
  attempt_count: number;
  last_error: string | null;
  wa_message_id: string | null;
  scheduled_message_id: string | null;
  enrollment_id: string | null;
  step_id: string | null;
  inbound_message_id: string | null;
  idempotency_key: string | null;
  allow_during_quiet_hours: number;
  created_at: number;
  sent_at: number | null;
}

/**
 * When the system (not the operator) kills a sequence row — expired by the catch-up limit,
 * cancelled for do-not-message, archived lead — stop its enrollment too. Otherwise the
 * enrollment stays 'active' with nothing queued, and the one-active-enrollment-per-lead
 * index blocks enrolling that lead ever again.
 */
export async function stopEnrollmentForDeadRow(
  db: Db,
  row: { enrollment_id: string | null },
  reason: string,
  nowMs: number
): Promise<void> {
  if (!row.enrollment_id) return;
  await db.prepare(`
    UPDATE sequence_enrollment
    SET status = 'stopped', stopped_at = ?, stop_reason = ?
    WHERE id = ? AND status = 'active'
  `).run(nowMs, reason, row.enrollment_id);
}

export function senderLeaseHeld(
  lease: { device_id: string | null; lease_until: number | null; grace_until: number | null } | undefined,
  deviceId: string,
  nowMs: number
): boolean {
  if (!lease) return false;
  return (
    lease.device_id === deviceId &&
    lease.lease_until != null &&
    lease.lease_until > nowMs &&
    lease.grace_until == null
  );
}

export async function claimNext(db: Db, deviceId: string, nowMs: number) {
  return await db.transaction(async () => {
    const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as
      | { device_id: string | null; lease_until: number | null; grace_until: number | null }
      | undefined;

    if (!senderLeaseHeld(lease, deviceId, nowMs)) {
      return { item: null, reason: "not_sender", retryAfterMs: 10_000 };
    }

    // Expire stale claims: claimed and claim_expires_at < now -> needs_review
    // Clear claim_token_hash so fail/requeue cannot run; keep ack_token_hash so late ack can still succeed.
    await db.prepare(`
      UPDATE outbound_queue
      SET status = 'needs_review', claim_token_hash = NULL, last_error = 'claim_expired'
      WHERE status = 'claimed' AND claim_expires_at < ?
    `).run(nowMs);

    // Sending kill switch
    if (process.env["LEAD_DESK_SENDING_ENABLED"] === "false") {
      return { item: null, reason: "frozen", retryAfterMs: 60_000 };
    }

    const policy = await db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as DeskPolicy;
    const operator = await db.prepare("SELECT timezone FROM operator LIMIT 1").get() as { timezone: string } | undefined;
    const timezone = operator?.timezone || "UTC";

    // Candidates: up to 20 due queued rows
    const candidates = await db
      .prepare(`
        SELECT * FROM outbound_queue
        WHERE status = 'queued' AND due_at <= ?
        ORDER BY due_at ASC, id ASC
        LIMIT 20
      `)
      .all(nowMs) as OutboundQueueRow[];

    // Nothing due: skip the counter and gap lookups (this path runs on every ~5s poll).
    if (candidates.length === 0) {
      return { item: null, reason: "empty", retryAfterMs: 5_000 };
    }

    // Counters for today
    const d = new Date(nowMs);
    const dayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d); // YYYY-MM-DD
    const counter = (await db.prepare("SELECT * FROM daily_counter WHERE day_local = ?").get(dayLocal) as
      | { automated_count: number; manual_count: number }
      | undefined) ?? { automated_count: 0, manual_count: 0 };

    // Query recent automated sends for gap checks
    const lastAutomatedRow = await db
      .prepare(`
        SELECT sent_at FROM outbound_queue
        WHERE kind IN ('sequence', 'ai_reply') AND status = 'sent' AND sent_at IS NOT NULL
        ORDER BY sent_at DESC LIMIT 1
      `)
      .get() as { sent_at: number } | undefined;
    const lastAutomatedSendMs = lastAutomatedRow?.sent_at ?? null;

    let soonest = Number.POSITIVE_INFINITY;
    let reason: "empty" | "gap" | "cap" | "quiet_hours" | "catchup" = "empty";

    for (const candidate of candidates) {
      const lead = candidate.lead_id
        ? (await db.prepare("SELECT * FROM lead WHERE id = ?").get(candidate.lead_id) as
            | { do_not_message: number; automation_paused: number; archived_at: number | null }
            | undefined)
        : undefined;

      if (lead?.do_not_message || lead?.archived_at) {
        const why = lead.do_not_message ? "do_not_message" : "archived";
        await db.prepare("UPDATE outbound_queue SET status = 'cancelled', last_error = ? WHERE id = ?").run(
          why,
          candidate.id
        );
        await stopEnrollmentForDeadRow(db, candidate, why, nowMs);
        continue;
      }

      if (olderThanCatchup(candidate, nowMs, policy)) {
        await db.prepare("UPDATE outbound_queue SET status = 'expired', last_error = 'catchup_limit_exceeded' WHERE id = ?").run(
          candidate.id
        );
        await stopEnrollmentForDeadRow(db, candidate, "expired", nowMs);
        if (reason === "empty") reason = "catchup";
        continue;
      }

      const nowInQuiet = quietHoursCover(nowMs, policy, timezone);
      const dueInQuiet = quietHoursCover(candidate.due_at, policy, timezone);

      if ((nowInQuiet || dueInQuiet) && !candidate.allow_during_quiet_hours) {
        if (candidate.kind === "ai_reply") {
          await db.prepare("UPDATE outbound_queue SET status = 'cancelled', last_error = 'quiet_hours' WHERE id = ?").run(
            candidate.id
          );
          if (reason === "empty") reason = "quiet_hours";
          continue; // never roll an AI reply to morning
        }

        if (nowInQuiet) {
          const open = nextOpenAtOrAfter(nowMs, policy, timezone);
          await db.prepare("UPDATE outbound_queue SET due_at = ? WHERE id = ?").run(open, candidate.id);
          soonest = Math.min(soonest, open - nowMs);
          reason = "quiet_hours";
          continue;
        }

        const rolled = nextOpenMinute(candidate.earliest_due_at, policy, timezone);
        if (rolled > nowMs) {
          await db.prepare("UPDATE outbound_queue SET due_at = ? WHERE id = ?").run(rolled, candidate.id);
          soonest = Math.min(soonest, rolled - nowMs);
          reason = "quiet_hours";
          continue;
        }
      }

      const automated = candidate.kind === "sequence" || candidate.kind === "ai_reply";
      if (automated && lead?.automation_paused) {
        soonest = Math.min(soonest, 60_000);
        reason = "gap";
        continue;
      }

      if (capBlocks(candidate, counter, policy)) {
        soonest = Math.min(soonest, msUntilLocalMidnight(nowMs, timezone));
        reason = "cap";
        continue;
      }

      // Check same-lead gap
      let lastSameLeadSendMs: number | null = null;
      if (candidate.lead_id) {
        const lastSameLeadRow = await db
          .prepare(`
            SELECT sent_at FROM outbound_queue
            WHERE lead_id = ? AND kind IN ('sequence', 'ai_reply') AND status = 'sent' AND sent_at IS NOT NULL
            ORDER BY sent_at DESC LIMIT 1
          `)
          .get(candidate.lead_id) as { sent_at: number } | undefined;
        lastSameLeadSendMs = lastSameLeadRow?.sent_at ?? null;
      }

      if (gapBlocks(candidate, nowMs, lastAutomatedSendMs, lastSameLeadSendMs, policy)) {
        soonest = Math.min(soonest, msUntilKindGap(candidate, nowMs, lastAutomatedSendMs, lastSameLeadSendMs, policy));
        reason = "gap";
        continue;
      }

      // Found winner!
      const rawClaimToken = generateToken("clm_");
      const tokenHash = sha256(rawClaimToken);
      const claimExpiresAt = nowMs + 90_000;

      await db.prepare(`
        UPDATE outbound_queue
        SET
          status = 'claimed',
          claimed_by_device_id = ?,
          claimed_at = ?,
          claim_expires_at = ?,
          claim_token_hash = ?,
          ack_token_hash = ?
        WHERE id = ?
      `).run(deviceId, nowMs, claimExpiresAt, tokenHash, tokenHash, candidate.id);

      return {
        item: {
          outboundId: candidate.id,
          claimToken: rawClaimToken,
          toJid: candidate.to_jid,
          toE164: candidate.to_e164,
          needsResolve: Boolean(candidate.needs_resolve),
          body: candidate.body,
          kind: candidate.kind,
        },
        retryAfterMs: 0,
        reason: "claimed",
      };
    }

    if (candidates.length === 0) {
      return { item: null, reason: "empty", retryAfterMs: 5_000 };
    }

    return { item: null, reason, retryAfterMs: Number.isFinite(soonest) ? Math.max(soonest, 1000) : 5_000 };
  });
}
