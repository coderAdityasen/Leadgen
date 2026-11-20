import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { sha256 } from "../src/auth.js";
import { claimNext } from "../src/queue.js";
import type { Db } from "../src/db.js";
import type { FastifyInstance } from "fastify";
import { setupAdmin } from "./helpers.js";

describe("Follow-up sequences and step advancement (PR 10)", () => {
  let app: FastifyInstance;
  let db: Db;
  let operatorCookie: string;
  let operatorHeaders: Record<string, string>;
  const deviceToken = "dev-token-secret-123456";
  const deviceId = "dev_01J00000000000000000000001";
  let leadId: string;
  let stageId: string;

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
    operatorHeaders = {
      cookie: operatorCookie,
      "x-leaddesk-client": "web",
    };

    // Get a default stage
    const stageRes = await app.inject({
      method: "GET",
      url: "/api/v1/stages",
      headers: { cookie: operatorCookie },
    });
    stageId = JSON.parse(stageRes.body).items[0].id;

    // Create a test lead
    const leadRes = await app.inject({
      method: "POST",
      url: "/api/v1/leads",
      headers: operatorHeaders,
      payload: {
        displayName: "Alice Smith",
        phoneE164: "+12125550199",
        stageId,
      },
    });
    leadId = JSON.parse(leadRes.body).id;

    // Seed paired extension device
    const now = Date.now();
    await db.prepare(`
      INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at, authenticated)
      VALUES (?, 'Device 1', ?, ?, ?, 1)
    `).run(deviceId, sha256(deviceToken), now, now);

    // Give Device 1 active sender lease
    await db.prepare(`
      UPDATE sender_lease
      SET device_id = ?, lease_until = ?, grace_until = NULL
      WHERE id = 1
    `).run(deviceId, now + 3600_000);

    // Default: quiet hours and rate gaps disabled in unit tests
    await db.prepare("UPDATE desk_policy SET quiet_hours_enabled = 0, min_automated_gap_seconds = 0, min_same_lead_gap_seconds = 0 WHERE id = 1").run();
  });

  afterEach(async () => {
    await app.close();
  });

  it("1. Sequence CRUD and step validation", async () => {
    // Create sequence
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: operatorHeaders,
      payload: { name: "Post-demo sequence" },
    });
    expect(createRes.statusCode).toBe(201);
    const seq = JSON.parse(createRes.body);
    expect(seq.id).toMatch(/^seq_/);
    expect(seq.name).toBe("Post-demo sequence");
    expect(seq.enabled).toBe(true);

    // Invalid placeholder check
    const invalidStepRes = await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seq.id}/steps`,
      headers: operatorHeaders,
      payload: {
        steps: [
          { delaySeconds: 0, body: "Hello {{wrong_var}}" },
        ],
      },
    });
    expect(invalidStepRes.statusCode).toBe(400);

    // Valid steps: step 0 (immediate) and step 1 (24 hours)
    const validStepRes = await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seq.id}/steps`,
      headers: operatorHeaders,
      payload: {
        steps: [
          { delaySeconds: 0, body: "Thanks for meeting, {{display_name}}!" },
          { delaySeconds: 86400, body: "Checking in {{display_name}}, any questions?" },
        ],
      },
    });
    expect(validStepRes.statusCode).toBe(200);
    const updated = JSON.parse(validStepRes.body);
    expect(updated.steps).toHaveLength(2);
    expect(updated.steps[0].position).toBe(0);
    expect(updated.steps[1].position).toBe(1);
    expect(updated.steps[1].delaySeconds).toBe(86400);
  });

  it("2. Enroll lead: step 0 materialized, step 1 does NOT exist before ack, idempotency replay", async () => {
    // Create sequence with 2 steps
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: operatorHeaders,
      payload: { name: "Nurture" },
    });
    const seq = JSON.parse(createRes.body);

    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seq.id}/steps`,
      headers: operatorHeaders,
      payload: {
        steps: [
          { delaySeconds: 0, body: "Step 0 for {{display_name}}" },
          { delaySeconds: 3600, body: "Step 1 for {{display_name}}" },
        ],
      },
    });

    const idempotencyKey = "enr-idem-key-123";

    // Enroll lead
    const enrollRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${seq.id}/enrollments`,
      headers: {
        ...operatorHeaders,
        "Idempotency-Key": idempotencyKey,
      },
      payload: { leadId },
    });
    expect(enrollRes.statusCode).toBe(201);
    const enr = JSON.parse(enrollRes.body);
    expect(enr.status).toBe("active");

    // Idempotency replay check: same key returns 201 with same id
    const replayRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${seq.id}/enrollments`,
      headers: {
        ...operatorHeaders,
        "Idempotency-Key": idempotencyKey,
      },
      payload: { leadId },
    });
    expect(replayRes.statusCode).toBe(201);
    expect(JSON.parse(replayRes.body).id).toBe(enr.id);

    // Verify only Step 0 is materialized in outbound_queue
    const outRows = await db.prepare("SELECT * FROM outbound_queue WHERE enrollment_id = ?").all(enr.id) as any[];
    expect(outRows).toHaveLength(1);
    expect(outRows[0].body).toBe("Step 0 for Alice Smith");
    expect(outRows[0].status).toBe("queued");
    expect(outRows[0].idempotency_key).toBe(`seq:${enr.id}:${outRows[0].step_id}`);

    // Verify steps_in_use 409
    const stepChangeRes = await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seq.id}/steps`,
      headers: operatorHeaders,
      payload: {
        steps: [{ delaySeconds: 0, body: "New step" }],
      },
    });
    expect(stepChangeRes.statusCode).toBe(409);
    expect(JSON.parse(stepChangeRes.body).error.code).toBe("steps_in_use");
  });

  it("3. One active enrollment per lead rule", async () => {
    // Create two sequences
    const seq1Res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: operatorHeaders,
      payload: { name: "Sequence A" },
    });
    const seq1Id = JSON.parse(seq1Res.body).id;
    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seq1Id}/steps`,
      headers: operatorHeaders,
      payload: { steps: [{ delaySeconds: 0, body: "Seq A Step 1" }] },
    });

    const seq2Res = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: operatorHeaders,
      payload: { name: "Sequence B" },
    });
    const seq2Id = JSON.parse(seq2Res.body).id;
    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seq2Id}/steps`,
      headers: operatorHeaders,
      payload: { steps: [{ delaySeconds: 0, body: "Seq B Step 1" }] },
    });

    // Enroll in Seq 1
    const enr1Res = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${seq1Id}/enrollments`,
      headers: {
        ...operatorHeaders,
        "Idempotency-Key": "enr-key-seq1",
      },
      payload: { leadId },
    });
    expect(enr1Res.statusCode).toBe(201);

    // Attempt to enroll in Seq 2 while active in Seq 1 -> 409
    const enr2Res = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${seq2Id}/enrollments`,
      headers: {
        ...operatorHeaders,
        "Idempotency-Key": "enr-key-seq2",
      },
      payload: { leadId },
    });
    expect(enr2Res.statusCode).toBe(409);
    expect(JSON.parse(enr2Res.body).error.code).toBe("already_enrolled");
  });

  it("4. Step advancement on Ack: step 1 is created, and last step ack marks completed", async () => {
    const seqRes = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: operatorHeaders,
      payload: { name: "2-Step Flow" },
    });
    const seqId = JSON.parse(seqRes.body).id;

    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seqId}/steps`,
      headers: operatorHeaders,
      payload: {
        steps: [
          { delaySeconds: 0, body: "First step {{display_name}}" },
          { delaySeconds: 60, body: "Second step {{display_name}}" },
        ],
      },
    });

    const enrollRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${seqId}/enrollments`,
      headers: {
        ...operatorHeaders,
        "Idempotency-Key": "enr-flow-1",
      },
      payload: { leadId },
    });
    expect(enrollRes.statusCode).toBe(201);
    const enrId = JSON.parse(enrollRes.body).id;

    // Step 0 is in outbound queue. Claim it.
    const now = Date.now();
    const claimRes = await claimNext(db, deviceId, now);
    expect(claimRes.item).toBeDefined();
    expect(claimRes.item?.body).toBe("First step Alice Smith");

    // Ack step 0
    const ackRes = await app.inject({
      method: "POST",
      url: `/api/v1/extension/outbound/${claimRes.item!.outboundId}/ack`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        claimToken: claimRes.item!.claimToken,
        toJid: "12125550199@c.us",
        waMessageId: "true_12125550199@c.us_3EB01234567890",
      },
    });
    expect(ackRes.statusCode).toBe(200);

    // Verify step 1 has now been materialized in outbound_queue
    const outRows = await db.prepare("SELECT * FROM outbound_queue WHERE enrollment_id = ? ORDER BY id ASC").all(enrId) as any[];
    expect(outRows).toHaveLength(2);
    expect(outRows[0].status).toBe("sent");
    expect(outRows[1].status).toBe("queued");
    expect(outRows[1].body).toBe("Second step Alice Smith");

    // Check enrollment current step pointer
    const enrRow1 = await db.prepare("SELECT * FROM sequence_enrollment WHERE id = ?").get(enrId) as any;
    expect(enrRow1.status).toBe("active");
    expect(enrRow1.current_step_id).toBe(outRows[1].step_id);

    // Claim step 1 (set time past delay)
    const step1Time = now + 70_000;
    const claimStep1 = await claimNext(db, deviceId, step1Time);
    expect(claimStep1.item).toBeDefined();
    expect(claimStep1.item?.outboundId).toBe(outRows[1].id);

    // Ack step 1 (last step)
    const ackStep1 = await app.inject({
      method: "POST",
      url: `/api/v1/extension/outbound/${claimStep1.item!.outboundId}/ack`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        claimToken: claimStep1.item!.claimToken,
        toJid: "12125550199@c.us",
        waMessageId: "true_12125550199@c.us_3EB09999999999",
      },
    });
    expect(ackStep1.statusCode).toBe(200);

    // Verify sequence enrollment is completed
    const enrRowCompleted = await db.prepare("SELECT * FROM sequence_enrollment WHERE id = ?").get(enrId) as any;
    expect(enrRowCompleted.status).toBe("completed");
    expect(enrRowCompleted.stopped_at).toBeDefined();

    // No further steps materialized
    const allOutRows = await db.prepare("SELECT * FROM outbound_queue WHERE enrollment_id = ?").all(enrId) as any[];
    expect(allOutRows).toHaveLength(2);
  });

  it("5. Delay landing in quiet hours rolls due_at on step materialize", async () => {
    const seqRes = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: operatorHeaders,
      payload: { name: "Quiet-Roll Sequence" },
    });
    const seqId = JSON.parse(seqRes.body).id;

    // Step 0: delay 0
    // Step 1: delay 100 seconds
    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seqId}/steps`,
      headers: operatorHeaders,
      payload: {
        steps: [
          { delaySeconds: 0, body: "Step 0" },
          { delaySeconds: 100, body: "Step 1" },
        ],
      },
    });

    const enrollRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${seqId}/enrollments`,
      headers: {
        ...operatorHeaders,
        "Idempotency-Key": "enr-quiet-1",
      },
      payload: { leadId },
    });
    expect(enrollRes.statusCode).toBe(201);
    const enrId = JSON.parse(enrollRes.body).id;

    // Claim step 0 while quiet hours are disabled
    const claimRes = await claimNext(db, deviceId, Date.now());
    expect(claimRes.item).toBeDefined();

    // Enable quiet hours: 00:00 to 23:59 covering the whole day
    await db.prepare(`
      UPDATE desk_policy
      SET quiet_hours_enabled = 1, quiet_start = '00:00', quiet_end = '23:59'
      WHERE id = 1
    `).run();

    // Ack step 0
    const ackRes = await app.inject({
      method: "POST",
      url: `/api/v1/extension/outbound/${claimRes.item!.outboundId}/ack`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        claimToken: claimRes.item!.claimToken,
        toJid: "12125550199@c.us",
        waMessageId: "true_12125550199@c.us_3EB0QUIETROLL",
      },
    });
    expect(ackRes.statusCode).toBe(200);

    const step1Row = await db.prepare("SELECT * FROM outbound_queue WHERE enrollment_id = ? AND status = 'queued'").get(enrId) as any;
    expect(step1Row).toBeDefined();
    expect(step1Row.due_at).toBeGreaterThan(step1Row.earliest_due_at);
  });

  it("6. Cancelling outbound row marks enrollment cancelled", async () => {
    const seqRes = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: operatorHeaders,
      payload: { name: "Cancel test" },
    });
    const seqId = JSON.parse(seqRes.body).id;

    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seqId}/steps`,
      headers: operatorHeaders,
      payload: {
        steps: [{ delaySeconds: 0, body: "Step 0" }],
      },
    });

    const enrollRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${seqId}/enrollments`,
      headers: {
        ...operatorHeaders,
        "Idempotency-Key": "enr-cancel-test",
      },
      payload: { leadId },
    });
    expect(enrollRes.statusCode).toBe(201);
    const enrId = JSON.parse(enrollRes.body).id;

    const outRow = await db.prepare("SELECT id FROM outbound_queue WHERE enrollment_id = ?").get(enrId) as { id: string };
    expect(outRow).toBeDefined();

    // Cancel outbound row via /outbound/:id/cancel
    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/v1/outbound/${outRow.id}/cancel`,
      headers: operatorHeaders,
    });
    expect(cancelRes.statusCode).toBe(200);

    // Verify enrollment is cancelled
    const enr = await db.prepare("SELECT * FROM sequence_enrollment WHERE id = ?").get(enrId) as any;
    expect(enr.status).toBe("cancelled");
    expect(enr.stop_reason).toBe("cancelled");
    expect(enr.stopped_at).toBeDefined();
  });

  it("7. Cancelling enrollment cancels pending outbound row", async () => {
    const seqRes = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: operatorHeaders,
      payload: { name: "Enrollment cancel" },
    });
    const seqId = JSON.parse(seqRes.body).id;

    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seqId}/steps`,
      headers: operatorHeaders,
      payload: {
        steps: [{ delaySeconds: 0, body: "Step 0" }],
      },
    });

    const enrollRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${seqId}/enrollments`,
      headers: {
        ...operatorHeaders,
        "Idempotency-Key": "enr-cancel-enr-test",
      },
      payload: { leadId },
    });
    expect(enrollRes.statusCode).toBe(201);
    const enrId = JSON.parse(enrollRes.body).id;

    // Cancel enrollment via /enrollments/:id/cancel
    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/v1/enrollments/${enrId}/cancel`,
      headers: operatorHeaders,
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(JSON.parse(cancelRes.body).status).toBe("cancelled");

    // Verify outbound row is cancelled
    const outRow = await db.prepare("SELECT * FROM outbound_queue WHERE enrollment_id = ?").get(enrId) as any;
    expect(outRow.status).toBe("cancelled");
  });

  it("8. Step failure marks sequence enrollment stopped with step_failed", async () => {
    const seqRes = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: operatorHeaders,
      payload: { name: "Fail test" },
    });
    const seqId = JSON.parse(seqRes.body).id;

    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seqId}/steps`,
      headers: operatorHeaders,
      payload: {
        steps: [{ delaySeconds: 0, body: "Step 0" }],
      },
    });

    const enrollRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${seqId}/enrollments`,
      headers: {
        ...operatorHeaders,
        "Idempotency-Key": "enr-fail-test",
      },
      payload: { leadId },
    });
    expect(enrollRes.statusCode).toBe(201);
    const enrId = JSON.parse(enrollRes.body).id;

    // Claim the step
    const claimRes = await claimNext(db, deviceId, Date.now());
    expect(claimRes.item).toBeDefined();

    // Fail with non-transient error (e.g. invalid recipient)
    const failRes = await app.inject({
      method: "POST",
      url: `/api/v1/extension/outbound/${claimRes.item!.outboundId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        claimToken: claimRes.item!.claimToken,
        transient: false,
        errorClass: "not_on_whatsapp",
        detail: "User is not on WhatsApp",
      },
    });
    expect(failRes.statusCode).toBe(200);
    expect(JSON.parse(failRes.body).status).toBe("failed");

    // Enrollment should be stopped with step_failed
    const enr = await db.prepare("SELECT * FROM sequence_enrollment WHERE id = ?").get(enrId) as any;
    expect(enr.status).toBe("stopped");
    expect(enr.stop_reason).toBe("step_failed");
  });

  it("9. Toggling doNotMessage stops active sequence enrollment", async () => {
    const seqRes = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: operatorHeaders,
      payload: { name: "DNM test" },
    });
    const seqId = JSON.parse(seqRes.body).id;

    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seqId}/steps`,
      headers: operatorHeaders,
      payload: {
        steps: [{ delaySeconds: 0, body: "Step 0" }],
      },
    });

    const enrollRes = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${seqId}/enrollments`,
      headers: {
        ...operatorHeaders,
        "Idempotency-Key": "enr-dnm-test",
      },
      payload: { leadId },
    });
    expect(enrollRes.statusCode).toBe(201);
    const enrId = JSON.parse(enrollRes.body).id;

    // Mark lead doNotMessage
    await app.inject({
      method: "PATCH",
      url: `/api/v1/leads/${leadId}`,
      headers: operatorHeaders,
      payload: { doNotMessage: true },
    });

    const enr = await db.prepare("SELECT * FROM sequence_enrollment WHERE id = ?").get(enrId) as any;
    expect(enr.status).toBe("stopped");
    expect(enr.stop_reason).toBe("do_not_message");

    const outRow = await db.prepare("SELECT * FROM outbound_queue WHERE enrollment_id = ?").get(enrId) as any;
    expect(outRow.status).toBe("cancelled");
  });
});
