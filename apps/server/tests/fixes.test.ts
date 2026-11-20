import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { sha256 } from "../src/auth.js";
import { claimNext } from "../src/queue.js";
import { sweepExpiredQueueRows } from "../src/sweeper.js";
import { assertAllowedAiHost, isPrivateAddress } from "../src/ai.js";
import { renderStepBody } from "../src/routes/sequences.js";
import type { Db } from "../src/db.js";
import type { FastifyInstance } from "fastify";
import { setupAdmin } from "./helpers.js";

// Regression tests for bugs fixed during the codebase audit.
describe("Audit regressions", () => {
  let app: FastifyInstance;
  let db: Db;
  let headers: Record<string, string>;
  let leadId: string;
  const deviceToken = "dev-token-audit-123456";
  const deviceId = "dev_01J0000000000000000000AUD1";

  beforeEach(async () => {
    process.env["LEAD_DESK_BOOTSTRAP_SECRET"] = "secret-123456789";
    db = await openDb({ path: ":memory:" });
    app = await buildApp({ db, logLevel: "silent" });
    const setupRes = await setupAdmin(app, {
        bootstrapSecret: "secret-123456789",
        password: "supersecretpassword123",
        displayName: "Ada",
        timezone: "UTC",
        defaultCountry: "US",
      });
    headers = { cookie: `leaddesk_session=${setupRes.cookies[0]!.value}`, "x-leaddesk-client": "web" };
    const stageRes = await app.inject({ method: "GET", url: "/api/v1/stages", headers });
    const stageId = stageRes.json().items[0].id;
    const leadRes = await app.inject({
      method: "POST",
      url: "/api/v1/leads",
      headers,
      payload: { displayName: "Bob $' & Co", phoneE164: "+12125550199", stageId },
    });
    leadId = leadRes.json().id;

    const now = Date.now();
    await db.prepare(`
      INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at, authenticated)
      VALUES (?, 'Device 1', ?, ?, ?, 1)
    `).run(deviceId, sha256(deviceToken), now, now);
    await db.prepare("UPDATE sender_lease SET device_id = ?, lease_until = ?, grace_until = NULL WHERE id = 1").run(
      deviceId,
      now + 3600_000
    );
    await db.prepare(
      "UPDATE desk_policy SET quiet_hours_enabled = 0, min_automated_gap_seconds = 0, min_same_lead_gap_seconds = 0 WHERE id = 1"
    ).run();
  });

  afterEach(async () => {
    await app.close();
  });

  async function createSequence(): Promise<string> {
    const seq = await app.inject({ method: "POST", url: "/api/v1/sequences", headers, payload: { name: "S" } });
    const sequenceId = seq.json().id;
    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${sequenceId}/steps`,
      headers,
      payload: { steps: [{ delaySeconds: 0, body: "Hi {{display_name}}" }, { delaySeconds: 60, body: "Again" }] },
    });
    return sequenceId;
  }

  async function enroll(sequenceId: string, key: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/sequences/${sequenceId}/enrollments`,
      headers: { ...headers, "idempotency-key": key },
      payload: { leadId },
    });
  }

  it("inserts $-patterns in a lead name literally into sequence bodies", async () => {
    expect(renderStepBody("Hi {{display_name}}!", "Bob $' & Co")).toBe("Hi Bob $' & Co!");
    const sequenceId = await createSequence();
    expect((await enroll(sequenceId, "k1")).statusCode).toBe(201);
    const row = await db.prepare("SELECT body FROM outbound_queue WHERE kind = 'sequence'").get() as { body: string };
    expect(row.body).toBe("Hi Bob $' & Co");
  });

  it("stops the enrollment when its queued step expires, so the lead can be re-enrolled", async () => {
    const sequenceId = await createSequence();
    await enroll(sequenceId, "k1");
    await db.prepare("UPDATE outbound_queue SET due_at = ? WHERE kind = 'sequence'").run(Date.now() - 7 * 3600_000);
    expect(await sweepExpiredQueueRows(db)).toBe(1);
    const enr = await db.prepare("SELECT status, stop_reason FROM sequence_enrollment").get() as any;
    expect(enr).toEqual({ status: "stopped", stop_reason: "expired" });
    expect((await enroll(sequenceId, "k2")).statusCode).toBe(201);
  });

  it("returns 409 (not a 500) when deleting a sequence that has past enrollments", async () => {
    const sequenceId = await createSequence();
    const enr = (await enroll(sequenceId, "k1")).json();
    await app.inject({ method: "POST", url: `/api/v1/enrollments/${enr.id}/cancel`, headers });
    const del = await app.inject({ method: "DELETE", url: `/api/v1/sequences/${sequenceId}`, headers });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("has_history");
    // Cancelling an enrollment that is no longer active is refused
    const again = await app.inject({ method: "POST", url: `/api/v1/enrollments/${enr.id}/cancel`, headers });
    expect(again.statusCode).toBe(409);
  });

  it("refuses to discard a message that was already sent", async () => {
    const send = await app.inject({
      method: "POST",
      url: `/api/v1/leads/${leadId}/send`,
      headers: { ...headers, "idempotency-key": "send-1" },
      payload: { body: "hello" },
    });
    const outboundId = send.json().outboundId;
    await db.prepare("UPDATE outbound_queue SET status = 'sent', sent_at = ? WHERE id = ?").run(Date.now(), outboundId);
    const res = await app.inject({ method: "POST", url: `/api/v1/outbound/${outboundId}/discard`, headers });
    expect(res.statusCode).toBe(409);
    const row = await db.prepare("SELECT status FROM outbound_queue WHERE id = ?").get(outboundId) as any;
    expect(row.status).toBe("sent");
  });

  it("cancels queued rows for archived leads at claim time", async () => {
    await app.inject({
      method: "POST",
      url: `/api/v1/leads/${leadId}/send`,
      headers: { ...headers, "idempotency-key": "send-2" },
      payload: { body: "hello" },
    });
    await db.prepare("UPDATE lead SET archived_at = ? WHERE id = ?").run(Date.now(), leadId);
    const result = await claimNext(db, deviceId, Date.now());
    expect(result.item).toBeNull();
    const row = await db.prepare("SELECT status, last_error FROM outbound_queue").get() as any;
    expect(row).toEqual({ status: "cancelled", last_error: "archived" });
  });

  it("rejects inbound from a group jid even when labelled direct", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        waMessageId: "wamid-group-1",
        chatJid: "12036302@g.us",
        senderJid: "15550001111@c.us",
        senderLid: null,
        senderPhoneUser: "15550001111",
        fromMe: false,
        body: "hi",
        waTimestamp: new Date().toISOString(),
        chatKind: "direct",
        fromJid: "15550001111@c.us",
        toJid: "15559990000@c.us",
      },
    });
    expect(res.json()).toEqual({ stored: false, reason: "not_direct" });
  });

  it("does not count successful logins toward the login rate limit", async () => {
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        headers: { "x-leaddesk-client": "web" },
        payload: { password: "supersecretpassword123" },
        remoteAddress: "10.9.9.9",
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("validates PATCH /leads displayName type instead of throwing", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leads/${leadId}`,
      headers,
      payload: { displayName: 42 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("AI host validation", () => {
  it("blocks bracketed IPv6 loopback and private IPv4/IPv6 ranges", () => {
    expect(() => assertAllowedAiHost("https://[::1]/v1")).toThrow(/Private/);
    expect(() => assertAllowedAiHost("https://127.0.0.2/v1")).toThrow(/Private/);
    expect(() => assertAllowedAiHost("https://0.0.0.0/v1")).toThrow(/Private/);
    expect(isPrivateAddress("100.64.1.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(() => assertAllowedAiHost("https://api.x.ai/v1")).not.toThrow();
  });
});

describe("Static dashboard serving", () => {
  let cwd: string;
  let dir: string;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "leaddesk-static-"));
    mkdirSync(join(dir, "public/assets"), { recursive: true });
    writeFileSync(join(dir, "public/index.html"), "<!doctype html><div id=root></div>");
    writeFileSync(join(dir, "public/assets/app-123.js"), "console.log(1)");
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves built assets with the right type and falls back to index.html for routes", async () => {
    const db = await openDb({ path: ":memory:" });
    const app = await buildApp({ db, logLevel: "silent" });
    try {
      const js = await app.inject({ method: "GET", url: "/assets/app-123.js" });
      expect(js.statusCode).toBe(200);
      expect(js.headers["content-type"]).toMatch(/javascript/);
      expect(js.body).toBe("console.log(1)");

      const route = await app.inject({ method: "GET", url: "/leads/led_123" });
      expect(route.statusCode).toBe(200);
      expect(route.headers["content-type"]).toMatch(/text\/html/);

      const missing = await app.inject({ method: "GET", url: "/assets/nope.js" });
      expect(missing.statusCode).toBe(404);

      const traversal = await app.inject({ method: "GET", url: "/..%2f..%2fpackage.json" });
      expect(traversal.body).not.toContain("\"name\"");
    } finally {
      await app.close();
    }
  });
});
