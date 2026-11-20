import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { requireOperatorSession, sha256 } from "../auth.js";
import { generateUlid } from "@leaddesk/shared";
import { currentAccountId } from "../tenancy.js";

const CROCKFORD_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += CROCKFORD_CHARS[bytes[i]! % 32];
  }
  return code;
}

// Canonicalize Crockford base32 (uppercase, O->0, I/L->1)
export function canonicalizeCrockford(raw: string): string {
  return raw
    .toUpperCase()
    .trim()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

// Rate limiting: 10 pairing codes per hour
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const pairingCodeLimits = new Map<string, RateLimitEntry>();

function checkPairingCodeRateLimit(key = "global"): boolean {
  const now = Date.now();
  const entry = pairingCodeLimits.get(key);
  if (!entry || now > entry.resetAt) {
    pairingCodeLimits.set(key, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (entry.count >= 10) {
    return false;
  }
  entry.count++;
  return true;
}

export const pairingRoutes: FastifyPluginAsync = async (app) => {
  // POST /pairing-codes
  app.post("/pairing-codes", async (request, reply) => {
    const operator = await requireOperatorSession(request, reply);

    const accountId = currentAccountId();
    if (!checkPairingCodeRateLimit(accountId)) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: "Too many pairing codes generated. Try again later.", details: {} },
      });
    }

    const code = generatePairingCode();
    const codeHash = sha256(code);
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // 10 minutes
    const id = generateUlid("prc");

    await app.db.prepare(`
      INSERT INTO pairing_code (id, code_hash, expires_at, created_by_session_id)
      VALUES (?, ?, ?, ?)
    `).run(id, codeHash, expiresAt, request.cookies["leaddesk_session"] ? sha256(request.cookies["leaddesk_session"]!) : null);
    // The extension types only the code, so the control database remembers whose code it is.
    await app.control
      .prepare("INSERT OR REPLACE INTO pairing_route (code_hash, account_id, expires_at) VALUES (?, ?, ?)")
      .run(codeHash, accountId, expiresAt);

    return reply.code(201).send({
      code,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  });

  // GET /devices
  app.get("/devices", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const db = app.db;
    const now = Date.now();

    const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as
      | { device_id: string | null; lease_until: number | null; grace_until: number | null }
      | undefined;

    const rows = await db.prepare(`
      SELECT * FROM extension_device
      ORDER BY paired_at DESC
    `).all() as any[];

    const items = rows.map((row) => {
      const isSender =
        lease &&
        lease.device_id === row.id &&
        lease.lease_until != null &&
        lease.lease_until > now &&
        lease.grace_until == null;

      const inGrace =
        lease &&
        lease.device_id === row.id &&
        lease.grace_until != null &&
        lease.grace_until > now;

      let leaseUntil: string | null = null;
      if (lease && lease.device_id === row.id) {
        if (inGrace && lease.grace_until) {
          leaseUntil = new Date(lease.grace_until).toISOString();
        } else if (lease.lease_until) {
          leaseUntil = new Date(lease.lease_until).toISOString();
        }
      }

      return {
        id: row.id,
        label: row.label,
        pairedAt: new Date(row.paired_at).toISOString(),
        lastSeenAt: new Date(row.last_seen_at).toISOString(),
        revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        waPushName: row.wa_pushname,
        waJid: row.wa_jid,
        sender: Boolean(isSender),
        grace: Boolean(inGrace),
        leaseUntil,
      };
    });

    return reply.code(200).send({ items });
  });

  // POST /devices/:deviceId/revoke
  app.post("/devices/:deviceId/revoke", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { deviceId } = request.params as { deviceId: string };
    const db = app.db;
    const now = Date.now();

    const device = await db.prepare("SELECT * FROM extension_device WHERE id = ?").get(deviceId) as any;
    if (!device) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Device not found.", details: {} },
      });
    }

    await db.transaction(async () => {
      await db.prepare("UPDATE extension_device SET revoked_at = ? WHERE id = ?").run(now, deviceId);

      const lease = await db.prepare("SELECT * FROM sender_lease WHERE id = 1").get() as any;
      if (lease && lease.device_id === deviceId) {
        await db.prepare("UPDATE sender_lease SET device_id = NULL, lease_until = NULL, grace_until = NULL WHERE id = 1").run();
      }
    });

    return reply.code(200).send({
      id: deviceId,
      revokedAt: new Date(now).toISOString(),
    });
  });

  // POST /devices/:deviceId/sender
  app.post("/devices/:deviceId/sender", async (request, reply) => {
    await requireOperatorSession(request, reply);
    const { deviceId } = request.params as { deviceId: string };
    const db = app.db;
    const now = Date.now();

    const device = await db.prepare("SELECT * FROM extension_device WHERE id = ?").get(deviceId) as any;
    if (!device) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Device not found.", details: {} },
      });
    }

    if (device.revoked_at) {
      return reply.code(409).send({
        error: { code: "conflict", message: "Device is revoked.", details: {} },
      });
    }

    if (!device.last_seen_at || now - device.last_seen_at > 45_000) {
      return reply.code(409).send({
        error: { code: "stale_device", message: "Device has never heartbeated or is stale (>45s).", details: {} },
      });
    }

    const leaseUntil = now + 30_000;
    await db.prepare(`
      UPDATE sender_lease
      SET device_id = ?, lease_until = ?, grace_until = NULL
      WHERE id = 1
    `).run(deviceId, leaseUntil);

    return reply.code(200).send({
      deviceId,
      leaseUntil: new Date(leaseUntil).toISOString(),
    });
  });
};
