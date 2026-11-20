import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { sha256 } from "../src/auth.js";
import {
  isSpaceXsiHost,
  assertAllowedAiHost,
  encryptApiKey,
  decryptApiKey,
  seedApiKeyIfEmpty,
  sweepStaleAiPending,
  buildSystemPrompt,
  buildUserPrompt,
  completeReply,
  setAiClientFactory,
  HARD_RAILS,
} from "../src/ai.js";
import { resetProbeRateLimitForTesting } from "../src/routes/aiSettings.js";
import { generateUlid } from "@leaddesk/shared";
import { setupAdmin } from "./helpers.js";

describe("AI approve mode and SpaceXSI client (PR 12)", () => {
  let db: Awaited<ReturnType<typeof openDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sessionCookie: string;
  const deviceToken = "dev-ai-secret-123456";
  const deviceId = "dev_01J00000000000000000000001";

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
    expect(setupRes.statusCode).toBe(200);
    sessionCookie = `leaddesk_session=${setupRes.cookies[0]!.value}`;

    // Register test extension device
    await db.prepare(`
      INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at)
      VALUES (?, 'Chrome Test', ?, ?, ?)
    `).run(deviceId, sha256(deviceToken), Date.now(), Date.now());

    resetProbeRateLimitForTesting();
  });

  afterEach(() => {
    setAiClientFactory(null);
    delete process.env["LEAD_DESK_AI_ENABLED"];
    delete process.env["XAI_API_KEY"];
    delete process.env["LEAD_DESK_AI_EXTRA_HOSTS"];
    app.close();
  });

  describe("AES-256-GCM encryption and seeding", () => {
    it("encrypts and decrypts API key accurately", () => {
      const originalKey = "xai-test-key-1234567890abcdef";
      const enc = encryptApiKey(originalKey);
      expect(enc.last4).toBe("cdef");
      expect(enc.ciphertext).not.toBe(originalKey);
      expect(enc.nonce).toHaveLength(24); // 12 bytes hex

      const decrypted = decryptApiKey(enc.ciphertext, enc.nonce);
      expect(decrypted).toBe(originalKey);
    });

    it("seeds key from XAI_API_KEY only when ciphertext is null", async () => {
      process.env["XAI_API_KEY"] = "xai-seeded-env-key-9999";
      await seedApiKeyIfEmpty(db);

      const row = await db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() as any;
      expect(row.api_key_last4).toBe("9999");
      expect(row.api_key_ciphertext).toBeTruthy();

      const decrypted = decryptApiKey(row.api_key_ciphertext, row.api_key_nonce);
      expect(decrypted).toBe("xai-seeded-env-key-9999");

      // Now change env key and run again; should not overwrite
      process.env["XAI_API_KEY"] = "xai-new-key-1111";
      await seedApiKeyIfEmpty(db);
      const row2 = await db.prepare("SELECT * FROM ai_settings WHERE id = 1").get() as any;
      expect(row2.api_key_last4).toBe("9999");
    });
  });

  describe("Host validation and SpaceXSI detection", () => {
    it("identifies api.x.ai and us.api.x.ai as SpaceXSI hosts", () => {
      expect(isSpaceXsiHost("https://api.x.ai/v1")).toBe(true);
      expect(isSpaceXsiHost("https://us.api.x.ai/v1")).toBe(true);
      expect(isSpaceXsiHost("http://api.x.ai/v1")).toBe(false); // http rejected
      expect(isSpaceXsiHost("https://api.x.ai.evil.com/v1")).toBe(false);
      expect(isSpaceXsiHost("https://api.x.ai:8443/v1")).toBe(false); // non-standard port
    });

    it("assertAllowedAiHost blocks private, loopback, and metadata hosts", () => {
      expect(() => assertAllowedAiHost("http://127.0.0.1:8080")).toThrow();
      expect(() => assertAllowedAiHost("https://localhost")).toThrow();
      expect(() => assertAllowedAiHost("https://169.254.169.254")).toThrow();
      expect(() => assertAllowedAiHost("https://metadata.google.internal")).toThrow();
      expect(() => assertAllowedAiHost("https://10.0.0.1")).toThrow();
      expect(() => assertAllowedAiHost("https://192.168.1.1")).toThrow();
      expect(() => assertAllowedAiHost("https://unapproved.host.com")).toThrow();

      // SpaceXSI allowed by default
      expect(() => assertAllowedAiHost("https://api.x.ai/v1")).not.toThrow();

      // Extra hosts allowlist
      process.env["LEAD_DESK_AI_EXTRA_HOSTS"] = "api.groq.com, openrouter.ai";
      expect(() => assertAllowedAiHost("https://api.groq.com/openai/v1")).not.toThrow();
      expect(() => assertAllowedAiHost("https://openrouter.ai/api/v1")).not.toThrow();
    });
  });

  describe("Hard rails and prompt builder", () => {
    it("buildSystemPrompt appends HARD_RAILS verbatim", () => {
      const customInstructions = "You are a friendly scheduling assistant for a salon.";
      const prompt = buildSystemPrompt(customInstructions);

      expect(prompt).toContain(customInstructions);
      expect(prompt).toContain(HARD_RAILS);
      expect(prompt).toContain("LEAD_DESK_NO_REPLY");
    });

    it("buildUserPrompt respects 12-message history cap and character limits", () => {
      const messages = Array.from({ length: 20 }, (_, i) => ({
        from_me: i % 2 === 0 ? 1 : 0,
        body: `Message number ${i + 1}`,
      }));

      const prompt = buildUserPrompt({
        leadDisplayName: "Alice Smith",
        stageName: "New",
        notes: "Interested in dental cleaning.",
        historyMessages: messages,
        triggeringBody: "Can you do 3pm on Tuesday?",
      });

      expect(prompt).toContain("Lead name: Alice Smith");
      expect(prompt).toContain("Stage: New");
      expect(prompt).toContain("Interested in dental cleaning.");
      expect(prompt).toContain("Customer: Can you do 3pm on Tuesday?");

      // Should only include the last 12 older messages (messages 8 to 19, 1-indexed)
      expect(prompt).toContain("Message number 20");
      expect(prompt).not.toContain("Message number 1\n");
    });
  });

  describe("SpaceXSI payload shape and Responses API assertion", () => {
    it("calls responses.create with store: false, reasoning: { effort: 'low' }, and correct JSON", async () => {
      let responsesCalled = false;
      let completionsCalled = false;
      let recordedPayload: any = null;

      setAiClientFactory(() => ({
        responses: {
          create: async (payload: any) => {
            responsesCalled = true;
            recordedPayload = payload;
            return {
              output_text: "Hello! We would be happy to assist you.",
              usage: {
                output_tokens_details: {
                  reasoning_tokens: 42,
                },
              },
            };
          },
        },
        chat: {
          completions: {
            create: async () => {
              completionsCalled = true;
              return {};
            },
          },
        },
      }));

      const result = await completeReply(
        {
          providerBaseUrl: "https://api.x.ai/v1",
          model: "grok-4.7",
          maxCompletionTokens: 400,
          systemInstructions: "Be helpful.",
        },
        "xai-dummy-key",
        "Hi there",
        "led_123"
      );

      expect(responsesCalled).toBe(true);
      expect(completionsCalled).toBe(false);
      expect(result.text).toBe("Hello! We would be happy to assist you.");
      expect(result.reasoningTokens).toBe(42);

      expect(recordedPayload).toEqual({
        model: "grok-4.7",
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 400,
        prompt_cache_key: "lead:led_123",
        input: [
          { role: "system", content: buildSystemPrompt("Be helpful.") },
          { role: "user", content: "Hi there" },
        ],
      });
    });
  });

  describe("Settings routes: GET, PUT, and validation", () => {
    it("GET /api/v1/ai-settings returns sanitized settings without exposing raw key", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/ai-settings",
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data).toHaveProperty("mode");
      expect(data).toHaveProperty("systemInstructions");
      expect(data).toHaveProperty("providerBaseUrl", "https://api.x.ai/v1");
      expect(data).toHaveProperty("model", "grok-4.7");
      expect(data).toHaveProperty("maxCompletionTokens", 400);
      expect(data).toHaveProperty("apiKeySet", false);
      expect(data.apiKey).toBeUndefined();
    });

    it("PUT /api/v1/ai-settings rejects invalid mode with 400 validation error", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/ai-settings",
        headers: {
          cookie: sessionCookie,
          "x-leaddesk-client": "web",
        },
        payload: {
          mode: "invalid_mode",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation");
    });

    it("PUT /api/v1/ai-settings allows mode 'approve', rotates key, and validates token range", async () => {
      // Invalid max tokens
      const invalidRes = await app.inject({
        method: "PUT",
        url: "/api/v1/ai-settings",
        headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
        payload: { maxCompletionTokens: 1200 },
      });
      expect(invalidRes.statusCode).toBe(400);

      // Valid update
      const updateRes = await app.inject({
        method: "PUT",
        url: "/api/v1/ai-settings",
        headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
        payload: {
          mode: "approve",
          systemInstructions: "Provide clear answers.",
          apiKey: "xai-test-key-5555",
          maxCompletionTokens: 350,
        },
      });

      expect(updateRes.statusCode).toBe(200);
      const data = updateRes.json();
      expect(data.mode).toBe("approve");
      expect(data.systemInstructions).toBe("Provide clear answers.");
      expect(data.apiKeySet).toBe(true);
      expect(data.apiKeyLast4).toBe("5555");
      expect(data.maxCompletionTokens).toBe(350);
    });
  });

  describe("Probe endpoint: POST /api/v1/ai-settings/probe", () => {
    beforeEach(async () => {
      // Set valid key
      await app.inject({
        method: "PUT",
        url: "/api/v1/ai-settings",
        headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
        payload: { apiKey: "xai-test-probe-key-1111" },
      });
    });

    it("succeeds when SpaceXSI reports numeric reasoning tokens", async () => {
      setAiClientFactory(() => ({
        responses: {
          create: async () => ({
            output_text: "pong",
            usage: {
              reasoning_tokens: 15,
            },
          }),
        },
      }));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/ai-settings/probe",
        headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.ok).toBe(true);
      expect(data.model).toBe("grok-4.7");
      expect(typeof data.ms).toBe("number");
    });

    it("fails with 502 reasoning_not_reported if SpaceXSI omits reasoning tokens", async () => {
      setAiClientFactory(() => ({
        responses: {
          create: async () => ({
            output_text: "pong",
            usage: {}, // missing reasoning tokens
          }),
        },
      }));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/ai-settings/probe",
        headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
        payload: {},
      });

      expect(res.statusCode).toBe(502);
      const data = res.json();
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe("reasoning_not_reported");
    });

    it("enforces probe rate limit of 5 per hour", async () => {
      setAiClientFactory(() => ({
        responses: {
          create: async () => ({
            output_text: "pong",
            usage: { reasoning_tokens: 10 },
          }),
        },
      }));

      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/ai-settings/probe",
          headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
          payload: {},
        });
        expect(res.statusCode).toBe(200);
      }

      // 6th probe call gets rate limited
      const limitedRes = await app.inject({
        method: "POST",
        url: "/api/v1/ai-settings/probe",
        headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
        payload: {},
      });
      expect(limitedRes.statusCode).toBe(429);
      expect(limitedRes.json().error.code).toBe("rate_limited");
    });
  });

  describe("Inbound AI dispatch in Approve mode", () => {
    let leadId: string;

    beforeEach(async () => {
      leadId = generateUlid("led");
      await db.prepare(`
        INSERT INTO lead (id, display_name, stage_id, ai_enabled, require_approval, created_at, updated_at)
        VALUES (?, 'John Doe', 'stg_new', 1, 0, ?, ?)
      `).run(leadId, Date.now(), Date.now());

      await db.prepare(`
        INSERT INTO phone_identity (id, lead_id, e164, wa_jid, is_primary, created_at)
        VALUES (?, ?, '+12125550199', '12125550199@c.us', 1, ?)
      `).run(generateUlid("phn"), leadId, Date.now());

      // Enable approve mode with key
      await app.inject({
        method: "PUT",
        url: "/api/v1/ai-settings",
        headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
        payload: {
          mode: "approve",
          apiKey: "xai-valid-key-1234",
        },
      });
    });

    it("creates needs_approval row and sets ai_state = 'drafted' on valid response", async () => {
      setAiClientFactory(() => ({
        responses: {
          create: async () => ({
            output_text: "Hi John, yes we have openings this Thursday at 2pm.",
            usage: { reasoning_tokens: 25 },
          }),
        },
      }));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/extension/inbound",
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          waMessageId: "msg_inbound_valid_01",
          chatJid: "12125550199@c.us",
          fromJid: "12125550199@c.us",
          toJid: "15550001111@c.us",
          fromMe: false,
          body: "Are you free this week?",
          waTimestamp: new Date().toISOString(),
          chatKind: "direct",
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.stored).toBe(true);
      expect(data.aiState).toBe("drafted");
      expect(data.outboundId).toBeTruthy();

      // Check outbound queue row
      const queueRow = await db
        .prepare("SELECT * FROM outbound_queue WHERE id = ?")
        .get(data.outboundId) as any;
      expect(queueRow.status).toBe("needs_approval");
      expect(queueRow.kind).toBe("ai_reply");
      expect(queueRow.body).toBe("Hi John, yes we have openings this Thursday at 2pm.");

      // Check hourly counter incremented
      const hourUtc = new Date().toISOString().slice(0, 13);
      const counterRow = await db
        .prepare("SELECT count FROM ai_hourly_counter WHERE hour_utc = ?")
        .get(hourUtc) as any;
      expect(counterRow.count).toBe(1);
    });

    it("marks skipped / model_declined when model returns LEAD_DESK_NO_REPLY", async () => {
      setAiClientFactory(() => ({
        responses: {
          create: async () => ({
            output_text: "LEAD_DESK_NO_REPLY",
            usage: { reasoning_tokens: 12 },
          }),
        },
      }));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/extension/inbound",
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          waMessageId: "msg_inbound_declined_01",
          chatJid: "12125550199@c.us",
          fromJid: "12125550199@c.us",
          toJid: "15550001111@c.us",
          fromMe: false,
          body: "What is your secret recipe?",
          waTimestamp: new Date().toISOString(),
          chatKind: "direct",
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.aiState).toBe("skipped");
      expect(data.aiReason).toBe("model_declined");
      expect(data.outboundId).toBeNull();

      const queueCount = (
        await db.prepare("SELECT COUNT(*) as count FROM outbound_queue").get() as any
      ).count;
      expect(queueCount).toBe(0);
    });

    it("marks failed / ai_timeout when model call times out", async () => {
      setAiClientFactory(() => ({
        responses: {
          create: async () => {
            const timeoutError = new Error("The operation was aborted due to timeout");
            timeoutError.name = "TimeoutError";
            throw timeoutError;
          },
        },
      }));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/extension/inbound",
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          waMessageId: "msg_inbound_timeout_01",
          chatJid: "12125550199@c.us",
          fromJid: "12125550199@c.us",
          toJid: "15550001111@c.us",
          fromMe: false,
          body: "Hello?",
          waTimestamp: new Date().toISOString(),
          chatKind: "direct",
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.aiState).toBe("failed");
      expect(data.aiReason).toBe("ai_timeout");
      expect(data.outboundId).toBeNull();
    });

    it("skips model call during quiet hours with ai_reason = 'quiet_hours'", async () => {
      // Enable quiet hours 00:00 to 23:59 (covering all day)
      await db.prepare(`
        UPDATE desk_policy
        SET quiet_hours_enabled = 1, quiet_start = '00:00', quiet_end = '23:59'
        WHERE id = 1
      `).run();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/extension/inbound",
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          waMessageId: "msg_inbound_quiet_01",
          chatJid: "12125550199@c.us",
          fromJid: "12125550199@c.us",
          toJid: "15550001111@c.us",
          fromMe: false,
          body: "Are you open late?",
          waTimestamp: new Date().toISOString(),
          chatKind: "direct",
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.aiState).toBe("skipped");
      expect(data.aiReason).toBe("quiet_hours");
    });
  });

  describe("Approving drafts and quiet hours guardrail", () => {
    let dummyLeadId: string;

    beforeEach(async () => {
      dummyLeadId = generateUlid("led");
      await db.prepare(`
        INSERT INTO lead (id, display_name, stage_id, ai_enabled, require_approval, created_at, updated_at)
        VALUES (?, 'Test Lead', 'stg_new', 1, 0, ?, ?)
      `).run(dummyLeadId, Date.now(), Date.now());
    });

    it("refuses approval during quiet hours with 409 quiet_hours", async () => {
      const outId = generateUlid("out");
      await db.prepare(`
        INSERT INTO outbound_queue (
          id, lead_id, to_e164, body, kind, status, earliest_due_at, due_at,
          idempotency_key, allow_during_quiet_hours, created_at
        ) VALUES (?, ?, '+12125550199', 'Draft reply', 'ai_reply', 'needs_approval', ?, ?, 'ai:dummy', 0, ?)
      `).run(outId, dummyLeadId, Date.now(), Date.now(), Date.now());

      // Enable quiet hours covering now
      await db.prepare(`
        UPDATE desk_policy
        SET quiet_hours_enabled = 1, quiet_start = '00:00', quiet_end = '23:59'
        WHERE id = 1
      `).run();

      const approveRes = await app.inject({
        method: "POST",
        url: `/api/v1/outbound/${outId}/approve`,
        headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
        payload: {},
      });

      expect(approveRes.statusCode).toBe(409);
      expect(approveRes.json().error.code).toBe("quiet_hours");

      // Row status remains needs_approval
      const row = await db.prepare("SELECT status FROM outbound_queue WHERE id = ?").get(outId) as any;
      expect(row.status).toBe("needs_approval");
    });

    it("approves draft outside quiet hours setting status = queued and due_at = now", async () => {
      const outId = generateUlid("out");
      await db.prepare(`
        INSERT INTO outbound_queue (
          id, lead_id, to_e164, body, kind, status, earliest_due_at, due_at,
          idempotency_key, allow_during_quiet_hours, created_at
        ) VALUES (?, ?, '+12125550199', 'Draft reply', 'ai_reply', 'needs_approval', ?, ?, 'ai:dummy2', 0, ?)
      `).run(outId, dummyLeadId, Date.now(), Date.now(), Date.now());

      // Quiet hours disabled
      await db.prepare("UPDATE desk_policy SET quiet_hours_enabled = 0 WHERE id = 1").run();

      const approveRes = await app.inject({
        method: "POST",
        url: `/api/v1/outbound/${outId}/approve`,
        headers: { cookie: sessionCookie, "x-leaddesk-client": "web" },
        payload: { body: "Customized approved reply" },
      });

      expect(approveRes.statusCode).toBe(200);
      const row = await db.prepare("SELECT * FROM outbound_queue WHERE id = ?").get(outId) as any;
      expect(row.status).toBe("queued");
      expect(row.body).toBe("Customized approved reply");
    });
  });

  describe("sweepStaleAiPending cleanup", () => {
    it("sweeps pending rows older than 30 seconds to failed / ai_timeout", async () => {
      const dummyLeadId = generateUlid("led");
      await db.prepare(`
        INSERT INTO lead (id, display_name, stage_id, ai_enabled, require_approval, created_at, updated_at)
        VALUES (?, 'Test Lead', 'stg_new', 1, 0, ?, ?)
      `).run(dummyLeadId, Date.now(), Date.now());

      const oldTime = Date.now() - 40_000;
      const recentTime = Date.now() - 5_000;

      await db.prepare(`
        INSERT INTO message_log (id, lead_id, direction, wa_message_id, body, from_jid, to_jid, from_me, wa_timestamp, ai_state, created_at)
        VALUES
          ('msg_old', ?, 'inbound', 'wa_old', 'Old message', 'a@c.us', 'b@c.us', 0, ?, 'pending', ?),
          ('msg_recent', ?, 'inbound', 'wa_rec', 'Recent message', 'a@c.us', 'b@c.us', 0, ?, 'pending', ?)
      `).run(dummyLeadId, oldTime, oldTime, dummyLeadId, recentTime, recentTime);

      const swept = await sweepStaleAiPending(db);
      expect(swept).toBe(1);

      const oldRow = await db.prepare("SELECT ai_state, ai_reason FROM message_log WHERE id = 'msg_old'").get() as any;
      expect(oldRow.ai_state).toBe("failed");
      expect(oldRow.ai_reason).toBe("ai_timeout");

      const recentRow = await db.prepare("SELECT ai_state FROM message_log WHERE id = 'msg_recent'").get() as any;
      expect(recentRow.ai_state).toBe("pending");
    });
  });
});
