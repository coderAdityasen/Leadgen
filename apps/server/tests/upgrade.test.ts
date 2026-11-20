import { describe, it, expect } from "vitest";
import argon2 from "argon2";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { ARGON2_OPTIONS, sha256 } from "../src/auth.js";
import { setupAdmin } from "./helpers.js";

describe("Upgrading a single-operator install", () => {
  it("makes the existing operator the super admin with the same password and keeps old sessions/devices", async () => {
    const db = await openDb({ path: ":memory:" });
    const now = Date.now();
    const hash = await argon2.hash("old-password-12345", ARGON2_OPTIONS);
    await db.prepare("INSERT INTO operator (id, password_hash, display_name, timezone, default_country, created_at, updated_at) VALUES ('opr_1', ?, 'Asha', 'UTC', 'IN', ?, ?)").run(hash, now, now);
    await db.prepare("INSERT INTO operator_session (id, token_hash, created_at, last_seen_at, hard_expires_at) VALUES ('ses_1', ?, ?, ?, ?)").run(sha256("old-session-token"), now, now, now + 86400_000);
    await db.prepare("INSERT INTO extension_device (id, label, token_hash, paired_at, last_seen_at, authenticated) VALUES ('dev_1', 'Old', ?, ?, ?, 1)").run(sha256("ld_dev_oldtoken"), now, now);
    await db.prepare("INSERT INTO lead (id, display_name, stage_id, created_at, updated_at) VALUES ('led_1', 'Existing lead', 'stg_new', ?, ?)").run(now, now);

    process.env["LEAD_DESK_ADMIN_EMAIL"] = "Asha@Example.com";
    const app = await buildApp({ db, logLevel: "silent" });
    try {
      const old = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: "leaddesk_session=old-session-token" } });
      expect(old.json()).toMatchObject({ role: "superadmin", email: "asha@example.com", billing: { state: "exempt" } });

      for (const payload of [{ password: "old-password-12345" }, { email: "asha@example.com", password: "old-password-12345" }]) {
        const login = await app.inject({ method: "POST", url: "/api/v1/session", headers: { "x-leaddesk-client": "web" }, payload });
        expect(login.statusCode).toBe(200);
      }
      const board = await app.inject({ method: "GET", url: "/api/v1/extension/crm/board", headers: { authorization: "Bearer ld_dev_oldtoken" } });
      expect(board.json().items.map((l: any) => l.displayName)).toEqual(["Existing lead"]);
      // The existing operator is the admin: a second one cannot be created.
      await expect(
        setupAdmin(app, { email: "x@y.in", password: "another-password-1", displayName: "X", timezone: "UTC", defaultCountry: "IN" })
      ).rejects.toThrow(/already exists/);
    } finally {
      delete process.env["LEAD_DESK_ADMIN_EMAIL"];
      await app.close();
    }
  });
});
