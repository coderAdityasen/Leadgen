import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { sha256 } from "../src/auth.js";
import { toInboundWire, type InboundObserved } from "@leaddesk/shared";
import type { Db } from "../src/db.js";
import type { FastifyInstance } from "fastify";
import { setupAdmin } from "./helpers.js";

describe("Inbound capture and message log (PR 11)", () => {
  let app: FastifyInstance;
  let db: Db;
  let operatorCookie: string;
  let operatorHeaders: Record<string, string>;
  const deviceToken = "dev-inbound-secret-123456";
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

    // Get default stage
    const stageRes = await app.inject({
      method: "GET",
      url: "/api/v1/stages",
      headers: { cookie: operatorCookie },
    });
    stageId = JSON.parse(stageRes.body).items[0].id;

    // Create a known test lead with LID and valid E.164 phone (+12125550123)
    const leadRes = await app.inject({
      method: "POST",
      url: "/api/v1/leads",
      headers: operatorHeaders,
      payload: {
        displayName: "Bob Stone",
        phoneE164: "+12125550123",
        stageId,
      },
    });
    expect(leadRes.statusCode).toBe(201);
    leadId = JSON.parse(leadRes.body).id;

    // Attach LID to primary phone
    await db.prepare(`
      UPDATE phone_identity
      SET wa_lid = '12345@lid', wa_jid = '12125550123@c.us'
      WHERE lead_id = ? AND is_primary = 1
    `).run(leadId);

    // Seed paired extension device
    const now = Date.now();
    await db.prepare(`
      INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at, authenticated)
      VALUES (?, 'Device Inbound', ?, ?, ?, 1)
    `).run(deviceId, sha256(deviceToken), now, now);

    // Give device sender lease
    await db.prepare(`
      UPDATE sender_lease
      SET device_id = ?, lease_until = ?, grace_until = NULL
      WHERE id = 1
    `).run(deviceId, now + 3600_000);
  });

  afterEach(async () => {
    await app.close();
  });

  it("1. toInboundWire pure helper correctly transforms InboundObserved", () => {
    const observed: InboundObserved = {
      waMessageId: "msg_wa_01",
      chatJid: "12125550123@s.whatsapp.net",
      senderJid: "12125550123@c.us",
      senderLid: "12345@lid",
      senderPhoneUser: "12125550123",
      fromMe: false,
      body: "Are you free Friday?",
      waTimestampMs: 1793434500000,
      chatKind: "direct",
    };

    const wire = toInboundWire(observed, "operator@c.us");
    expect(wire.waMessageId).toBe("msg_wa_01");
    expect(wire.chatJid).toBe("12125550123@s.whatsapp.net");
    expect(wire.fromMe).toBe(false);
    expect(wire.fromJid).toBe("12125550123@c.us");
    expect(wire.toJid).toBe("operator@c.us");
    expect(wire.waTimestamp).toBe(new Date(1793434500000).toISOString());

    // fromMe: true swaps fromJid and toJid
    const observedFromMe: InboundObserved = {
      ...observed,
      fromMe: true,
      body: "Yes, 2pm works.",
    };
    const wireFromMe = toInboundWire(observedFromMe, "operator@c.us");
    expect(wireFromMe.fromMe).toBe(true);
    expect(wireFromMe.fromJid).toBe("operator@c.us");
    expect(wireFromMe.toJid).toBe("12125550123@s.whatsapp.net");
  });

  it("2. Inbound direct message matches known lead by LID, stores message_log, updates last_inbound_at", async () => {
    const now = Date.now();
    const inboundPayload = {
      waMessageId: "false_12125550123@c.us_AAA",
      chatJid: "12345@lid",
      senderJid: "12125550123@c.us",
      senderLid: "12345@lid",
      senderPhoneUser: "12125550123",
      fromMe: false,
      body: "Hello, I am interested in your service.",
      waTimestamp: new Date(now - 1000).toISOString(),
      chatKind: "direct",
      fromJid: "12125550123@c.us",
      toJid: "operator@c.us",
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: inboundPayload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.stored).toBe(true);
    expect(body.duplicate).toBe(false);
    expect(body.leadId).toBe(leadId);
    expect(body.aiState).toBe("skipped");
    expect(body.aiReason).toBe("global_off");

    // Verify DB message_log row
    const logRow = await db.prepare("SELECT * FROM message_log WHERE wa_message_id = ?").get("false_12125550123@c.us_AAA") as any;
    expect(logRow).toBeDefined();
    expect(logRow.lead_id).toBe(leadId);
    expect(logRow.direction).toBe("inbound");
    expect(logRow.body).toBe("Hello, I am interested in your service.");
    expect(logRow.from_me).toBe(0);

    // Verify lead.last_inbound_at updated
    const leadRow = await db.prepare("SELECT last_inbound_at FROM lead WHERE id = ?").get(leadId) as any;
    expect(leadRow.last_inbound_at).toBeGreaterThan(0);
  });

  it("3. Inbound from unknown number creates a new lead with aiEnabled=false", async () => {
    const now = Date.now();
    const inboundPayload = {
      waMessageId: "false_12025550199@c.us_NEW_MSG",
      chatJid: "12025550199@c.us",
      senderJid: "12025550199@c.us",
      senderLid: null,
      senderPhoneUser: "12025550199",
      fromMe: false,
      body: "Hi there, is this Lead Desk?",
      waTimestamp: new Date(now - 2000).toISOString(),
      chatKind: "direct",
      fromJid: "12025550199@c.us",
      toJid: "operator@c.us",
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: inboundPayload,
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.stored).toBe(true);
    expect(data.leadId).toMatch(/^led_/);

    // Check created lead properties
    const newLead = await db.prepare("SELECT * FROM lead WHERE id = ?").get(data.leadId) as any;
    expect(newLead).toBeDefined();
    expect(newLead.display_name).toBe("+12025550199");
    expect(newLead.ai_enabled).toBe(0); // Ships with aiEnabled: false

    // Check phone_identity
    const phone = await db.prepare("SELECT * FROM phone_identity WHERE lead_id = ?").get(data.leadId) as any;
    expect(phone.e164).toBe("+12025550199");
    expect(phone.is_primary).toBe(1);
  });

  it("4. fromMe: true is stored as direction outbound with ai_state null", async () => {
    const now = Date.now();
    const fromMePayload = {
      waMessageId: "true_12125550123@c.us_MY_REPLY",
      chatJid: "12125550123@c.us",
      senderJid: null,
      senderLid: null,
      senderPhoneUser: null,
      fromMe: true,
      body: "I am replying directly from my phone.",
      waTimestamp: new Date(now - 1000).toISOString(),
      chatKind: "direct",
      fromJid: "operator@c.us",
      toJid: "12125550123@c.us",
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: fromMePayload,
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.stored).toBe(true);
    expect(data.aiState).toBeNull();
    expect(data.leadId).toBe(leadId);

    // DB verify
    const row = await db.prepare("SELECT * FROM message_log WHERE wa_message_id = ?").get("true_12125550123@c.us_MY_REPLY") as any;
    expect(row.direction).toBe("outbound");
    expect(row.from_me).toBe(1);
    expect(row.ai_state).toBeNull();
  });

  it("5. Deduplication: duplicate wa_message_id returns stored: true, duplicate: true", async () => {
    const now = Date.now();
    const payload = {
      waMessageId: "dup_msg_test_001",
      chatJid: "12125550123@c.us",
      senderJid: "12125550123@c.us",
      senderLid: null,
      senderPhoneUser: "12125550123",
      fromMe: false,
      body: "First attempt",
      waTimestamp: new Date(now - 1000).toISOString(),
      chatKind: "direct",
      fromJid: "12125550123@c.us",
      toJid: "operator@c.us",
    };

    // First POST
    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload,
    });
    expect(res1.statusCode).toBe(200);
    expect(JSON.parse(res1.body).duplicate).toBe(false);

    // Replay POST
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload,
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.stored).toBe(true);
    expect(body2.duplicate).toBe(true);
    expect(body2.messageId).toBe(JSON.parse(res1.body).messageId);

    // Count in DB remains 1
    const count = await db.prepare("SELECT COUNT(*) as c FROM message_log WHERE wa_message_id = 'dup_msg_test_001'").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("6. Rejects non-direct chatKind and stale messages (>120s old)", async () => {
    const now = Date.now();

    // Group chat message -> stored: false, reason: "not_direct"
    const groupRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        waMessageId: "grp_123",
        chatJid: "123456789@g.us",
        fromMe: false,
        body: "Group text",
        waTimestamp: new Date(now).toISOString(),
        chatKind: "group",
        fromJid: "12125550123@c.us",
        toJid: "123456789@g.us",
      },
    });
    expect(groupRes.statusCode).toBe(200);
    expect(JSON.parse(groupRes.body)).toEqual({ stored: false, reason: "not_direct" });

    // Stale message (150 seconds old) -> stored: false, reason: "stale"
    const staleRes = await app.inject({
      method: "POST",
      url: "/api/v1/extension/inbound",
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        waMessageId: "stale_123",
        chatJid: "12125550123@c.us",
        fromMe: false,
        body: "Old text",
        waTimestamp: new Date(now - 150_000).toISOString(),
        chatKind: "direct",
        fromJid: "12125550123@c.us",
        toJid: "operator@c.us",
      },
    });
    expect(staleRes.statusCode).toBe(200);
    expect(JSON.parse(staleRes.body)).toEqual({ stored: false, reason: "stale" });
  });

  it("7. GET /api/v1/messages lists messages with filtering by leadId", async () => {
    const now = Date.now();

    // Create a second lead
    const lead2Res = await app.inject({
      method: "POST",
      url: "/api/v1/leads",
      headers: operatorHeaders,
      payload: {
        displayName: "Carol Danvers",
        phoneE164: "+12025550188",
        stageId,
      },
    });
    const lead2Id = JSON.parse(lead2Res.body).id;

    // Insert 2 messages for leadId and 1 message for lead2Id
    await db.prepare(`
      INSERT INTO message_log (id, lead_id, direction, wa_message_id, body, from_jid, to_jid, from_me, wa_timestamp, created_at)
      VALUES ('msg_test_1', ?, 'inbound', 'wa_m_1', 'Inbound text 1', 'f1', 't1', 0, ?, ?)
    `).run(leadId, now - 5000, now - 5000);

    await db.prepare(`
      INSERT INTO message_log (id, lead_id, direction, wa_message_id, body, from_jid, to_jid, from_me, wa_timestamp, created_at)
      VALUES ('msg_test_2', ?, 'outbound', 'wa_m_2', 'Outbound text 2', 't1', 'f1', 1, ?, ?)
    `).run(leadId, now - 2000, now - 2000);

    await db.prepare(`
      INSERT INTO message_log (id, lead_id, direction, wa_message_id, body, from_jid, to_jid, from_me, wa_timestamp, created_at)
      VALUES ('msg_test_3', ?, 'inbound', 'wa_m_3', 'Other lead text', 'f3', 't3', 0, ?, ?)
    `).run(lead2Id, now - 1000, now - 1000);

    // List all
    const allRes = await app.inject({
      method: "GET",
      url: "/api/v1/messages",
      headers: { cookie: operatorCookie },
    });
    expect(allRes.statusCode).toBe(200);
    expect(JSON.parse(allRes.body).items).toHaveLength(3);

    // Filter by leadId
    const filteredRes = await app.inject({
      method: "GET",
      url: `/api/v1/messages?leadId=${leadId}`,
      headers: { cookie: operatorCookie },
    });
    expect(filteredRes.statusCode).toBe(200);
    const filteredItems = JSON.parse(filteredRes.body).items;
    expect(filteredItems).toHaveLength(2);
    expect(filteredItems[0].leadId).toBe(leadId);
    expect(filteredItems[1].leadId).toBe(leadId);
  });
});
