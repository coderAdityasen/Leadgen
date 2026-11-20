import type { FastifyPluginAsync } from "fastify";
import { requireOperatorSession } from "../auth.js";
import type { DeskPolicy } from "../policy.js";

export const statusRoutes: FastifyPluginAsync = async (app) => {
  // GET /status
  app.get("/status", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;
    const now = Date.now();

    // 1. dbWritable check via health_probe
    let dbWritable = true;
    try {
      await db.prepare("UPDATE health_probe SET touched_at = ? WHERE id = 1").run(now);
    } catch {
      dbWritable = false;
    }

    // 2. schemaVersion
    const schemaRow = await db
      .prepare("SELECT MAX(version) as version FROM schema_migration")
      .get() as { version: number | null } | undefined;
    const schemaVersion = schemaRow?.version ?? 0;

    // 3. Extension connection status
    const allDevices = await db
      .prepare("SELECT * FROM extension_device WHERE revoked_at IS NULL ORDER BY paired_at ASC")
      .all() as any[];
    const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;

    let connection: "sender" | "standby" | "grace" | "quiet" | "unpaired" = "unpaired";
    let senderObj: any = null;

    if (allDevices.length === 0) {
      connection = "unpaired";
    } else if (lease && lease.device_id) {
      const dev = allDevices.find((d) => d.id === lease.device_id);
      if (dev) {
        const heartbeatAgeSeconds = Math.max(0, Math.floor((now - dev.last_seen_at) / 1000));
        const isGrace = lease.grace_until && lease.grace_until > now;
        const isHolder = lease.lease_until && lease.lease_until > now;

        let role: "sender" | "grace" | "standby" = "standby";
        if (isGrace) role = "grace";
        else if (isHolder) role = "sender";

        senderObj = {
          deviceId: dev.id,
          label: dev.label,
          lastSeenAt: new Date(dev.last_seen_at).toISOString(),
          heartbeatAgeSeconds,
          leaseUntil: lease.lease_until ? new Date(lease.lease_until).toISOString() : null,
          role,
        };

        if (now - dev.last_seen_at > 45_000) {
          connection = "quiet";
        } else if (isGrace) {
          connection = "grace";
        } else if (isHolder) {
          connection = "sender";
        } else {
          connection = "standby";
        }
      } else {
        connection = "standby";
      }
    } else {
      const latestLastSeen = Math.max(...allDevices.map((d) => d.last_seen_at));
      if (now - latestLastSeen > 45_000) {
        connection = "quiet";
      } else {
        connection = "standby";
      }
    }

    // 4. Queue metrics
    const queueRows = await db
      .prepare(`
        SELECT
          SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
          SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) as claimed,
          SUM(CASE WHEN status = 'needs_approval' THEN 1 ELSE 0 END) as needsApproval,
          SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) as needsReview,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'queued' AND due_at <= ? THEN 1 ELSE 0 END) as dueNow
        FROM outbound_queue
        -- Only the open statuses: uses the status index instead of reading every sent row.
        WHERE status IN ('queued', 'claimed', 'needs_approval', 'needs_review', 'failed')
      `)
      .get(now) as any;

    const queue = {
      queued: queueRows?.queued ?? 0,
      claimed: queueRows?.claimed ?? 0,
      needsApproval: queueRows?.needsApproval ?? 0,
      needsReview: queueRows?.needsReview ?? 0,
      failed: queueRows?.failed ?? 0,
      dueNow: queueRows?.dueNow ?? 0,
    };

    // 5. Caps
    const policy = await db.prepare("SELECT * FROM desk_policy WHERE id = 1").get() as
      | DeskPolicy
      | undefined;
    const operator = await db.prepare("SELECT timezone FROM operator LIMIT 1").get() as
      | { timezone: string }
      | undefined;
    const tz = operator?.timezone || "UTC";

    const dayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now));
    const dailyRow = await db
      .prepare("SELECT automated_count, manual_count FROM daily_counter WHERE day_local = ?")
      .get(dayLocal) as any;

    const hourUtc = new Date(now).toISOString().slice(0, 13);
    const hourlyRow = await db
      .prepare("SELECT count FROM ai_hourly_counter WHERE hour_utc = ?")
      .get(hourUtc) as any;

    const caps = {
      automatedToday: dailyRow?.automated_count ?? 0,
      automatedCap: policy?.daily_automated_cap ?? 80,
      manualToday: dailyRow?.manual_count ?? 0,
      manualCap: policy?.daily_manual_cap ?? 200,
      aiThisHour: hourlyRow?.count ?? 0,
      aiHourlyCap: policy?.ai_hourly_cap ?? 30,
    };

    // 6. AI metrics
    const aiSettings = await db
      .prepare("SELECT api_key_ciphertext FROM ai_settings WHERE id = 1")
      .get() as any;
    const lastSuccessRow = await db
      .prepare(
        "SELECT created_at FROM message_log WHERE ai_state = 'drafted' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as any;
    const lastFailureRow = await db
      .prepare(
        "SELECT created_at FROM message_log WHERE ai_state = 'failed' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as any;

    // Consecutive AI failures
    const recentAiRows = await db
      .prepare(`
        SELECT ai_state FROM message_log
        WHERE ai_state IN ('drafted', 'skipped', 'failed')
        ORDER BY created_at DESC
        LIMIT 20
      `)
      .all() as Array<{ ai_state: string }>;

    let consecutiveFailures = 0;
    for (const r of recentAiRows) {
      if (r.ai_state === "failed") {
        consecutiveFailures++;
      } else {
        break;
      }
    }

    const ai = {
      keySet: Boolean(aiSettings?.api_key_ciphertext),
      lastSuccessAt: lastSuccessRow?.created_at
        ? new Date(lastSuccessRow.created_at).toISOString()
        : null,
      lastFailureAt: lastFailureRow?.created_at
        ? new Date(lastFailureRow.created_at).toISOString()
        : null,
      consecutiveFailures,
    };

    // 7. Kill switches
    const killSwitch = {
      sending: process.env["LEAD_DESK_SENDING_ENABLED"] === "false",
      ai: process.env["LEAD_DESK_AI_ENABLED"] === "false",
    };

    // 8. Red indicators
    const red: string[] = [];
    if (!dbWritable) {
      red.push("db");
    }

    if (queue.dueNow > 0) {
      const senderHeartbeatAge = senderObj ? senderObj.heartbeatAgeSeconds : 999;
      if (senderHeartbeatAge > 45) {
        red.push("heartbeat_stale");
      }
    }

    const recentIssueCount = (
      await db
        .prepare(`
          SELECT COUNT(*) as count FROM outbound_queue
          WHERE status IN ('failed', 'needs_review') AND created_at > ?
        `)
        .get(now - 86400_000) as any
    ).count;

    if (recentIssueCount > 0) {
      red.push("failed_or_review");
    }

    if (consecutiveFailures >= 3) {
      red.push("ai_failures");
    }

    return reply.code(200).send({
      ok: dbWritable,
      version: "0.1.0",
      uptimeSeconds: Math.floor(process.uptime()),
      schemaVersion,
      dbWritable,
      connection,
      sender: senderObj,
      queue,
      caps,
      ai,
      killSwitch,
      red,
    });
  });
};
