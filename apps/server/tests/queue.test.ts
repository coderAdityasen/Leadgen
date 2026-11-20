import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { sha256 } from "../src/auth.js";
import { claimNext } from "../src/queue.js";
import type { Db } from "../src/db.js";
import type { FastifyInstance } from "fastify";
import { setupAdmin } from "./helpers.js";

describe("Outbound queue, claim, ack, fail, and uncertain (PR 7)", () => {
  let app: FastifyInstance;
  let db: Db;
  let operatorCookie: string;
  const device1Token = "dev1-token-secret-123456";
  const device2Token = "dev2-token-secret-654321";
  const device1Id = "dev_01J00000000000000000000001";
  const device2Id = "dev_01J00000000000000000000002";

  beforeEach(async () => {
    process.env["LEAD_DESK_BOOTSTRAP_SECRET"] = "secret-123456789";
    db = await openDb({ path: ":memory:" });
    app = await buildApp({ db, logLevel: "silent" });

    // Setup operator
    const setupRes = await setupAdmin(app, {
        bootstrapSecret: "secret-123456789",
        password: "supersecretpassword123",
        displayName: "Ada",
        timezone: "America/New_York",
        defaultCountry: "US",
      });
    operatorCookie = `leaddesk_session=${setupRes.cookies[0]!.value}`;

    // Seed extension devices
    const now = Date.now();
    await db.prepare(`
      INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at, authenticated)
      VALUES (?, 'Device 1', ?, ?, ?, 1)
    `).run(device1Id, sha256(device1Token), now, now);

    await db.prepare(`
      INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at, authenticated)
      VALUES (?, 'Device 2', ?, ?, ?, 1)
    `).run(device2Id, sha256(device2Token), now, now);

    // Give Device 1 active sender lease
    await db.prepare(`
      UPDATE sender_lease
      SET device_id = ?, lease_until = ?, grace_until = NULL
      WHERE id = 1
    `).run(device1Id, now + 60_000);

    // Disable quiet hours by default in tests so real-world clock time doesn't interfere
    await db.prepare(`
      UPDATE desk_policy
      SET quiet_hours_enabled = 0
      WHERE id = 1
    `).run();
  });

  afterEach(async () => {
    await app.close();
  });

  it("1. Two concurrent callers claiming with one winner", async () => {
    const now = Date.now();
    // Seed one queued item
    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, body, kind, status, earliest_due_at, due_at, created_at
      ) VALUES ('out_1', '+12125550100', '12125550100@c.us', 'Hello!', 'manual', 'queued', ?, ?, ?)
    `).run(now - 1000, now - 1000, now);

    // Call claimNext concurrently
    const [res1, res2] = await Promise.all([
      Promise.resolve(await claimNext(db, device1Id, now)),
      Promise.resolve(await claimNext(db, device1Id, now)),
    ]);

    const winnerCount = (res1.item ? 1 : 0) + (res2.item ? 1 : 0);
    expect(winnerCount).toBe(1);

    const winner = res1.item || res2.item;
    expect(winner?.outboundId).toBe("out_1");
    expect(winner?.claimToken).toBeDefined();

    // Check DB state
    const row = await db.prepare("SELECT * FROM outbound_queue WHERE id = 'out_1'").get() as any;
    expect(row.status).toBe("claimed");
    expect(row.claimed_by_device_id).toBe(device1Id);
    expect(row.claim_token_hash).toBeDefined();
    expect(row.ack_token_hash).toBeDefined();
  });

  it("2. Quiet-hour roll (earliest 18:00 claimed at 22:00 rolled to 08:00)", async () => {
    // Policy quiet hours: 21:00 to 08:00 in America/New_York
    await db.prepare(`
      UPDATE desk_policy
      SET quiet_hours_enabled = 1, quiet_start = '21:00', quiet_end = '08:00'
      WHERE id = 1
    `).run();

    // America/New_York is UTC-5 in winter or UTC-4 in summer.
    // Let's create an explicit ISO date at 22:00 EDT (2026-06-15T22:00:00-04:00 -> 2026-06-16T02:00:00Z)
    const claimedAt22 = Date.parse("2026-06-15T22:00:00-04:00");
    const dueAt18 = Date.parse("2026-06-15T18:00:00-04:00");

    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, body, kind, status, earliest_due_at, due_at, allow_during_quiet_hours, created_at
      ) VALUES ('out_quiet', '+12125550101', '12125550101@c.us', 'Night message', 'sequence', 'queued', ?, ?, 0, ?)
    `).run(dueAt18, dueAt18, dueAt18);

    // Attempt claim at 22:00
    const claimRes = await claimNext(db, device1Id, claimedAt22);
    expect(claimRes.item).toBeNull();
    expect(claimRes.reason).toBe("quiet_hours");

    // The due_at in DB should now have been rolled forward to 08:00 next morning (2026-06-16T08:00:00-04:00)
    const rolledRow = await db.prepare("SELECT * FROM outbound_queue WHERE id = 'out_quiet'").get() as any;
    const expectedRoll = Date.parse("2026-06-16T08:00:00-04:00");
    expect(rolledRow.due_at).toBe(expectedRoll);
    expect(rolledRow.status).toBe("queued");
  });

  it("3. Automated cap does not block manual claim", async () => {
    const now = Date.now();

    // Set daily_automated_cap to 5
    await db.prepare(`
      UPDATE desk_policy
      SET daily_automated_cap = 5, min_automated_gap_seconds = 0
      WHERE id = 1
    `).run();

    // Today's counter has automated_count = 5 (at limit)
    const tz = "America/New_York";
    const dayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now));
    await db.prepare(`
      INSERT INTO daily_counter (day_local, automated_count, manual_count)
      VALUES (?, 5, 0)
    `).run(dayLocal);

    // Insert an automated sequence candidate (blocked by cap) and a manual candidate
    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, body, kind, status, earliest_due_at, due_at, created_at
      ) VALUES
        ('out_seq', '+12125550102', '12125550102@c.us', 'Seq msg', 'sequence', 'queued', ?, ?, ?),
        ('out_man', '+12125550103', '12125550103@c.us', 'Man msg', 'manual', 'queued', ?, ?, ?)
    `).run(now - 2000, now - 2000, now - 2000, now - 1000, now - 1000, now - 1000);

    const claimRes = await claimNext(db, device1Id, now);
    expect(claimRes.item).not.toBeNull();
    // Manual row claimed, sequence row remained queued because of cap
    expect(claimRes.item?.outboundId).toBe("out_man");
  });

  it("4. Claim expiry keeps ack_token_hash and transitions status to needs_review", async () => {
    const now = Date.now();
    const tokenHash = sha256("expired-token");

    // Seed a claimed message that expired 5 minutes ago
    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, body, kind, status, earliest_due_at, due_at,
        claimed_by_device_id, claimed_at, claim_expires_at, claim_token_hash, ack_token_hash, created_at
      ) VALUES (
        'out_stale', '+12125550104', '12125550104@c.us', 'Stale msg', 'manual', 'claimed',
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      now - 600_000,
      now - 600_000,
      device1Id,
      now - 400_000,
      now - 300_000, // expired
      tokenHash,
      tokenHash,
      now - 600_000
    );

    // Calling claimNext triggers expiration of stale claims
    await claimNext(db, device1Id, now);

    const staleRow = await db.prepare("SELECT * FROM outbound_queue WHERE id = 'out_stale'").get() as any;
    expect(staleRow.status).toBe("needs_review");
    expect(staleRow.last_error).toBe("claim_expired");
    expect(staleRow.claim_token_hash).toBeNull();
    // Invariant: ack_token_hash is PRESERVED so a late ack from the device can still succeed!
    expect(staleRow.ack_token_hash).toBe(tokenHash);
  });

  it("5. Late ack succeeds and marks row as sent", async () => {
    const now = Date.now();
    const rawToken = "my-late-ack-claim-token";
    const tokenHash = sha256(rawToken);

    // Stale row in needs_review with ack_token_hash intact and claim_token_hash null
    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, body, kind, status, earliest_due_at, due_at,
        claimed_by_device_id, claim_token_hash, ack_token_hash, created_at
      ) VALUES (
        'out_late', '+12125550105', '12125550105@c.us', 'Late msg', 'manual', 'needs_review',
        ?, ?, ?, NULL, ?, ?
      )
    `).run(now - 100_000, now - 100_000, device1Id, tokenHash, now - 100_000);

    const ackRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/outbound/out_late/ack",
      headers: { authorization: `Bearer ${device1Token}` },
      payload: {
        claimToken: rawToken,
        waMessageId: "false_12125550105@c.us_3EB0ABC1234567890DEF",
        toJid: "12125550105@c.us",
      },
    });

    expect(ackRes.statusCode).toBe(200);
    expect(ackRes.json().status).toBe("sent");

    const updated = await db.prepare("SELECT * FROM outbound_queue WHERE id = 'out_late'").get() as any;
    expect(updated.status).toBe("sent");
    expect(updated.wa_message_id).toBe("false_12125550105@c.us_3EB0ABC1234567890DEF");
    expect(updated.ack_token_hash).toBeNull();
  });

  it("6. Operator retry clears hashes and sets attempt_count=0", async () => {
    const now = Date.now();
    const tokenHash = sha256("some-hash");

    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, body, kind, status, earliest_due_at, due_at,
        claimed_by_device_id, claim_token_hash, ack_token_hash, attempt_count, last_error, created_at
      ) VALUES (
        'out_retry', '+12125550106', '12125550106@c.us', 'Retry me', 'manual', 'failed',
        ?, ?, ?, ?, ?, 3, 'bridge_timeout', ?
      )
    `).run(now, now, device1Id, tokenHash, tokenHash, now);

    const retryRes = await app.inject({
      method: "POST",
      url: "/api/v1/outbound/out_retry/retry",
      headers: { cookie: operatorCookie, "x-leaddesk-client": "web" },
    });

    expect(retryRes.statusCode).toBe(200);
    const body = retryRes.json();
    expect(body.status).toBe("queued");
    expect(body.attemptCount).toBe(0);

    const updated = await db.prepare("SELECT * FROM outbound_queue WHERE id = 'out_retry'").get() as any;
    expect(updated.status).toBe("queued");
    expect(updated.attempt_count).toBe(0);
    expect(updated.claim_token_hash).toBeNull();
    expect(updated.ack_token_hash).toBeNull();
    expect(updated.claimed_by_device_id).toBeNull();
  });

  it("7. Lost-200 replays for ack and uncertain", async () => {
    const now = Date.now();
    const claimToken = "replay-token-123";
    const tokenHash = sha256(claimToken);
    const waId = "false_12125550107@c.us_3EB0AAA1111222233334";

    // --- Part A: Ack replay ---
    // Outbound row already marked sent
    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, body, kind, status, earliest_due_at, due_at,
        claimed_by_device_id, wa_message_id, created_at, sent_at
      ) VALUES (
        'out_sent_replay', '+12125550107', '12125550107@c.us', 'Sent msg', 'manual', 'sent',
        ?, ?, ?, ?, ?, ?
      )
    `).run(now, now, device1Id, waId, now, now);

    const ackReplayRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/outbound/out_sent_replay/ack",
      headers: { authorization: `Bearer ${device1Token}` },
      payload: {
        claimToken,
        waMessageId: waId,
        toJid: "12125550107@c.us",
      },
    });

    expect(ackReplayRes.statusCode).toBe(200);
    expect(ackReplayRes.json()).toEqual({ status: "sent" });

    // --- Part B: Uncertain replay ---
    // Outbound row already in needs_review with matching ack_token_hash
    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, body, kind, status, earliest_due_at, due_at,
        claimed_by_device_id, ack_token_hash, claim_token_hash, created_at
      ) VALUES (
        'out_unc_replay', '+12125550108', '12125550108@c.us', 'Unc msg', 'manual', 'needs_review',
        ?, ?, ?, ?, NULL, ?
      )
    `).run(now, now, device1Id, tokenHash, now);

    const uncReplayRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/outbound/out_unc_replay/uncertain",
      headers: { authorization: `Bearer ${device1Token}` },
      payload: {
        claimToken,
        errorClass: "bridge_threw",
        detail: "timeout waiting for id",
      },
    });

    expect(uncReplayRes.statusCode).toBe(200);
    expect(uncReplayRes.json()).toEqual({ status: "needs_review" });
  });

  it("8. Fail rejects bridge_threw and missing_id", async () => {
    const now = Date.now();
    const claimToken = "fail-token-123";
    const tokenHash = sha256(claimToken);

    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, body, kind, status, earliest_due_at, due_at,
        claimed_by_device_id, claim_token_hash, ack_token_hash, created_at
      ) VALUES (
        'out_fail_test', '+12125550109', '12125550109@c.us', 'Fail msg', 'manual', 'claimed',
        ?, ?, ?, ?, ?, ?
      )
    `).run(now, now, device1Id, tokenHash, tokenHash, now);

    // Test rejection of bridge_threw
    const failRes1 = await app.inject({
      method: "POST",
      url: "/api/v1/extension/outbound/out_fail_test/fail",
      headers: { authorization: `Bearer ${device1Token}` },
      payload: {
        claimToken,
        errorClass: "bridge_threw",
        transient: true,
      },
    });

    expect(failRes1.statusCode).toBe(400);
    expect(failRes1.json().error.code).toBe("validation");
    expect(failRes1.json().error.message).toContain("bridge_threw and missing_id must use uncertain endpoint");

    // Test rejection of missing_id
    const failRes2 = await app.inject({
      method: "POST",
      url: "/api/v1/extension/outbound/out_fail_test/fail",
      headers: { authorization: `Bearer ${device1Token}` },
      payload: {
        claimToken,
        errorClass: "missing_id",
        transient: true,
      },
    });

    expect(failRes2.statusCode).toBe(400);
    expect(failRes2.json().error.code).toBe("validation");
  });

  it("9. A resolved @lid ack is sent when the phone wid matches", async () => {
    const now = Date.now();
    const claimToken = "lid-token-123";
    const tokenHash = sha256(claimToken);
    const waId = "true_205926483649218@lid_3EB0LID";

    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, needs_resolve, body, kind, status, earliest_due_at, due_at,
        claimed_by_device_id, claim_token_hash, ack_token_hash, created_at
      ) VALUES (
        'out_lid', '+919479681430', NULL, 1, 'hello from lead desk', 'manual', 'claimed',
        ?, ?, ?, ?, ?, ?
      )
    `).run(now, now, device1Id, tokenHash, tokenHash, now);

    const ackRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/outbound/out_lid/ack",
      headers: { authorization: `Bearer ${device1Token}` },
      payload: {
        claimToken,
        waMessageId: waId,
        toJid: "205926483649218@lid",
        phoneJid: "919479681430@c.us",
      },
    });

    expect(ackRes.statusCode).toBe(200);
    expect(ackRes.json()).toEqual({ status: "sent" });
    const row = await db.prepare("SELECT status, to_jid, wa_message_id FROM outbound_queue WHERE id = 'out_lid'").get() as {
      status: string;
      to_jid: string;
      wa_message_id: string;
    };
    expect(row.status).toBe("sent");
    expect(row.to_jid).toBe("205926483649218@lid");
    expect(row.wa_message_id).toBe(waId);

    const wrongToken = "lid-token-wrong";
    const wrongHash = sha256(wrongToken);
    await db.prepare(`
      INSERT INTO outbound_queue (
        id, to_e164, to_jid, needs_resolve, body, kind, status, earliest_due_at, due_at,
        claimed_by_device_id, claim_token_hash, ack_token_hash, created_at
      ) VALUES (
        'out_lid_bad', '+919479681430', NULL, 1, 'wrong chat', 'manual', 'claimed',
        ?, ?, ?, ?, ?, ?
      )
    `).run(now, now, device1Id, wrongHash, wrongHash, now);

    const badRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/outbound/out_lid_bad/ack",
      headers: { authorization: `Bearer ${device1Token}` },
      payload: {
        claimToken: wrongToken,
        waMessageId: "true_999@lid_OTHER",
        toJid: "999@lid",
        phoneJid: "15550000000@c.us",
      },
    });

    expect(badRes.statusCode).toBe(200);
    expect(badRes.json()).toEqual({ status: "needs_review" });
  });
});
