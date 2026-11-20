import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import type { Db } from "../src/db.js";
import type { FastifyInstance } from "fastify";
import { setupAdmin } from "./helpers.js";

const WEB = { "x-leaddesk-client": "web" };
const ADMIN_ENV = ["LEAD_DESK_ADMIN_EMAIL", "LEAD_DESK_ADMIN_PASSWORD", "LEAD_DESK_ADMIN_NAME"] as const;

describe("Admin login and sessions", () => {
  let app: FastifyInstance;
  let db: Db;

  beforeEach(async () => {
    db = await openDb({ path: ":memory:" });
    app = await buildApp({ db, logLevel: "silent" });
  });

  afterEach(async () => {
    await app.close();
    for (const k of ADMIN_ENV) delete process.env[k];
  });

  it("has no setup or sign-up page on the website, even on an empty install", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/setup/status" })).statusCode).toBe(404);
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      headers: WEB,
      payload: { bootstrapSecret: "x", password: "supersecretpassword123", displayName: "Eve", timezone: "UTC", defaultCountry: "US" },
    });
    expect(setup.statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/invite/accept", headers: WEB, payload: {} })).statusCode).toBe(404);
    // Nobody can sign in until an admin exists in the database.
    const login = await app.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: { password: "supersecretpassword123" } });
    expect(login.statusCode).toBe(401);
  });

  it("creates the admin login from LEAD_DESK_ADMIN_EMAIL / LEAD_DESK_ADMIN_PASSWORD once, on an empty install", async () => {
    process.env["LEAD_DESK_ADMIN_EMAIL"] = "Boss@Company.com";
    process.env["LEAD_DESK_ADMIN_PASSWORD"] = "first-admin-password";
    process.env["LEAD_DESK_ADMIN_NAME"] = "Boss";
    const fresh = await openDb({ path: ":memory:" });
    const first = await buildApp({ db: fresh, logLevel: "silent" });
    const login = await first.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: { email: "boss@company.com", password: "first-admin-password" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().operator.displayName).toBe("Boss");
    const cookie = `leaddesk_session=${login.cookies[0]!.value}`;
    expect((await first.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })).json()).toMatchObject({
      email: "boss@company.com",
      role: "superadmin",
    });
    await first.close();

    // A restart with a different password in the environment does not touch the existing admin.
    process.env["LEAD_DESK_ADMIN_PASSWORD"] = "changed-in-env-later";
    const second = await buildApp({ db: fresh, logLevel: "silent" });
    try {
      const old = await second.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: { email: "boss@company.com", password: "first-admin-password" } });
      expect(old.statusCode).toBe(200);
      const changed = await second.inject({ method: "POST", url: "/api/v1/session", headers: WEB, payload: { email: "boss@company.com", password: "changed-in-env-later" } });
      expect(changed.statusCode).toBe(401);
    } finally {
      await second.close();
      await fresh.close();
    }
  });

  it("refuses a too-short admin password from the environment", async () => {
    process.env["LEAD_DESK_ADMIN_EMAIL"] = "boss@company.com";
    process.env["LEAD_DESK_ADMIN_PASSWORD"] = "short";
    const fresh = await openDb({ path: ":memory:" });
    const other = await buildApp({ db: fresh, logLevel: "silent" });
    try {
      const users = (await other.control.prepare("SELECT COUNT(*) AS c FROM app_user").get()) as { c: number };
      expect(users.c).toBe(0);
    } finally {
      await other.close();
      await fresh.close();
    }
  });

  it("requires X-LeadDesk-Client: web on mutating requests", async () => {
    await setupAdmin(app, { password: "supersecretpassword123", displayName: "Ada", timezone: "America/New_York", defaultCountry: "US" });
    const res = await app.inject({ method: "POST", url: "/api/v1/session", payload: { password: "supersecretpassword123" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("refuses to create a second admin", async () => {
    await setupAdmin(app, { password: "supersecretpassword123", displayName: "Ada", timezone: "UTC", defaultCountry: "US" });
    await expect(
      setupAdmin(app, { email: "two@example.com", password: "supersecretpassword123", displayName: "Two", timezone: "UTC", defaultCountry: "US" })
    ).rejects.toThrow(/already exists/);
  });

  it("supports login, me, patch me, password change, and logout", async () => {
    // 1. Setup
    const setupRes = await setupAdmin(app, {
        bootstrapSecret: "correct-bootstrap-secret-12345",
        password: "supersecretpassword123",
        displayName: "Ada Lovelace",
        timezone: "America/New_York",
        defaultCountry: "US",
      });
    expect(setupRes.statusCode).toBe(200);
    const cookieHeader = `leaddesk_session=${setupRes.cookies[0]!.value}`;

    // 2. GET /me
    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookieHeader },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().displayName).toBe("Ada Lovelace");

    // 3. PATCH /me
    const patchRes = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: {
        cookie: cookieHeader,
        "x-leaddesk-client": "web",
      },
      payload: { displayName: "Ada Byron" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().displayName).toBe("Ada Byron");

    // 4. Login with second session
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: { "x-leaddesk-client": "web" },
      payload: { password: "supersecretpassword123" },
    });
    expect(loginRes.statusCode).toBe(200);
    const secondCookieHeader = `leaddesk_session=${loginRes.cookies[0]!.value}`;

    // 5. Change password using second session -> revokes first session
    const pwdRes = await app.inject({
      method: "POST",
      url: "/api/v1/me/password",
      headers: {
        cookie: secondCookieHeader,
        "x-leaddesk-client": "web",
      },
      payload: {
        currentPassword: "supersecretpassword123",
        nextPassword: "brandnewpassword456",
      },
    });
    expect(pwdRes.statusCode).toBe(204);

    // First session is now revoked (401)
    const oldMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookieHeader },
    });
    expect(oldMe.statusCode).toBe(401);

    // Second session still works
    const newMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: secondCookieHeader },
    });
    expect(newMe.statusCode).toBe(200);

    // 6. Logout second session
    const logoutRes = await app.inject({
      method: "DELETE",
      url: "/api/v1/session",
      headers: {
        cookie: secondCookieHeader,
        "x-leaddesk-client": "web",
      },
    });
    expect(logoutRes.statusCode).toBe(204);

    // Now second session also 401
    const loggedOutMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: secondCookieHeader },
    });
    expect(loggedOutMe.statusCode).toBe(401);
  });
});
