import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";

describe("GET /api/v1/health", () => {
  it("returns ok: true and version 0.1.0 with no auth", async () => {
    const app = await buildApp({ db: await (await import("../src/db.js")).openDb({ path: ":memory:" }) });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      version: "0.1.0",
    });
    await app.close();
  });

  it("returns 404 for unknown api routes", async () => {
    const app = await buildApp({ db: await (await import("../src/db.js")).openDb({ path: ":memory:" }) });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/unknown",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
    await app.close();
  });
});
