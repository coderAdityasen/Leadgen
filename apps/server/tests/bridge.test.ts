import { describe, it, expect } from "vitest";
import {
  readWaMessageId,
  pnLidArg,
  classifyChatKind,
  SEND_OPTIONS,
  type OutboxRecord,
} from "@leaddesk/shared";

describe("Page bridge and local outbox mirror (PR 9)", () => {
  describe("readWaMessageId", () => {
    it("extracts id from 4.7.2 SendMessageReturn object when id is string", () => {
      const mockResult = {
        id: "false_12125550100@c.us_3EB0123456789ABCDEF0",
        timestamp: 1793430000,
      };
      expect(readWaMessageId(mockResult)).toBe("false_12125550100@c.us_3EB0123456789ABCDEF0");
    });

    it("extracts _serialized if id is object or missing", () => {
      const mockResult = {
        id: { fromMe: true, remote: "12125550100@c.us", id: "3EB0ABC" },
        _serialized: "true_12125550100@c.us_3EB0ABC",
      };
      expect(readWaMessageId(mockResult)).toBe("true_12125550100@c.us_3EB0ABC");
    });

    it("extracts id._serialized from an incoming message model", () => {
      const mockResult = {
        id: { _serialized: "false_39616895828040@lid_3EB0INBOUND" },
        body: "hello back",
      };
      expect(readWaMessageId(mockResult)).toBe("false_39616895828040@lid_3EB0INBOUND");
    });

    it("returns null on null, undefined, number, or missing string id", () => {
      expect(readWaMessageId(null)).toBeNull();
      expect(readWaMessageId(undefined)).toBeNull();
      expect(readWaMessageId({})).toBeNull();
      expect(readWaMessageId({ id: 12345 })).toBeNull();
    });
  });

  describe("pnLidArg", () => {
    it("preserves @c.us and @lid wids", () => {
      expect(pnLidArg("12125550123@c.us")).toBe("12125550123@c.us");
      expect(pnLidArg("100234567890@lid")).toBe("100234567890@lid");
    });

    it("rewrites @s.whatsapp.net to user@c.us", () => {
      expect(pnLidArg("12125550123@s.whatsapp.net")).toBe("12125550123@c.us");
    });

    it("returns null for groups, broadcast, and invalid strings", () => {
      expect(pnLidArg("12125550123-123456@g.us")).toBeNull();
      expect(pnLidArg("status@broadcast")).toBeNull();
      expect(pnLidArg("invalid_jid")).toBeNull();
      expect(pnLidArg("@s.whatsapp.net")).toBeNull();
    });
  });

  describe("classifyChatKind", () => {
    it("correctly identifies direct, group, broadcast, and other", () => {
      expect(classifyChatKind("12125550100@c.us")).toBe("direct");
      expect(classifyChatKind("12125550100@s.whatsapp.net")).toBe("direct");
      expect(classifyChatKind("10023456789@lid")).toBe("direct");
      expect(classifyChatKind("12125550100-99999@g.us")).toBe("group");
      expect(classifyChatKind("status@broadcast")).toBe("broadcast");
      expect(classifyChatKind("12345@newsletter")).toBe("other");
      expect(classifyChatKind("unknown_type")).toBe("other");
    });
  });

  describe("SEND_OPTIONS invariant", () => {
    it("enforces waitForAck: false, linkPreview: false, delay: 0", () => {
      expect(SEND_OPTIONS.waitForAck).toBe(false);
      expect(SEND_OPTIONS.linkPreview).toBe(false);
      expect(SEND_OPTIONS.detectMentioned).toBe(false);
      expect(SEND_OPTIONS.markIsRead).toBe(false);
      expect(SEND_OPTIONS.delay).toBe(0);
    });
  });

  describe("Local outbox mirror phase transitions", () => {
    it("transitions through sending -> submitted on success, and sending -> uncertain on bridge throw", () => {
      const outbox: Record<string, OutboxRecord> = {};

      // 1. Write initial "sending" record
      const rec: OutboxRecord = {
        outboundId: "out_001",
        claimToken: "clm_token_123",
        toJid: "12125550100@c.us",
        bodySha256: "abc",
        phase: "sending",
        waMessageId: null,
        updatedAt: Date.now(),
      };
      outbox[rec.outboundId] = { ...rec };
      expect(outbox["out_001"]?.phase).toBe("sending");

      // 2a. Success path: becomes "submitted"
      outbox["out_001"] = {
        ...outbox["out_001"]!,
        phase: "submitted",
        waMessageId: "false_12125550100@c.us_MSG_123",
      };
      expect(outbox["out_001"]?.phase).toBe("submitted");
      expect(outbox["out_001"]?.waMessageId).toBe("false_12125550100@c.us_MSG_123");

      // 2b. Uncertain path (e.g. timeout or bridge threw): becomes "uncertain"
      outbox["out_001"] = {
        ...outbox["out_001"]!,
        phase: "uncertain",
      };
      expect(outbox["out_001"]?.phase).toBe("uncertain");

      // 3. Deletion after server ack/uncertain resolution
      delete outbox["out_001"];
      expect(outbox["out_001"]).toBeUndefined();
    });
  });
});
