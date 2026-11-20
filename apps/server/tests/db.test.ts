import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync, existsSync } from "node:fs";
import { connectDb, openDb, runMigrations, DEFAULT_MIGRATIONS_DIR } from "../src/db.js";

describe("SQLite schema and migrations (PR 2)", () => {
  const tempDbPath = join(tmpdir(), `leaddesk_test_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`);

  afterEach(() => {
    if (existsSync(tempDbPath)) {
      try {
        unlinkSync(tempDbPath);
      } catch {
        // file may still be cleaning up
      }
    }
  });

  it("applies migrations to a temp file twice and checks the second boot is a no-op", async () => {
    // First boot
    const db1 = await openDb({ path: tempDbPath });
    const applied1 = await db1.prepare("SELECT version FROM schema_migration ORDER BY version ASC").all() as { version: number }[];
    expect(applied1.length).toBe(5);
    expect(applied1[0]?.version).toBe(1);
    expect(applied1[1]?.version).toBe(2);

    // Verify seed data from 002_seed.sql
    const pipeline = await db1.prepare("SELECT * FROM pipeline WHERE id = 'pip_leads'").get() as { id: string; name: string };
    expect(pipeline).toBeDefined();
    expect(pipeline.name).toBe("Leads");

    const stages = await db1.prepare("SELECT * FROM stage ORDER BY position ASC").all() as { id: string; name: string; position: number }[];
    expect(stages.length).toBe(5);
    expect(stages.map((s) => s.name)).toEqual(["New", "Contacted", "Waiting", "Won", "Lost"]);

    const lease = await db1.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as { id: number };
    expect(lease).toBeDefined();

    const policy = await db1.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as { id: number; daily_automated_cap: number };
    expect(policy).toBeDefined();
    expect(policy.daily_automated_cap).toBe(80);

    const ai = await db1.prepare("SELECT * FROM ai_settings WHERE id = 1").get() as { id: number; mode: string };
    expect(ai).toBeDefined();
    expect(ai.mode).toBe("off");

    const probe = await db1.prepare("SELECT * FROM health_probe WHERE id = 1").get() as { id: number; touched_at: number };
    expect(probe).toBeDefined();
    expect(probe.touched_at).toBe(0);

    // Verify pragmas
    const journalMode = (await db1.prepare("PRAGMA journal_mode").get()) as { journal_mode: string };
    expect(journalMode.journal_mode).toBe("wal");
    const foreignKeys = (await db1.prepare("PRAGMA foreign_keys").get()) as { foreign_keys: number };
    expect(foreignKeys.foreign_keys).toBe(1);

    await db1.close();

    // Second boot
    const db2 = await connectDb(tempDbPath);
    const count = await runMigrations(db2, DEFAULT_MIGRATIONS_DIR);
    expect(count).toBe(0); // 0 new migrations run on second boot

    const applied2 = (await db2.prepare("SELECT version FROM schema_migration ORDER BY version ASC").all()) as { version: number }[];
    expect(applied2.length).toBe(5);

    await db2.close();
  });
});
