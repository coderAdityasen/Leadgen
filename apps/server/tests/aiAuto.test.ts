import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { sha256 } from "../src/auth.js";
import { setAiClientFactory } from "../src/ai.js";
import { generateUlid } from "@leaddesk/shared";
import { setupAdmin } from "./helpers.js";

describe("AI auto-reply mode and automated dispatch (PR 13)", () => {
  let db: Awaited<ReturnType<typeof openDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sessionCookie: string;
  const deviceToken = "dev-ai-auto-secret-123";
  const deviceId = "dev_01J00000000000000000000002";
  let leadId: string;

  beforeEach(async () => {
    process.env["LEAD_DESK_BOOTSTRAP_SECRET"] = "secret-123456789";
    db = await openDb({ path: ":memory:" });

    // Seed desk policy with gap = 0 for test determinism
    await db.prepare(`
      UPDATE desk_policy
      SET quiet_hours_enabled = 0, min_automated_gap_seconds = 0, min_same_lead_gap_seconds = 0
      WHERE id = 1
    `).run();

    app = await buildApp({ db, logLevel: "silent" });

    // Setup operator
    const setupRes = await setupAdmin(app, {
        bootstrapSecret: "secret-123456789",
        password: "supersecretpassword123",
        displayName: "Ada",
        timezone: "America/New_York",
        defaultCountry: "US",
      });
    sessionCookie = `leaddesk_session=${setupRes.cookies[0]!.value}`;

    // Register test extension device with sender lease
    const now = Date.now();
    await db.prepare(`
      INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at)
      VALUES (?, 'Chrome Auto Device', ?, ?, ?)
    `).run(deviceId, sha256(deviceToken), now, now);

    await db.prepare(`
      UPDATE sender_lease
      SET device_id = ?, lease_until = ?, grace_until = NULL
      WHERE id = 1
    `).run(deviceId, now + 60_000);

    // Create test lead with AI enabled
    leadId = generateUlid("led");
    await db.prepare(`
      INSERT INTO lead (id, display_name, stage_id, ai_enabled, require_approval, created_at, updated_at)
      VALUES (?, 'Auto Lead', 'stg_new', 1, 0, ?, ?)
    `).run(leadId, now, now);

    await db.prepare(`
      INSERT INTO phone_identity (id, lead_id, e164, wa_jid, is_primary, created_at)
      VALUES (?, ?, '+12125550188', '12125550188@c.us', 1, ?)
    `).run(generateUlid("phn"), leadId, now);

    // Set AI settings to mode: 'auto'
    const settingsRes = await app.inject({
      method: "PUT",
      url: "/api/v1/ai-settings",
      headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
      payload: {
        mode: "auto",
        apiKey: "xai-auto-test-key",
      },
    });
    expect(settingsRes.statusCode).toBe(200);
    expect(settingsRes.json().mode).toBe("auto");
  });

  afterEach(() => {
    setAiClientFactory(null);
    delete process.env["LEAD_DESK_AI_ENABLED"];
    delete process.env["XAI_API_KEY"];
    app.close();
  });

  it("inbound in auto mode automatically queues outbound row with status = 'queued'", async () => {
    setAiClientFactory(() => ({
      responses: {
        create: async () => ({
          output_text: "Thank you for reaching out! We are open until 6pm today.",
          usage: { reasoning_tokens: 20 },
        }),
      },
    }));

    const inboundRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        waMessageId: "msg_auto_inbound_01",
        chatJid: "12125550188@c.us",
        fromJid: "12125550188@c.us",
        toJid: "15550001111@c.us",
        fromMe: false,
        body: "What time do you close?",
        waTimestamp: new Date().toISOString(),
        chatKind: "direct",
      },
    });

    expect(inboundRes.statusCode).toBe(200);
    const data = inboundRes.json();
    expect(data.stored).toBe(true);
    expect(data.aiState).toBe("drafted");
    expect(data.outboundId).toBeTruthy();

    // Verify row in outbound_queue is 'queued' (ready for extension sender)
    const queueRow = await db
      .prepare("SELECT * FROM outbound_queue WHERE id = ?")
      .get(data.outboundId) as any;
    expect(queueRow.status).toBe("queued");
    expect(queueRow.kind).toBe("ai_reply");
    expect(queueRow.body).toBe("Thank you for reaching out! We are open until 6pm today.");

    // Claim the row from extension
    const claimRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/outbound/claim",
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    expect(claimRes.statusCode).toBe(200);
    const claimData = claimRes.json();
    expect(claimData.item).toBeTruthy();
    expect(claimData.item.outboundId).toBe(data.outboundId);
    expect(claimData.item.body).toBe("Thank you for reaching out! We are open until 6pm today.");
  });

  it("lead with require_approval: 1 forces status = 'needs_approval' even when global is auto", async () => {
    // Set lead require_approval = 1
    await db.prepare("UPDATE lead SET require_approval = 1 WHERE id = ?").run(leadId);

    setAiClientFactory(() => ({
      responses: {
        create: async () => ({
          output_text: "Let me check our schedule.",
          usage: { reasoning_tokens: 18 },
        }),
      },
    }));

    const inboundRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        waMessageId: "msg_auto_req_approval_01",
        chatJid: "12125550188@c.us",
        fromJid: "12125550188@c.us",
        toJid: "15550001111@c.us",
        fromMe: false,
        body: "Are you available tomorrow?",
        waTimestamp: new Date().toISOString(),
        chatKind: "direct",
      },
    });

    expect(inboundRes.statusCode).toBe(200);
    const data = inboundRes.json();
    expect(data.aiState).toBe("drafted");

    const queueRow = await db
      .prepare("SELECT * FROM outbound_queue WHERE id = ?")
      .get(data.outboundId) as any;
    expect(queueRow.status).toBe("needs_approval");
  });

  it("lead with ai_enabled: 0 skips model call with ai_reason = 'lead_opt_out'", async () => {
    await db.prepare("UPDATE lead SET ai_enabled = 0 WHERE id = ?").run(leadId);

    const inboundRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        waMessageId: "msg_auto_opt_out_01",
        chatJid: "12125550188@c.us",
        fromJid: "12125550188@c.us",
        toJid: "15550001111@c.us",
        fromMe: false,
        body: "Hello",
        waTimestamp: new Date().toISOString(),
        chatKind: "direct",
      },
    });

    expect(inboundRes.statusCode).toBe(200);
    const data = inboundRes.json();
    expect(data.aiState).toBe("skipped");
    expect(data.aiReason).toBe("lead_opt_out");
    expect(data.outboundId).toBeNull();
  });

  it("inbound during quiet hours is stored, skips AI with quiet_hours, and is NOT deferred to morning", async () => {
    // Enable quiet hours covering now
    await db.prepare(`
      UPDATE desk_policy
      SET quiet_hours_enabled = 1, quiet_start = '00:00', quiet_end = '23:59'
      WHERE id = 1
    `).run();

    const inboundRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        waMessageId: "msg_auto_quiet_01",
        chatJid: "12125550188@c.us",
        fromJid: "12125550188@c.us",
        toJid: "15550001111@c.us",
        fromMe: false,
        body: "Can I book for tomorrow?",
        waTimestamp: new Date().toISOString(),
        chatKind: "direct",
      },
    });

    expect(inboundRes.statusCode).toBe(200);
    const data = inboundRes.json();
    expect(data.stored).toBe(true);
    expect(data.aiState).toBe("skipped");
    expect(data.aiReason).toBe("quiet_hours");
    expect(data.outboundId).toBeNull();

    // Outbound queue has 0 rows (never deferred to morning)
    const count = (
      await db.prepare("SELECT COUNT(*) as count FROM outbound_queue").get() as any
    ).count;
    expect(count).toBe(0);
  });
});
