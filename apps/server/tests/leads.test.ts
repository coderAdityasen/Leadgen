import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import type { Db } from "../src/db.js";
import type { FastifyInstance } from "fastify";
import { setupAdmin } from "./helpers.js";

describe("Leads, phones, stages, and quick replies (PR 4)", () => {
  let app: FastifyInstance;
  let db: Db;
  let cookieHeader: string;

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
    cookieHeader = `leaddesk_session=${setupRes.cookies[0]!.value}`;
  });

  afterEach(async () => {
    await app.close();
  });

  describe("Phone normalization", () => {
    it("handles E.164 directly, national numbers with defaultCountry, and rejects extensions", async () => {
      // 1. Direct E.164
      const res1 = await app.inject({
        method: "POST",
        url: "/api/v1/leads",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: { displayName: "Lead 1", phoneE164: "+12125551234" },
      });
      expect(res1.statusCode).toBe(201);
      expect(res1.json().phones[0].e164).toBe("+12125551234");

      // 2. National format without + uses operator defaultCountry "US"
      const res2 = await app.inject({
        method: "POST",
        url: "/api/v1/leads",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: { displayName: "Lead 2", phoneE164: "2025550143" },
      });
      expect(res2.statusCode).toBe(201);
      expect(res2.json().phones[0].e164).toBe("+12025550143");

      // 3. Extension is rejected
      const resExt = await app.inject({
        method: "POST",
        url: "/api/v1/leads",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: { displayName: "Lead Ext", phoneE164: "+12125551234 ext 123" },
      });
      expect(resExt.statusCode).toBe(400);
      expect(resExt.json().error.code).toBe("validation");

      // 4. Duplicate phone across leads rejected with 409
      const resDup = await app.inject({
        method: "POST",
        url: "/api/v1/leads",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: { displayName: "Lead Dup", phoneE164: "+12125551234" },
      });
      expect(resDup.statusCode).toBe(409);
      expect(resDup.json().error.code).toBe("conflict");
    });
  });

  describe("Leads CRUD and archive", () => {
    it("creates, reads, lists, patches, and archives leads", async () => {
      // Create
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/leads",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: {
          displayName: "Bob Smith",
          notes: "Initial contact",
          phoneE164: "+14155552671",
        },
      });
      expect(createRes.statusCode).toBe(201);
      const leadId = createRes.json().id;

      // Read
      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/leads/${leadId}`,
        headers: { cookie: cookieHeader },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().displayName).toBe("Bob Smith");
      expect(getRes.json().phones.length).toBe(1);

      // List
      const listRes = await app.inject({
        method: "GET",
        url: "/api/v1/leads",
        headers: { cookie: cookieHeader },
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().items.length).toBe(1);
      expect(listRes.json().items[0].displayName).toBe("Bob Smith");

      // Patch: toggle doNotMessage
      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/leads/${leadId}`,
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: { doNotMessage: true },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().doNotMessage).toBe(true);

      // Archive
      const archiveRes = await app.inject({
        method: "POST",
        url: `/api/v1/leads/${leadId}/archive`,
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
      });
      expect(archiveRes.statusCode).toBe(200);
      expect(archiveRes.json().archivedAt).not.toBeNull();

      // List without archived should be empty
      const listAfter = await app.inject({
        method: "GET",
        url: "/api/v1/leads",
        headers: { cookie: cookieHeader },
      });
      expect(listAfter.json().items.length).toBe(0);

      // List with includeArchived=true has it
      const listArchived = await app.inject({
        method: "GET",
        url: "/api/v1/leads?includeArchived=true",
        headers: { cookie: cookieHeader },
      });
      expect(listArchived.json().items.length).toBe(1);
    });
  });

  describe("Stages CRUD and reorder", () => {
    it("manages stages and updates order", async () => {
      // List default 5 stages
      const stagesRes = await app.inject({
        method: "GET",
        url: "/api/v1/stages",
        headers: { cookie: cookieHeader },
      });
      expect(stagesRes.statusCode).toBe(200);
      const items = stagesRes.json().items;
      expect(items.length).toBe(5);

      // Add a stage
      const addRes = await app.inject({
        method: "POST",
        url: "/api/v1/stages",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: { name: "Negotiation" },
      });
      expect(addRes.statusCode).toBe(201);
      expect(addRes.json().position).toBe(5);

      // Reorder
      const allIds = [...items.map((s: { id: string }) => s.id), addRes.json().id];
      const reversedIds = [...allIds].reverse();
      const orderRes = await app.inject({
        method: "PUT",
        url: "/api/v1/stages/order",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: { ids: reversedIds },
      });
      expect(orderRes.statusCode).toBe(200);
      expect(orderRes.json().items[0].id).toBe(reversedIds[0]);
    });
  });

  describe("Quick replies", () => {
    it("validates {{display_name}} placeholder and manages quick replies", async () => {
      // Valid placeholder
      const validRes = await app.inject({
        method: "POST",
        url: "/api/v1/quick-replies",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: { title: "Hello", body: "Hi {{display_name}}, how are you?" },
      });
      expect(validRes.statusCode).toBe(201);

      // Invalid placeholder rejected
      const invalidRes = await app.inject({
        method: "POST",
        url: "/api/v1/quick-replies",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: { title: "Bad", body: "Hi {{first_name}}" },
      });
      expect(invalidRes.statusCode).toBe(400);
      expect(invalidRes.json().error.code).toBe("validation");

      // Delete
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/quick-replies/${validRes.json().id}`,
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
      });
      expect(delRes.statusCode).toBe(204);
    });
  });
});
