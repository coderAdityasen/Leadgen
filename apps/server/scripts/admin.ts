/**
 * Admin logins from the command line (there is no setup page on the website).
 *
 *   npm run admin:create -- --email you@company.com [--password ...] [--name "Your Name"]
 *                           [--timezone Asia/Kolkata] [--country IN]
 *       Creates the super admin on an empty install.
 *
 *   npm run admin:reset-password -- --email someone@company.com [--password ...]
 *       New password for any login (admin or client). Signs out its sessions.
 *
 * Without --password a strong password is generated and printed once.
 * Uses the same database settings as the server (.env: DATABASE_URL etc., or local files).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "../src/app.js";
import { createSuperAdmin, generatePassword, normalizeEmail, setUserPassword } from "../src/accounts.js";
import { DEFAULT_ACCOUNT_ID } from "../src/tenancy.js";
import type { AppUserRow } from "../src/auth.js";

for (const file of [resolve(".env"), resolve("../../.env")]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const [mode, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function main() {
  const email = normalizeEmail(flag("--email"));
  if (!email || (mode !== "create" && mode !== "reset-password")) {
    console.log("usage: admin.ts create --email <email> [--password <pw>] [--name <name>] [--timezone <tz>] [--country <CC>]");
    console.log("       admin.ts reset-password --email <email> [--password <pw>]");
    process.exit(2);
  }
  const password = flag("--password") || generatePassword();

  const app = await buildApp({ logLevel: "error" });
  try {
    if (mode === "create") {
      await createSuperAdmin(app.control, await app.tenants.get(DEFAULT_ACCOUNT_ID), {
        email,
        password,
        displayName: flag("--name") || "Admin",
        timezone: flag("--timezone") || "Asia/Kolkata",
        defaultCountry: flag("--country") || "IN",
      });
      console.log("Admin login created.");
    } else {
      const user = (await app.control.prepare("SELECT * FROM app_user WHERE email = ?").get(email)) as AppUserRow | undefined;
      if (!user) throw new Error(`No login with the email ${email}.`);
      await setUserPassword(app.tenants, user, password);
      console.log("Password changed; that login was signed out everywhere.");
    }
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${password}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
