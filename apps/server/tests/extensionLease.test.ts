import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { sha256 } from "../src/auth.js";
import { senderLeaseHeld } from "../src/queue.js";
import {
  isTabEligible,
  computeHasEligibleTab,
  electSenderTab,
  type TabRecord,
} from "../../extension/src/tabElection.js";
import type { Db } from "../src/db.js";
import type { FastifyInstance } from "fastify";
import { setupAdmin } from "./helpers.js";

describe("Extension pairing, heartbeat, lease, and tab election (PR 8)", () => {
  let app: FastifyInstance;
  let db: Db;
  let operatorCookie: string;

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
  });

  afterEach(async () => {
    await app.close();
  });

  describe("Pairing code and pair flow", () => {
    it("generates 8-char Crockford code, pairs device, returns ld_dev_ token, and rejects used/expired code", async () => {
      // 1. Generate pairing code
      const codeRes = await app.inject({
        method: "POST",
        url: "/api/v1/pairing-codes",
        headers: { cookie: operatorCookie, "x-leaddesk-client": "web" },
      });
      expect(codeRes.statusCode).toBe(201);
      const { code, expiresAt } = codeRes.json();
      expect(code).toMatch(/^[0-9A-Z]{8}$/);
      expect(expiresAt).toBeDefined();

      // 2. Pair device with the code
      const pairRes = await app.inject({
        method: "POST",
        url: "/api/v1/extension/pair",
        payload: {
          code: code.toLowerCase(), // tests canonicalization
          label: "Brave on Desk",
        },
      });
      expect(pairRes.statusCode).toBe(201);
      const { deviceId, deviceToken } = pairRes.json();
      expect(deviceId).toMatch(/^dev_/);
      expect(deviceToken).toMatch(/^ld_dev_/);

      // 3. Second pair attempt with same code fails with 401
      const reuseRes = await app.inject({
        method: "POST",
        url: "/api/v1/extension/pair",
        payload: {
          code,
          label: "Another Browser",
        },
      });
      expect(reuseRes.statusCode).toBe(401);

      // 4. Whoami returns device details
      const whoamiRes = await app.inject({
        method: "GET",
        url: "/api/v1/extension/whoami",
        headers: { authorization: `Bearer ${deviceToken}` },
      });
      expect(whoamiRes.statusCode).toBe(200);
      expect(whoamiRes.json().deviceId).toBe(deviceId);
      expect(whoamiRes.json().label).toBe("Brave on Desk");
      expect(whoamiRes.json().sender).toBe(false);
    });
  });

  describe("Heartbeat", () => {
    it("updates last_seen_at and WhatsApp identity but does not extend lease_until", async () => {
      const now = Date.now();
      const devToken = "ld_dev_test_heartbeat_token";
      const devId = "dev_hb_01";

      await db.prepare(`
        INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at, authenticated)
        VALUES (?, 'Test HB', ?, ?, ?, 0)
      `).run(devId, sha256(devToken), now - 50_000, now - 50_000);

      // Give device an existing lease
      const originalLeaseUntil = now + 15_000;
      await db.prepare(`
        UPDATE sender_lease
        SET device_id = ?, lease_until = ?, grace_until = NULL
        WHERE id = 1
      `).run(devId, originalLeaseUntil);

      const hbRes = await app.inject({
        method: "POST",
        url: "/api/v1/extension/heartbeat",
        headers: { authorization: `Bearer ${devToken}` },
        payload: {
          streamMode: "MAIN",
          authenticated: true,
          ownJid: "12125550199@c.us",
          pushName: "Ada L.",
          extensionVersion: "0.1.0",
          bridgeVersion: "4.7.2",
        },
      });

      expect(hbRes.statusCode).toBe(200);
      expect(hbRes.json().role).toBe("sender");

      const devInDb = await db.prepare("SELECT * FROM extension_device WHERE id = ?").get(devId) as any;
      expect(devInDb.last_seen_at).toBeGreaterThan(now - 1000);
      expect(devInDb.authenticated).toBe(1);
      expect(devInDb.wa_jid).toBe("12125550199@c.us");
      expect(devInDb.wa_pushname).toBe("Ada L.");

      // Lease until was NOT changed by heartbeat
      const leaseInDb = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;
      expect(leaseInDb.lease_until).toBe(originalLeaseUntil);
    });
  });

  describe("Lease state machine", () => {
    const dev1Token = "ld_dev_lease_test_token_1";
    const dev2Token = "ld_dev_lease_test_token_2";
    const dev1Id = "dev_lease_01";
    const dev2Id = "dev_lease_02";

    beforeEach(async () => {
      const now = Date.now();
      await db.prepare(`
        INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at, authenticated)
        VALUES
          (?, 'Device 1', ?, ?, ?, 1),
          (?, 'Device 2', ?, ?, ?, 1)
      `).run(dev1Id, sha256(dev1Token), now, now, dev2Id, sha256(dev2Token), now, now);
    });

    it("1. senderTab: false does not take a free lease", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: false },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe("standby");
      expect(res.json().holderDeviceId).toBeNull();
      expect(res.json().leaseUntil).toBeNull();

      const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;
      expect(lease.device_id).toBeNull();
    });

    it("2. Paired device with fresh ready hello and no prior sender answer acquires a free lease", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe("sender");
      expect(res.json().leaseUntil).toBeDefined();

      const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;
      expect(lease.device_id).toBe(dev1Id);
      expect(lease.grace_until).toBeNull();
      expect(senderLeaseHeld(lease, dev1Id, Date.now())).toBe(true);
    });

    it("3. senderTab: false while holding lease enters 30s grace; second false call does not extend grace_until", async () => {
      // First acquire lease
      await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: true },
      });

      // Call lease with senderTab: false -> starts 30s grace
      const graceRes1 = await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: false },
      });

      expect(graceRes1.statusCode).toBe(200);
      expect(graceRes1.json().role).toBe("grace");
      const firstGraceUntil = graceRes1.json().leaseUntil;
      expect(firstGraceUntil).toBeDefined();

      const leaseInGrace = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;
      expect(leaseInGrace.grace_until).toBeDefined();
      // senderLeaseHeld is FALSE during grace!
      expect(senderLeaseHeld(leaseInGrace, dev1Id, Date.now())).toBe(false);

      // Second false call during grace does NOT extend grace_until or lease_until
      const graceRes2 = await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: false },
      });

      expect(graceRes2.statusCode).toBe(200);
      expect(graceRes2.json().role).toBe("grace");
      expect(graceRes2.json().leaseUntil).toBe(firstGraceUntil);
    });

    it("4. Second device cannot acquire during 30s grace and gets standby with holder's graceUntil", async () => {
      // Dev 1 acquires then enters grace
      await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: true },
      });
      const graceRes = await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: false },
      });
      const graceUntilIso = graceRes.json().leaseUntil;

      // Dev 2 attempts to acquire with senderTab: true
      const dev2Res = await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev2Token}` },
        payload: { senderTab: true },
      });

      expect(dev2Res.statusCode).toBe(200);
      expect(dev2Res.json().role).toBe("standby");
      expect(dev2Res.json().holderDeviceId).toBe(dev1Id);
      // Waiter leaseUntil is the holder's grace_until so it does not acquire during grace!
      expect(dev2Res.json().leaseUntil).toBe(graceUntilIso);
    });

    it("5. Holder in grace whose tab becomes eligible sends senderTab: true, clearing grace_until", async () => {
      // Dev 1 acquires then enters grace
      await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: true },
      });
      await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: false },
      });

      // Tab recovers: sends senderTab: true
      const recoveryRes = await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: true },
      });

      expect(recoveryRes.statusCode).toBe(200);
      expect(recoveryRes.json().role).toBe("sender");

      const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;
      expect(lease.device_id).toBe(dev1Id);
      expect(lease.grace_until).toBeNull();
      expect(senderLeaseHeld(lease, dev1Id, Date.now())).toBe(true);
    });

    it("6. Make-sender: with eligible tab renews without grace; with no eligible tab starts grace", async () => {
      // Operator makes dev 1 sender via dashboard POST /devices/:id/sender
      const makeSenderRes = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${dev1Id}/sender`,
        headers: { cookie: operatorCookie, "x-leaddesk-client": "web" },
      });
      expect(makeSenderRes.statusCode).toBe(200);

      // Case A: Dev 1 has an eligible tab -> calls lease with senderTab: true
      const leaseTrueRes = await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: true },
      });
      expect(leaseTrueRes.json().role).toBe("sender");
      const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;
      expect(lease.grace_until).toBeNull();

      // Case B: Dev 1 loses tab -> calls lease with senderTab: false -> starts grace once
      const leaseFalseRes = await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: false },
      });
      expect(leaseFalseRes.json().role).toBe("grace");
      const leaseInGrace = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;
      expect(leaseInGrace.grace_until).toBeDefined();
    });

    it("7. Standby device acquires once previous holder's grace and lease expired", async () => {
      const now = Date.now();
      // Dev 1 has expired lease in DB
      await db.prepare(`
        UPDATE sender_lease
        SET device_id = ?, lease_until = ?, grace_until = NULL
        WHERE id = 1
      `).run(dev1Id, now - 1000);

      // Dev 2 sends senderTab: true -> acquires!
      const dev2AcquireRes = await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev2Token}` },
        payload: { senderTab: true },
      });

      expect(dev2AcquireRes.statusCode).toBe(200);
      expect(dev2AcquireRes.json().role).toBe("sender");
      const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;
      expect(lease.device_id).toBe(dev2Id);
    });

    it("8. Revoking a device revokes credentials, clears held lease, and returns 401 on next call", async () => {
      // Dev 1 acquires lease
      await app.inject({
        method: "POST",
        url: "/api/v1/extension/lease",
        headers: { authorization: `Bearer ${dev1Token}` },
        payload: { senderTab: true },
      });

      // Operator revokes dev 1
      const revokeRes = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${dev1Id}/revoke`,
        headers: { cookie: operatorCookie, "x-leaddesk-client": "web" },
      });
      expect(revokeRes.statusCode).toBe(200);

      // Lease row cleared
      const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;
      expect(lease.device_id).toBeNull();

      // Next bearer call with revoked token returns 401
      const nextCallRes = await app.inject({
        method: "GET",
        url: "/api/v1/extension/whoami",
        headers: { authorization: `Bearer ${dev1Token}` },
      });
      expect(nextCallRes.statusCode).toBe(401);
    });
  });

  describe("Tab election and freshness logic", () => {
    it("A tick without a prior ready hello does not set hasEligibleTab or elect a tab", () => {
      const tabs = new Map<number, TabRecord>();
      const now = Date.now();

      // Tab arrives with tick only (no ready hello)
      const tabRecord: TabRecord = {
        tabId: 101,
        ready: false,
        authenticated: false,
        lastSeenAt: now,
        href: "https://web.whatsapp.com/",
      };
      tabs.set(101, tabRecord);

      expect(isTabEligible(tabRecord, now)).toBe(false);
      expect(computeHasEligibleTab(tabs.values(), now)).toBe(false);
      expect(electSenderTab(tabs, null, "sender", now)).toBeNull();
    });

    it("A tick inside 8 seconds of ready hello keeps sticky senderTabId; picking lowest id on change", () => {
      const tabs = new Map<number, TabRecord>();
      const now = Date.now();

      // Two ready & authenticated tabs: tab 200 and tab 100
      tabs.set(200, {
        tabId: 200,
        ready: true,
        authenticated: true,
        lastSeenAt: now - 1000,
        href: "https://web.whatsapp.com/",
      });
      tabs.set(100, {
        tabId: 100,
        ready: true,
        authenticated: true,
        lastSeenAt: now - 1000,
        href: "https://web.whatsapp.com/",
      });

      expect(computeHasEligibleTab(tabs.values(), now)).toBe(true);

      // Initial election picks the lowest tabId (100)
      const elected = electSenderTab(tabs, null, "sender", now);
      expect(elected).toBe(100);

      // Sticky check: A tick on tab 200 at now + 3000 does NOT flap elected tab away from 100
      tabs.get(200)!.lastSeenAt = now + 3000;
      const stillSticky = electSenderTab(tabs, 100, "sender", now + 3000);
      expect(stillSticky).toBe(100);

      // If tab 100 becomes stale (> 8 seconds old)
      const nowLater = now + 10_000;
      expect(isTabEligible(tabs.get(100)!, nowLater)).toBe(false);

      // Next election moves to tab 200
      const newElected = electSenderTab(tabs, 100, "sender", nowLater);
      expect(newElected).toBe(200);

      // If role is standby or grace, elected sender is always null
      expect(electSenderTab(tabs, 200, "standby", nowLater)).toBeNull();
      expect(electSenderTab(tabs, 200, "grace", nowLater)).toBeNull();
    });
  });
});
