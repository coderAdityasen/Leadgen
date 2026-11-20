import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connectDb, openDb, type Db } from "../src/db.js";
import { localTenantStorage, openControlDb, tursoTenantStorage } from "../src/tenancy.js";
import { copyDatabase, transferInstallation } from "../src/transfer.js";

const dirs: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "leaddesk-transfer-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows may still hold a WAL file for a moment
    }
  }
});

async function addLead(db: Db, id: string, name: string) {
  const now = Date.now();
  await db
    .prepare("INSERT INTO lead (id, display_name, stage_id, created_at, updated_at) VALUES (?, ?, 'stg_new', ?, ?)")
    .run(id, name, now, now);
  await db
    .prepare("INSERT INTO phone_identity (id, lead_id, e164, is_primary, created_at) VALUES (?, ?, ?, 1, ?)")
    .run(`ph_${id}`, id, `+9198${Math.floor(Math.random() * 1e8)}`, now);
}

describe("Moving data between local files and Turso", () => {
  it("copies every table, replacing seeded rows, with foreign keys intact", async () => {
    const src = await openDb({ path: ":memory:" });
    const dst = await openDb({ path: ":memory:" });
    const stage = (await src.prepare("SELECT id FROM stage ORDER BY position LIMIT 1").get()) as { id: string };
    expect(stage.id).toBe("stg_new");
    for (let i = 0; i < 700; i++) await addLead(src, `lead_${i}`, `Lead ${i}`); // more rows than one multi-row insert
    await src.prepare("UPDATE desk_policy SET daily_automated_cap = 7 WHERE id = 1").run();

    const counts = await copyDatabase(src, dst);
    expect(counts["lead"]).toBe(700);
    expect(counts["phone_identity"]).toBe(700);

    const leads = (await dst.prepare("SELECT COUNT(*) AS c FROM lead").get()) as { c: number };
    expect(leads.c).toBe(700);
    const policy = (await dst.prepare("SELECT daily_automated_cap FROM desk_policy WHERE id = 1").get()) as {
      daily_automated_cap: number;
    };
    expect(policy.daily_automated_cap).toBe(7);
    const orphans = (await dst
      .prepare("SELECT COUNT(*) AS c FROM phone_identity p LEFT JOIN lead l ON l.id = p.lead_id WHERE l.id IS NULL")
      .get()) as { c: number };
    expect(orphans.c).toBe(0);
    await src.close();
    await dst.close();
  });

  it("moves a whole installation (default desk, control, client accounts) and repoints account databases", async () => {
    const from = tempDir();
    const to = tempDir();

    // Source installation: default desk + control + one client account.
    const main = await openDb({ path: join(from, "leaddesk.sqlite") });
    await addLead(main, "lead_owner", "Owner lead");
    await main.close();
    const control = await openControlDb(join(from, "control.sqlite"));
    const now = Date.now();
    await control
      .prepare("INSERT INTO account (id, name, db_file, status, billing_exempt, created_at, updated_at) VALUES ('acc_default', 'My desk', NULL, 'active', 1, ?, ?)")
      .run(now, now);
    await control
      .prepare("INSERT INTO account (id, name, db_file, status, billing_exempt, created_at, updated_at) VALUES ('acc_client1', 'Client', 'tenants/acc_client1.sqlite', 'active', 0, ?, ?)")
      .run(now, now);
    await control
      .prepare("INSERT INTO app_user (id, account_id, email, display_name, role, created_at, updated_at) VALUES ('usr_1', 'acc_client1', 'c@example.com', 'Client', 'owner', ?, ?)")
      .run(now, now);
    await control.close();
    const tenant = await openDb({ path: join(from, "tenants/acc_client1.sqlite") });
    await addLead(tenant, "lead_client", "Client lead");
    await tenant.close();

    // Destination storage that hands out a different file name, like Turso hands out a URL.
    const local = localTenantStorage(to);
    const logs: string[] = [];
    await transferInstallation(
      { main: { url: join(from, "leaddesk.sqlite") }, control: { url: join(from, "control.sqlite") } },
      {
        main: { url: join(to, "leaddesk.sqlite") },
        control: { url: join(to, "control.sqlite") },
        tenantStorage: { create: async (id) => `tenants/moved-${id}.sqlite`, locate: local.locate },
        sourceTenant: (dbFile) => ({ url: join(from, dbFile) }),
        log: (l) => logs.push(l),
      }
    );
    expect(logs.length).toBe(3);

    const newControl = await connectDb(join(to, "control.sqlite"));
    const acc = (await newControl.prepare("SELECT db_file FROM account WHERE id = 'acc_client1'").get()) as { db_file: string };
    expect(acc.db_file).toBe("tenants/moved-acc_client1.sqlite");
    const users = (await newControl.prepare("SELECT COUNT(*) AS c FROM app_user").get()) as { c: number };
    expect(users.c).toBe(1);
    await newControl.close();

    expect(existsSync(join(to, "tenants/moved-acc_client1.sqlite"))).toBe(true);
    const movedTenant = await connectDb(join(to, "tenants/moved-acc_client1.sqlite"));
    const lead = (await movedTenant.prepare("SELECT display_name FROM lead").get()) as { display_name: string };
    expect(lead.display_name).toBe("Client lead");
    await movedTenant.close();

    // A second run refuses to overwrite logins unless forced.
    await expect(
      transferInstallation(
        { main: { url: join(from, "leaddesk.sqlite") }, control: { url: join(from, "control.sqlite") } },
        {
          main: { url: join(to, "leaddesk.sqlite") },
          control: { url: join(to, "control.sqlite") },
          tenantStorage: local,
          sourceTenant: (dbFile) => ({ url: join(from, dbFile) }),
        }
      )
    ).rejects.toThrow(/--force/);
  });

  it("creates client databases through the Turso Platform API, reusing one left by an earlier attempt", async () => {
    const saved = { ...process.env };
    process.env["TURSO_API_TOKEN"] = "platform-token";
    process.env["TURSO_ORG"] = "my-org";
    process.env["TURSO_GROUP_AUTH_TOKEN"] = "group-token";
    try {
      const calls: { url: string; method: string; body?: string }[] = [];
      const fakeFetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
        if (init?.method === "POST" && calls.length === 1) {
          return Response.json({ database: { Hostname: "ld-acc-new-my-org.turso.io" } }, { status: 200 });
        }
        if (init?.method === "POST") return Response.json({ error: "database already exists" }, { status: 409 });
        return Response.json({ database: { Hostname: "ld-acc-old-my-org.turso.io" } }, { status: 200 });
      }) as typeof fetch;

      const storage = tursoTenantStorage(fakeFetch);
      expect(await storage.create("acc_NEW")).toBe("libsql://ld-acc-new-my-org.turso.io");
      expect(calls[0]!.url).toBe("https://api.turso.tech/v1/organizations/my-org/databases");
      expect(JSON.parse(calls[0]!.body!)).toEqual({ name: "ld-acc-new", group: "default" });

      expect(await storage.create("acc_OLD")).toBe("libsql://ld-acc-old-my-org.turso.io");
      expect(calls[2]!.url).toBe("https://api.turso.tech/v1/organizations/my-org/databases/ld-acc-old");

      expect(storage.locate("libsql://x.turso.io")).toEqual({ url: "libsql://x.turso.io", authToken: "group-token" });

      delete process.env["TURSO_API_TOKEN"];
      await expect(storage.create("acc_X")).rejects.toThrow(/TURSO_API_TOKEN/);
    } finally {
      process.env = saved;
    }
  });
});
