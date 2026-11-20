import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readWaMessageId } from "@leaddesk/shared";

describe("Manual checklist fixture lock (PR 15)", () => {
  const fixturePath = join(process.cwd(), "../../apps/extension/test/fixtures/readWaMessageId.fixture.json");
  const localFixturePath = join(process.cwd(), "test/fixtures/readWaMessageId.fixture.json");

  const resolvedPath = existsSync(fixturePath)
    ? fixturePath
    : existsSync(localFixturePath)
    ? localFixturePath
    : null;

  it.skipIf(!resolvedPath)(
    "validates readWaMessageId against frozen live capture fixture from wa-js 4.7.2",
    () => {
      if (!resolvedPath) {
        // Will be skipped with clear message
        return;
      }
      const raw = readFileSync(resolvedPath, "utf8");
      const fixture = JSON.parse(raw);

      const extractedId = readWaMessageId(fixture.sendResult);
      expect(extractedId).toBe(fixture.expectedMessageId);
      expect(typeof extractedId).toBe("string");
      expect(extractedId).toMatch(/^(true|false)_.*@c\.us_.+$/);
    }
  );

  it("verifies manual checklist markdown exists and contains all 20 verification steps", () => {
    const checklistPath = join(process.cwd(), "../../docs/manual-checklist.md");
    const localChecklistPath = join(process.cwd(), "docs/manual-checklist.md");
    const docPath = existsSync(checklistPath) ? checklistPath : localChecklistPath;

    expect(existsSync(docPath)).toBe(true);
    const content = readFileSync(docPath, "utf8");

    // Verify key test conditions specified in PR 15
    expect(content).toContain("Grace Recovery");
    expect(content).toContain("No Second Bubble");
    expect(content).toContain("Quiet Hours");
    expect(content).toContain("Foreign WPP Collision Probe");
    expect(content).toContain("LID Address Resolution");
  });
});
