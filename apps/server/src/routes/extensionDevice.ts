import type { FastifyPluginAsync } from "fastify";
import { generateUlid } from "@leaddesk/shared";
import { sha256, generateToken, requireExtensionDevice } from "../auth.js";
import { currentAccountId, deviceTokenPrefix } from "../tenancy.js";
import { canonicalizeCrockford } from "./pairing.js";

// Rate limiting: 5 FAILED pair attempts per IP per hour. Successful pairs don't count,
// so re-pairing a browser never locks the operator out.
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const pairFailures = new Map<string, RateLimitEntry>();

function checkPairRateLimit(ip: string): boolean {
  const entry = pairFailures.get(ip);
  if (!entry) return true;
  if (Date.now() > entry.resetAt) {
    pairFailures.delete(ip);
    return true;
  }
  return entry.count < 5;
}

function recordPairFailure(ip: string): void {
  const now = Date.now();
  const entry = pairFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    pairFailures.set(ip, { count: 1, resetAt: now + 3600_000 });
  } else {
    entry.count++;
  }
}

export const extensionDeviceRoutes: FastifyPluginAsync = async (app) => {
  // POST /extension/pair
  app.post("/extension/pair", async (request, reply) => {
    const ip = request.ip || "127.0.0.1";
    if (!checkPairRateLimit(ip)) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: "Too many pair attempts. Try again later.", details: {} },
      });
    }

    const body = (request.body ?? {}) as {
      code?: string;
      label?: string;
      userAgent?: string;
    };

    if (
      typeof body.code !== "string" ||
      typeof body.label !== "string" ||
      !body.code.trim() ||
      !body.label.trim()
    ) {
      return reply.code(400).send({
        error: { code: "validation", message: "code and label are required.", details: {} },
      });
    }

    const canonicalCode = canonicalizeCrockford(body.code);
    const codeHash = sha256(canonicalCode);
    const db = app.db;
    const now = Date.now();

    const result = await db.transaction(async () => {
      const pairingRow = await db.prepare(`
        SELECT * FROM pairing_code
        WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `).get(codeHash, now) as { id: string } | undefined;

      if (!pairingRow) {
        return null;
      }

      // Mark consumed
      await db.prepare("UPDATE pairing_code SET consumed_at = ? WHERE id = ?").run(now, pairingRow.id);

      const deviceId = generateUlid("dev");
      // The account part routes later requests to this account's database (src/tenancy.ts).
      const rawToken = generateToken(deviceTokenPrefix(currentAccountId()));
      const tokenHash = sha256(rawToken);

      await db.prepare(`
        INSERT INTO extension_device (
          id, label, token_hash, paired_at, last_seen_at, user_agent, authenticated
        ) VALUES (?, ?, ?, ?, ?, ?, 0)
      `).run(
        deviceId,
        body.label!.trim().slice(0, 100),
        tokenHash,
        now,
        now,
        typeof body.userAgent === "string" ? body.userAgent.slice(0, 500) : null
      );

      return { deviceId, deviceToken: rawToken };
    });

    if (!result) {
      recordPairFailure(ip);
      return reply.code(401).send({
        error: { code: "invalid_code", message: "Invalid, expired, or already-consumed pairing code.", details: {} },
      });
    }

    return reply.code(201).send(result);
  });

  // GET /extension/whoami
  app.get("/extension/whoami", async (request, reply) => {
    const device = await requireExtensionDevice(request, reply);
    const db = app.db;
    const now = Date.now();

    const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as
      | { device_id: string | null; lease_until: number | null; grace_until: number | null }
      | undefined;

    const isSender =
      lease &&
      lease.device_id === device.id &&
      lease.lease_until != null &&
      lease.lease_until > now &&
      lease.grace_until == null;

    return reply.code(200).send({
      deviceId: device.id,
      label: device.label,
      sender: Boolean(isSender),
      leaseUntil: lease?.lease_until ? new Date(lease.lease_until).toISOString() : null,
      serverTime: new Date(now).toISOString(),
    });
  });

  // POST /extension/heartbeat
  app.post("/extension/heartbeat", async (request, reply) => {
    const device = await requireExtensionDevice(request, reply);
    const body = (request.body ?? {}) as {
      streamMode?: string;
      authenticated?: boolean;
      ownJid?: string;
      pushName?: string;
      extensionVersion?: string;
      bridgeVersion?: string;
    };

    const db = app.db;
    const now = Date.now();

    await db.prepare(`
      UPDATE extension_device
      SET
        last_seen_at = ?,
        stream_mode = COALESCE(?, stream_mode),
        authenticated = CASE WHEN ? IS NOT NULL THEN ? ELSE authenticated END,
        wa_jid = COALESCE(?, wa_jid),
        wa_pushname = COALESCE(?, wa_pushname),
        extension_version = COALESCE(?, extension_version),
        bridge_version = COALESCE(?, bridge_version)
      WHERE id = ?
    `).run(
      now,
      body.streamMode ?? null,
      body.authenticated != null ? 1 : null,
      body.authenticated ? 1 : 0,
      body.ownJid ?? null,
      body.pushName ?? null,
      body.extensionVersion ?? null,
      body.bridgeVersion ?? null,
      device.id
    );

    const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as
      | { device_id: string | null; lease_until: number | null; grace_until: number | null }
      | undefined;

    let role: "sender" | "grace" | "standby" = "standby";
    if (lease && lease.device_id === device.id) {
      if (lease.grace_until != null && lease.grace_until > now) {
        role = "grace";
      } else if (lease.lease_until != null && lease.lease_until > now) {
        role = "sender";
      }
    }

    return reply.code(200).send({
      ok: true,
      serverTime: new Date(now).toISOString(),
      role,
    });
  });

  // POST /extension/lease
  app.post("/extension/lease", async (request, reply) => {
    const device = await requireExtensionDevice(request, reply);
    const body = (request.body ?? {}) as { senderTab?: boolean };
    const senderTab = Boolean(body.senderTab);
    const db = app.db;
    const now = Date.now();

    const tx = () => db.transaction(async (): Promise<{ code: number; body: any }> => {
      const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as
        | { device_id: string | null; lease_until: number | null; grace_until: number | null }
        | undefined;

      if (senderTab) {
        // Case 1: senderTab: true and row is free, expired, or already this device: acquire/renew
        const isFree = !lease || !lease.device_id;
        const isExpired =
          lease &&
          lease.lease_until != null &&
          lease.lease_until < now &&
          (lease.grace_until == null || lease.grace_until <= now);
        const isThisDevice = lease && lease.device_id === device.id;

        if (isFree || isExpired || isThisDevice) {
          const leaseUntil = now + 30_000;
          await db.prepare(`
            UPDATE sender_lease
            SET device_id = ?, lease_until = ?, grace_until = NULL
            WHERE id = 1
          `).run(device.id, leaseUntil);

          return {
            code: 200,
            body: { role: "sender", leaseUntil: new Date(leaseUntil).toISOString() },
          };
        }

        // Case 2: senderTab: true and another device holds unexpired lease or grace: do not steal
        const holderGraceInFuture = lease && lease.grace_until != null && lease.grace_until > now;
        const holderLeaseUntil = holderGraceInFuture ? lease.grace_until! : lease.lease_until;

        return {
          code: 200,
          body: {
            role: "standby",
            holderDeviceId: lease.device_id,
            leaseUntil: holderLeaseUntil ? new Date(holderLeaseUntil).toISOString() : null,
          },
        };
      } else {
        // senderTab: false
        if (!lease || lease.device_id !== device.id) {
          // Case 3: senderTab: false and this device does not hold row: do not acquire
          return {
            code: 200,
            body: { role: "standby", holderDeviceId: null, leaseUntil: null },
          };
        }

        // This device holds the row
        if (lease.grace_until == null) {
          // Case 4: senderTab: false and grace_until is null: set grace_until = now + 30s
          const graceUntil = now + 30_000;
          await db.prepare(`
            UPDATE sender_lease
            SET grace_until = ?
            WHERE id = 1
          `).run(graceUntil);

          return {
            code: 200,
            body: { role: "grace", leaseUntil: new Date(graceUntil).toISOString() },
          };
        }

        if (lease.grace_until > now) {
          // Case 5: senderTab: false and grace_until > now: no-op, do not extend
          return {
            code: 200,
            body: { role: "grace", leaseUntil: new Date(lease.grace_until).toISOString() },
          };
        }

        // Case 6: senderTab: false and grace_until <= now: clear row
        await db.prepare(`
          UPDATE sender_lease
          SET device_id = NULL, lease_until = NULL, grace_until = NULL
          WHERE id = 1
        `).run();

        return {
          code: 200,
          body: { role: "standby", holderDeviceId: null, leaseUntil: null },
        };
      }
    });

    const res = await tx();
    return reply.code(res.code).send(res.body);
  });
};
