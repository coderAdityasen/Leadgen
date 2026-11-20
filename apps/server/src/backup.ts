import { mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";

export async function performDbBackup(
  db: Db,
  backupDir = join(process.cwd(), "data/backups")
): Promise<string> {
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const dateStr = `${yyyy}${mm}${dd}`;

  const destPath = join(backupDir, `leaddesk-${dateStr}.sqlite`);

  // Online copy of a local SQLite file (Turso databases are skipped: they have point-in-time restore)
  await db.backupTo(destPath);

  // Prune older backups: keep the newest 14
  try {
    const files = readdirSync(backupDir)
      .filter((f) => /^leaddesk-\d{8}\.sqlite$/.test(f))
      .sort(); // Lexicographical sort corresponds to chronological sort

    while (files.length > 14) {
      const oldest = files.shift()!;
      unlinkSync(join(backupDir, oldest));
    }
  } catch {
    // Ignore prune errors
  }

  return destPath;
}

export function startBackupSchedule(
  db: Db,
  backupDir?: string,
  intervalMs = 24 * 3600_000
): NodeJS.Timeout {
  // Check if today's backup exists; if not run immediately
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const dateStr = `${yyyy}${mm}${dd}`;
  const targetDir = backupDir ?? join(process.cwd(), "data/backups");
  const todayPath = join(targetDir, `leaddesk-${dateStr}.sqlite`);

  if (!existsSync(todayPath)) {
    performDbBackup(db, targetDir).catch(() => {});
  }

  return setInterval(() => {
    performDbBackup(db, targetDir).catch(() => {});
  }, intervalMs);
}
