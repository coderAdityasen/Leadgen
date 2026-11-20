import type { FastifyInstance } from "fastify";
import { createSuperAdmin } from "../src/accounts.js";
import { DEFAULT_ACCOUNT_ID } from "../src/tenancy.js";

export interface AdminInput {
  email?: string;
  password: string;
  displayName: string;
  timezone: string;
  defaultCountry: string;
  /** ignored: kept so older test payloads still type-check */
  bootstrapSecret?: string;
}

/**
 * Create the super admin straight in the database (there is no setup page) and sign in.
 * Returns the login response, so tests can read its session cookie.
 */
export async function setupAdmin(app: FastifyInstance, input: AdminInput) {
  const email = input.email ?? "admin@example.com";
  await createSuperAdmin(app.control, await app.tenants.get(DEFAULT_ACCOUNT_ID), {
    email,
    password: input.password,
    displayName: input.displayName,
    timezone: input.timezone,
    defaultCountry: input.defaultCountry,
  });
  return app.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { "x-leaddesk-client": "web" },
    payload: { email, password: input.password },
  });
}
