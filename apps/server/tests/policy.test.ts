import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import type { Db } from "../src/db.js";
import type { FastifyInstance } from "fastify";
import {
  quietHoursCover,
  nextOpenMinute,
  nextOpenAtOrAfter,
  gapBlocks,
  capBlocks,
  olderThanCatchup,
  getLocalTimeHHMM,
  type DeskPolicy,
  type OutboundCandidate,
} from "../src/policy.js";
import { setupAdmin } from "./helpers.js";

describe("Send policy and guardrails (PR 6)", () => {
  const defaultPolicy: DeskPolicy = {
    id: 1,
    quiet_hours_enabled: 1,
    quiet_start: "21:00",
    quiet_end: "08:00",
    daily_automated_cap: 80,
    daily_manual_cap: 200,
    min_automated_gap_seconds: 45,
    min_same_lead_gap_seconds: 180,
    ai_hourly_cap: 30,
    max_catchup_age_seconds: 21600,
    updated_at: 0,
  };

  const tz = "America/New_York";

  describe("Quiet hours pure functions", () => {
    it("handles windows crossing midnight in a non-UTC timezone", () => {
      // 2026-10-30T22:00:00 in America/New_York is EDT (-04:00) -> 2026-10-31T02:00:00Z
      const at2200 = new Date("2026-10-31T02:00:00Z").getTime();
      expect(getLocalTimeHHMM(at2200, tz).stringVal).toBe("22:00");
      expect(quietHoursCover(at2200, defaultPolicy, tz)).toBe(true);

      // 03:00 local time
      const at0300 = new Date("2026-10-31T07:00:00Z").getTime();
      expect(getLocalTimeHHMM(at0300, tz).stringVal).toBe("03:00");
      expect(quietHoursCover(at0300, defaultPolicy, tz)).toBe(true);

      // 12:00 local time -> outside quiet hours
      const at1200 = new Date("2026-10-31T16:00:00Z").getTime();
      expect(getLocalTimeHHMM(at1200, tz).stringVal).toBe("12:00");
      expect(quietHoursCover(at1200, defaultPolicy, tz)).toBe(false);

      // 08:00 local time -> exact end boundary -> open!
      const at0800 = new Date("2026-10-31T12:00:00Z").getTime();
      expect(getLocalTimeHHMM(at0800, tz).stringVal).toBe("08:00");
      expect(quietHoursCover(at0800, defaultPolicy, tz)).toBe(false);
    });

    it("rolls nextOpenMinute strictly out of quiet hours", () => {
      // 22:00 inside quiet hours
      const at2200 = new Date("2026-10-31T02:00:00Z").getTime();
      const openTime = nextOpenMinute(at2200, defaultPolicy, tz);
      expect(quietHoursCover(openTime, defaultPolicy, tz)).toBe(false);
      expect(getLocalTimeHHMM(openTime, tz).stringVal).toBe("08:00");

      // 12:00 outside quiet hours -> returns same instant
      const at1200 = new Date("2026-10-31T16:00:00Z").getTime();
      expect(nextOpenMinute(at1200, defaultPolicy, tz)).toBe(at1200);
    });
  });

  describe("Caps and Gaps", () => {
    it("exhausted automated cap does not block manual claim", () => {
      const automatedCandidate: OutboundCandidate = { kind: "sequence", due_at: Date.now() };
      const manualCandidate: OutboundCandidate = { kind: "manual", due_at: Date.now() };

      const counters = { automated_count: 80, manual_count: 10 };
      expect(capBlocks(automatedCandidate, counters, defaultPolicy)).toBe(true);
      expect(capBlocks(manualCandidate, counters, defaultPolicy)).toBe(false);
    });

    it("gap blocks automated sends but allows manual sends", () => {
      const now = 1000000;
      const automatedCandidate: OutboundCandidate = { kind: "sequence", due_at: now, lead_id: "led_01" };
      const manualCandidate: OutboundCandidate = { kind: "manual", due_at: now, lead_id: "led_01" };

      // 30 seconds ago (< 45s gap)
      const lastAutomated = now - 30_000;
      expect(gapBlocks(automatedCandidate, now, lastAutomated, null, defaultPolicy)).toBe(true);
      expect(gapBlocks(manualCandidate, now, lastAutomated, null, defaultPolicy)).toBe(false);

      // Same lead gap: 100s ago (< 180s gap)
      const lastSameLead = now - 100_000;
      expect(gapBlocks(automatedCandidate, now, null, lastSameLead, defaultPolicy)).toBe(true);
    });

    it("catchup identifies rows older than 6 hours", () => {
      const now = Date.now();
      const freshRow = { due_at: now - 3600_000 }; // 1 hr ago
      const expiredRow = { due_at: now - 7 * 3600_000 }; // 7 hrs ago
      expect(olderThanCatchup(freshRow, now, defaultPolicy)).toBe(false);
      expect(olderThanCatchup(expiredRow, now, defaultPolicy)).toBe(true);
    });
  });

  describe("Desk policy API endpoints", () => {
    let app: FastifyInstance;
    let db: Db;
    let cookieHeader: string;

    beforeEach(async () => {
      process.env["LEAD_DESK_BOOTSTRAP_SECRET"] = "secret-123";
      process.env["LEAD_DESK_SENDING_ENABLED"] = "true";
      process.env["LEAD_DESK_AI_ENABLED"] = "false"; // test kill switch echo
      db = await openDb({ path: ":memory:" });
      app = await buildApp({ db, logLevel: "silent" });

      const setupRes = await setupAdmin(app, {
          bootstrapSecret: "secret-123",
          password: "password12345678",
          displayName: "Operator",
          timezone: "UTC",
          defaultCountry: "US",
        });
      cookieHeader = `leaddesk_session=${setupRes.cookies[0]!.value}`;
    });

    afterEach(async () => {
      await app.close();
      delete process.env["LEAD_DESK_SENDING_ENABLED"];
      delete process.env["LEAD_DESK_AI_ENABLED"];
    });

    it("gets and updates desk policy with validation", async () => {
      const getRes = await app.inject({
        method: "GET",
        url: "/api/v1/desk-policy",
        headers: { cookie: cookieHeader },
      });
      expect(getRes.statusCode).toBe(200);
      const data = getRes.json();
      expect(data.dailyAutomatedCap).toBe(80);
      expect(data.sendingKillSwitch).toBe(false);
      expect(data.aiKillSwitch).toBe(true);

      // Update
      const putRes = await app.inject({
        method: "PUT",
        url: "/api/v1/desk-policy",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: {
          dailyAutomatedCap: 100,
          minAutomatedGapSeconds: 50,
          minSameLeadGapSeconds: 200,
        },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().dailyAutomatedCap).toBe(100);
      expect(putRes.json().minAutomatedGapSeconds).toBe(50);
      expect(putRes.json().minSameLeadGapSeconds).toBe(200);

      // Validation: same lead gap less than automated gap rejected
      const badRes = await app.inject({
        method: "PUT",
        url: "/api/v1/desk-policy",
        headers: { cookie: cookieHeader, "x-leaddesk-client": "web" },
        payload: {
          minAutomatedGapSeconds: 100,
          minSameLeadGapSeconds: 50,
        },
      });
      expect(badRes.statusCode).toBe(400);
      expect(badRes.json().error.code).toBe("validation");
    });
  });
});
