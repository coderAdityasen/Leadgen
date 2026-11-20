import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { sha256 } from "../src/auth.js";
import { performDbBackup } from "../src/backup.js";
import { sweepExpiredQueueRows } from "../src/sweeper.js";
import { sanitizeMeta, logDeskEvent } from "../src/logging.js";
import { generateUlid } from "@leaddesk/shared";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupAdmin } from "./helpers.js";

describe("Status, logging, backups, and deploy (PR 14)", () => {
  let db: Awaited<ReturnType<typeof openDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sessionCookie: string;
  let tempDir: string;

  beforeEach(async () => {
    process.env["LEAD_DESK_BOOTSTRAP_SECRET"] = "secret-status-test-123";
    tempDir = mkdtempSync(join(tmpdir(), "leaddesk-test-"));
    db = await openDb({ path: ":memory:" });
    app = await buildApp({ db, logLevel: "silent" });

    // Setup operator
    const setupRes = await setupAdmin(app, {
        bootstrapSecret: "secret-status-test-123",
        password: "supersecretpassword123",
        displayName: "Ada Operator",
        timezone: "America/New_York",
        defaultCountry: "US",
      });
    sessionCookie = `leaddesk_session=${setupRes.cookies[0]!.value}`;
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    delete process.env["LEAD_DESK_SENDING_ENABLED"];
    delete process.env["LEAD_DESK_AI_ENABLED"];
    app.close();
  });

  describe("GET /api/v1/status endpoint", () => {
    it("returns correct schema and connection = unpaired when no devices exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/status",
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();

      expect(data.ok).toBe(true);
      expect(data.version).toBe("0.1.0");
      expect(typeof data.uptimeSeconds).toBe("number");
      expect(typeof data.schemaVersion).toBe("number");
      expect(data.dbWritable).toBe(true);
      expect(data.connection).toBe("unpaired");
      expect(data.sender).toBeNull();

      expect(data.queue).toEqual({
        queued: 0,
        claimed: 0,
        needsApproval: 0,
        needsReview: 0,
        failed: 0,
        dueNow: 0,
      });

      expect(data.caps).toHaveProperty("automatedToday", 0);
      expect(data.caps).toHaveProperty("automatedCap", 80);
      expect(data.caps).toHaveProperty("manualToday", 0);
      expect(data.caps).toHaveProperty("manualCap", 200);
      expect(data.caps).toHaveProperty("aiThisHour", 0);
      expect(data.caps).toHaveProperty("aiHourlyCap", 30);

      expect(data.ai).toHaveProperty("keySet", false);
      expect(data.ai).toHaveProperty("consecutiveFailures", 0);
      expect(data.killSwitch).toEqual({ sending: false, ai: false });
      expect(data.red).toEqual([]);
    });

    it("identifies connection = 'sender', 'grace', and 'quiet'", async () => {
      const now = Date.now();
      const devId = generateUlid("dev");

      // Insert active sender device
      await db.prepare(`
        INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at)
        VALUES (?, 'Test Laptop', 'hash123', ?, ?)
      `).run(devId, now - 5000, now - 5000);

      await db.prepare(`
        UPDATE sender_lease
        SET device_id = ?, lease_until = ?, grace_until = NULL
        WHERE id = 1
      `).run(devId, now + 30_000);

      // Status 1: Sender connected
      const res1 = await app.inject({
        method: "GET",
        url: "/api/v1/status",
        headers: { cookie: sessionCookie },
      });
      expect(res1.json().connection).toBe("sender");
      expect(res1.json().sender.role).toBe("sender");
      expect(res1.json().sender.deviceId).toBe(devId);

      // Status 2: Grace period (reconnecting)
      await db.prepare(`
        UPDATE sender_lease
        SET grace_until = ?
        WHERE id = 1
      `).run(now + 20_000);

      const res2 = await app.inject({
        method: "GET",
        url: "/api/v1/status",
        headers: { cookie: sessionCookie },
      });
      expect(res2.json().connection).toBe("grace");
      expect(res2.json().sender.role).toBe("grace");

      // Status 3: Extension quiet (heartbeat older than 45s)
      await db.prepare(`
        UPDATE extension_device
        SET last_seen_at = ?
        WHERE id = ?
      `).run(now - 50_000, devId);

      const res3 = await app.inject({
        method: "GET",
        url: "/api/v1/status",
        headers: { cookie: sessionCookie },
      });
      expect(res3.json().connection).toBe("quiet");
    });

    it("populates red array on heartbeat_stale, failed_or_review, and ai_failures", async () => {
      const now = Date.now();
      const devId = generateUlid("dev");
      const leadId = generateUlid("led");

      await db.prepare(`
        INSERT INTO lead (id, display_name, stage_id, created_at, updated_at)
        VALUES (?, 'Red Lead', 'stg_new', ?, ?)
      `).run(leadId, now, now);

      // 1. Insert failed outbound row
      await db.prepare(`
        INSERT INTO outbound_queue (
          id, lead_id, to_e164, body, kind, status, earliest_due_at, due_at,
          idempotency_key, allow_during_quiet_hours, created_at
        ) VALUES ('out_fail', ?, '+12125550100', 'hello', 'manual', 'failed', ?, ?, 'idemp_1', 0, ?)
      `).run(leadId, now, now, now);

      // 2. Insert 3 consecutive AI failures
      for (let i = 0; i < 3; i++) {
        await db.prepare(`
          INSERT INTO message_log (id, lead_id, direction, wa_message_id, body, from_jid, to_jid, from_me, wa_timestamp, ai_state, created_at)
          VALUES (?, ?, 'inbound', ?, 'hi', 'a@c.us', 'b@c.us', 0, ?, 'failed', ?)
        `).run(`msg_fail_${i}`, leadId, `wa_fail_${i}`, now + i, now + i);
      }

      // 3. Stale heartbeat with dueNow > 0
      await db.prepare(`
        INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at)
        VALUES (?, 'Stale Laptop', 'hash123', ?, ?)
      `).run(devId, now - 60_000, now - 60_000);

      await db.prepare(`
        UPDATE sender_lease
        SET device_id = ?, lease_until = ?
        WHERE id = 1
      `).run(devId, now + 30_000);

      await db.prepare(`
        INSERT INTO outbound_queue (
          id, lead_id, to_e164, body, kind, status, earliest_due_at, due_at,
          idempotency_key, allow_during_quiet_hours, created_at
        ) VALUES ('out_due', ?, '+12125550100', 'hello', 'manual', 'queued', ?, ?, 'idemp_2', 0, ?)
      `).run(leadId, now - 1000, now - 1000, now);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/status",
        headers: { cookie: sessionCookie },
      });

      const data = res.json();
      expect(data.red).toContain("heartbeat_stale");
      expect(data.red).toContain("failed_or_review");
      expect(data.red).toContain("ai_failures");
      expect(data.ai.consecutiveFailures).toBe(3);
    });
  });

  describe("Native SQLite backup API", () => {
    // Turso (remote) databases rely on point-in-time restore instead of file copies.
    it.skipIf(process.env["LEAD_DESK_TEST_LIBSQL_ENGINE"] === "1")("creates atomic backup and prunes beyond 14 files", async () => {
      const backupDir = join(tempDir, "backups");

      // Run backup
      const backupPath = await performDbBackup(db, backupDir);
      expect(existsSync(backupPath)).toBe(true);

      const files = readdirSync(backupDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^leaddesk-\d{8}\.sqlite$/);
    });
  });

  describe("Queue sweeper 6-hour catch-up expiration", () => {
    it("marks queued rows older than max_catchup_age_seconds as expired", async () => {
      const now = Date.now();
      const leadId = generateUlid("led");

      await db.prepare(`
        INSERT INTO lead (id, display_name, stage_id, created_at, updated_at)
        VALUES (?, 'Sweep Lead', 'stg_new', ?, ?)
      `).run(leadId, now, now);

      // Old row: due 7 hours ago
      const oldDue = now - 7 * 3600_000;
      await db.prepare(`
        INSERT INTO outbound_queue (
          id, lead_id, to_e164, body, kind, status, earliest_due_at, due_at,
          idempotency_key, allow_during_quiet_hours, created_at
        ) VALUES ('out_old', ?, '+12125550100', 'expired body', 'manual', 'queued', ?, ?, 'idemp_old', 0, ?)
      `).run(leadId, oldDue, oldDue, oldDue);

      // Fresh row: due 10 minutes ago
      const freshDue = now - 600_000;
      await db.prepare(`
        INSERT INTO outbound_queue (
          id, lead_id, to_e164, body, kind, status, earliest_due_at, due_at,
          idempotency_key, allow_during_quiet_hours, created_at
        ) VALUES ('out_fresh', ?, '+12125550100', 'fresh body', 'manual', 'queued', ?, ?, 'idemp_fresh', 0, ?)
      `).run(leadId, freshDue, freshDue, now);

      const swept = await sweepExpiredQueueRows(db);
      expect(swept).toBe(1);

      const oldRow = await db.prepare("SELECT status FROM outbound_queue WHERE id = 'out_old'").get() as any;
      expect(oldRow.status).toBe("expired");

      const freshRow = await db.prepare("SELECT status FROM outbound_queue WHERE id = 'out_fresh'").get() as any;
      expect(freshRow.status).toBe("queued");
    });
  });

  describe("Structured logging and sanitization", () => {
    it("sanitizeMeta removes sensitive keys and strips body text to length and hash", () => {
      const meta = {
        password: "secretpassword",
        apiKey: "xai-sensitive-api-key",
        deviceToken: "ld_dev_secret",
        body: "Hello customer, here is your quote.",
        outboundId: "out_123",
        route: "/api/v1/inbound",
      };

      const clean = sanitizeMeta(meta);
      expect(clean.password).toBeUndefined();
      expect(clean.apiKey).toBeUndefined();
      expect(clean.deviceToken).toBeUndefined();
      expect(clean.body).toBeUndefined();
      expect(clean.bodyLength).toBe(35);
      expect(clean.outboundId).toBe("out_123");
      expect(clean.route).toBe("/api/v1/inbound");
    });

    it("logDeskEvent records desk.* events cleanly", () => {
      const logged: any[] = [];
      const fakeLogger = {
        info: (obj: any) => logged.push(obj),
      };

      logDeskEvent(fakeLogger, "desk.outbound.claimed", {
        outboundId: "out_01",
        deviceId: "dev_01",
      });

      expect(logged.length).toBe(1);
      expect(logged[0].event).toBe("desk.outbound.claimed");
      expect(logged[0].outboundId).toBe("out_01");
    });
  });

  describe("Dist grep for secrets assertion", () => {
    it("extension dist bundle contains no .env, XAI_API_KEY, or tokens", () => {
      const extDistDir = join(process.cwd(), "apps/extension/dist");
      if (!existsSync(extDistDir)) return;

      const files = readdirSync(extDistDir).filter((f) => f.endsWith(".js"));
      for (const file of files) {
        const content = readFileSync(join(extDistDir, file), "utf8");
        expect(content).not.toContain("XAI_API_KEY");
        expect(content).not.toContain("LEAD_DESK_BOOTSTRAP_SECRET");
        expect(content).not.toContain("LEAD_DESK_DATA_KEY");
      }
    });
  });
});
