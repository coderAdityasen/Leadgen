import type { Db } from "./db.js";
import type { DeskPolicy } from "./policy.js";
import { stopEnrollmentForDeadRow } from "./queue.js";

export async function sweepExpiredQueueRows(db: Db): Promise<number> {
  const policy = await db.prepare("SELECT max_catchup_age_seconds FROM desk_policy WHERE id = 1").get() as
    | Pick<DeskPolicy, "max_catchup_age_seconds">
    | undefined;

  const maxAgeSeconds = policy?.max_catchup_age_seconds ?? 21600; // 6 hours
  const now = Date.now();
  const cutoff = now - maxAgeSeconds * 1000;

  return await db.transaction(async () => {
    const rows = await db
      .prepare("SELECT id, enrollment_id FROM outbound_queue WHERE status = 'queued' AND due_at < ?")
      .all(cutoff) as { id: string; enrollment_id: string | null }[];
    const expire = db.prepare(
      "UPDATE outbound_queue SET status = 'expired', last_error = 'catchup_limit_exceeded' WHERE id = ?"
    );
    for (const row of rows) {
      await expire.run(row.id);
      await stopEnrollmentForDeadRow(db, row, "expired", now);
    }
    return rows.length;
  });
}

export function startQueueSweeper(db: Db, intervalMs = 60_000): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await sweepExpiredQueueRows(db);
      // Prune bookkeeping that only grows: consumed/expired pairing codes and old sessions.
      const now = Date.now();
      await db.prepare("DELETE FROM pairing_code WHERE expires_at < ?").run(now - 24 * 3600_000);
      await db.prepare("DELETE FROM operator_session WHERE hard_expires_at < ? OR revoked_at < ?").run(
        now,
        now - 7 * 24 * 3600_000
      );
    } catch {
      // Ignore background sweep errors
    }
  }, intervalMs);
}
