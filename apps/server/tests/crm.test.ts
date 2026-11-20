import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { sha256 } from "../src/auth.js";
import type { Db } from "../src/db.js";
import type { FastifyInstance } from "fastify";
import { setupAdmin } from "./helpers.js";

describe("CRM board and WhatsApp side-panel API", () => {
  let app: FastifyInstance;
  let db: Db;
  let headers: Record<string, string>;
  const deviceToken = "dev-token-crm-123456";
  const dev = { authorization: `Bearer ${deviceToken}` };

  beforeEach(async () => {
    process.env["LEAD_DESK_BOOTSTRAP_SECRET"] = "secret-123456789";
    db = await openDb({ path: ":memory:" });
    app = await buildApp({ db, logLevel: "silent" });
    const setup = await setupAdmin(app, {
        bootstrapSecret: "secret-123456789",
        password: "supersecretpassword123",
        displayName: "Ada",
        timezone: "UTC",
        defaultCountry: "IN",
      });
    headers = { cookie: `leaddesk_session=${setup.cookies[0]!.value}`, "x-leaddesk-client": "web" };
    const now = Date.now();
    await db.prepare(`
      INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at, authenticated)
      VALUES ('dev_01J00000000000000000000CRM', 'Dev', ?, ?, ?, 1)
    `).run(sha256(deviceToken), now, now);
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns stage counts and enriched lead cards on the board", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/leads",
      headers,
      payload: { displayName: "Sneha Singh", phoneE164: "+919319988593", email: "sneha@example.com", company: "A1 Traders" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().email).toBe("sneha@example.com");

    const board = (await app.inject({ method: "GET", url: "/api/v1/leads/board", headers })).json();
    const first = board.stages[0];
    expect(first.count).toBe(1);
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toMatchObject({
      displayName: "Sneha Singh",
      company: "A1 Traders",
      primaryPhone: "+919319988593",
      enrollment: null,
      nextMessage: null,
    });

    const search = (await app.inject({ method: "GET", url: "/api/v1/leads/board?q=a1%20trad", headers })).json();
    expect(search.items).toHaveLength(1);
    const digits = (await app.inject({ method: "GET", url: "/api/v1/leads/board?q=93199", headers })).json();
    expect(digits.items).toHaveLength(1);
  });

  it("stamps stageChangedAt only when the stage changes, and validates email", async () => {
    const lead = (
      await app.inject({ method: "POST", url: "/api/v1/leads", headers, payload: { displayName: "A" } })
    ).json();
    const stages = (await app.inject({ method: "GET", url: "/api/v1/stages", headers })).json().items;
    await db.prepare("UPDATE lead SET stage_changed_at = 1000 WHERE id = ?").run(lead.id);

    const notesOnly = await app.inject({ method: "PATCH", url: `/api/v1/leads/${lead.id}`, headers, payload: { notes: "x" } });
    expect(notesOnly.json().stageChangedAt).toBe(new Date(1000).toISOString());

    const moved = await app.inject({
      method: "PATCH",
      url: `/api/v1/leads/${lead.id}`,
      headers,
      payload: { stageId: stages[1].id },
    });
    expect(new Date(moved.json().stageChangedAt).getTime()).toBeGreaterThan(1000);

    const bad = await app.inject({ method: "PATCH", url: `/api/v1/leads/${lead.id}`, headers, payload: { email: "nope" } });
    expect(bad.statusCode).toBe(400);
  });

  it("lets the WhatsApp panel look up, create, update and enroll a lead for a chat", async () => {
    const chat = "919910595744@c.us";
    const none = (await app.inject({ method: "GET", url: `/api/v1/extension/crm/contact?chatJid=${chat}`, headers: dev })).json();
    expect(none.lead).toBeNull();
    expect(none.stages.length).toBeGreaterThan(0);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/extension/crm/leads",
      headers: dev,
      payload: { chatJid: chat, displayName: "Mayank Kamra" },
    });
    expect(created.statusCode).toBe(201);
    const lead = created.json().lead;
    expect(lead).toMatchObject({ displayName: "Mayank Kamra", primaryPhone: "+919910595744", waJid: chat });

    const dup = await app.inject({ method: "POST", url: "/api/v1/extension/crm/leads", headers: dev, payload: { chatJid: chat } });
    expect(dup.statusCode).toBe(409);

    const found = (await app.inject({ method: "GET", url: `/api/v1/extension/crm/contact?chatJid=${chat}`, headers: dev })).json();
    expect(found.lead.id).toBe(lead.id);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/extension/crm/leads/${lead.id}`,
      headers: dev,
      payload: { aiEnabled: true, notes: "Wants a price list" },
    });
    expect(patched.json().lead).toMatchObject({ aiEnabled: true, notes: "Wants a price list" });

    const seq = (await app.inject({ method: "POST", url: "/api/v1/sequences", headers, payload: { name: "Nurture" } })).json();
    await app.inject({
      method: "PUT",
      url: `/api/v1/sequences/${seq.id}/steps`,
      headers,
      payload: { steps: [{ delaySeconds: 3600, body: "Hi {{display_name}}" }] },
    });
    const enrolled = await app.inject({
      method: "POST",
      url: `/api/v1/extension/crm/leads/${lead.id}/enroll`,
      headers: dev,
      payload: { sequenceId: seq.id },
    });
    expect(enrolled.statusCode).toBe(201);
    expect(enrolled.json().lead.enrollment).toMatchObject({ sequenceName: "Nurture", stepNumber: 1, totalSteps: 1 });
    expect(enrolled.json().lead.nextMessage.body).toBe("Hi Mayank Kamra");

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/extension/crm/leads/${lead.id}/enrollment/cancel`,
      headers: dev,
    });
    expect(cancelled.json().lead.enrollment).toBeNull();
  });

  it("rejects group chats and unauthenticated callers", async () => {
    const group = await app.inject({
      method: "POST",
      url: "/api/v1/extension/crm/leads",
      headers: dev,
      payload: { chatJid: "12036302@g.us", phoneUser: "15550001111" },
    });
    expect(group.statusCode).toBe(400);
    const anon = await app.inject({ method: "GET", url: "/api/v1/extension/crm/board" });
    expect(anon.statusCode).toBe(401);
  });
});
