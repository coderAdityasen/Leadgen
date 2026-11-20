import { mkdirSync, existsSync, readdirSync, unlinkSync, createWriteStream, renameSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

export interface LogMeta {
  reqId?: string;
  route?: string;
  status?: number;
  ms?: number;
  deviceId?: string;
  leadId?: string;
  outboundId?: string;
  messageId?: string;
  bodyLength?: number;
  bodySha256?: string;
  [key: string]: any;
}

export type DeskEvent =
  | "desk.http.request"
  | "desk.operator.login_failed"
  | "desk.device.paired"
  | "desk.device.unauthorized"
  | "desk.device.heartbeat"
  | "desk.lease.acquired"
  | "desk.lease.denied"
  | "desk.inbound.stored"
  | "desk.ai.skipped"
  | "desk.ai.started"
  | "desk.ai.finished"
  | "desk.ai.failed"
  | "desk.outbound.claimed"
  | "desk.outbound.acked"
  | "desk.outbound.failed"
  | "desk.outbound.uncertain"
  | "desk.outbound.frozen";

export function sanitizeMeta(meta: LogMeta): LogMeta {
  const sanitized: LogMeta = { ...meta };

  // Never log sensitive fields
  delete sanitized["password"];
  delete sanitized["passwordHash"];
  delete sanitized["sessionToken"];
  delete sanitized["token"];
  delete sanitized["deviceToken"];
  delete sanitized["pairingCode"];
  delete sanitized["code"];
  delete sanitized["apiKey"];
  delete sanitized["bootstrapSecret"];

  // Replace full message body with length and sha256 if present
  if (typeof sanitized["body"] === "string") {
    sanitized.bodyLength = sanitized["body"].length;
    delete sanitized["body"];
  }

  return sanitized;
}

export function pruneOldLogs(logDir: string, maxFiles = 14): void {
  try {
    const files = readdirSync(logDir)
      .filter((f) => /^leaddesk-\d{8}\.log$/.test(f))
      .sort();

    while (files.length > maxFiles) {
      const oldest = files.shift()!;
      unlinkSync(join(logDir, oldest));
    }
  } catch {
    // Ignore prune errors
  }
}

export function createRotatingLogStream(logDir: string) {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const logFilePath = join(logDir, "leaddesk.log");
  return createWriteStream(logFilePath, { flags: "a" });
}

export function createDeskLogger(logDir = join(process.cwd(), "data/logs"), level = "info") {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const fileStream = createRotatingLogStream(logDir);
  pruneOldLogs(logDir, 14);

  const streams = [
    { stream: process.stdout },
    { stream: fileStream },
  ];

  return pino(
    {
      level: process.env["LOG_LEVEL"] || level,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams)
  );
}

export function logDeskEvent(
  logger: pino.Logger | any,
  event: DeskEvent,
  meta: LogMeta = {},
  level: "info" | "warn" | "error" | "debug" = "info"
): void {
  const clean = sanitizeMeta(meta);
  if (typeof logger[level] === "function") {
    logger[level]({ event, ...clean }, event);
  }
}
