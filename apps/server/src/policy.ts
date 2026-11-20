export interface DeskPolicy {
  id: number;
  quiet_hours_enabled: number;
  quiet_start: string; // "HH:MM"
  quiet_end: string;   // "HH:MM"
  daily_automated_cap: number;
  daily_manual_cap: number;
  min_automated_gap_seconds: number;
  min_same_lead_gap_seconds: number;
  ai_hourly_cap: number;
  max_catchup_age_seconds: number;
  updated_at: number;
}

export interface OutboundCandidate {
  kind: "manual" | "scheduled" | "sequence" | "ai_reply";
  lead_id?: string | null;
  due_at: number;
  earliest_due_at?: number;
  allow_during_quiet_hours?: number | boolean;
}

// Convert epoch ms to "HH:MM" in timezone
export function getLocalTimeHHMM(ms: number, timezone: string): { hh: number; mm: number; stringVal: string } {
  const d = new Date(ms);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(d);
  let hh = 0;
  let mm = 0;
  for (const part of parts) {
    if (part.type === "hour") hh = parseInt(part.value, 10);
    if (part.type === "minute") mm = parseInt(part.value, 10);
  }
  if (hh === 24) hh = 0;
  const stringVal = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  return { hh, mm, stringVal };
}

// Parse "HH:MM" into minutes from start of day
function parseMinutes(hhmm: string): number {
  const [hStr, mStr] = hhmm.split(":");
  return parseInt(hStr || "0", 10) * 60 + parseInt(mStr || "0", 10);
}

export function quietHoursCover(nowMs: number, policy: DeskPolicy, timezone: string): boolean {
  if (!policy.quiet_hours_enabled) return false;

  const { stringVal } = getLocalTimeHHMM(nowMs, timezone);
  const currentMin = parseMinutes(stringVal);
  const startMin = parseMinutes(policy.quiet_start);
  const endMin = parseMinutes(policy.quiet_end);

  if (startMin === endMin) {
    return false; // zero-duration window
  }

  if (startMin < endMin) {
    // Window does not cross midnight (e.g. 13:00 to 17:00)
    return currentMin >= startMin && currentMin < endMin;
  } else {
    // Window crosses midnight (e.g. 21:00 to 08:00)
    return currentMin >= startMin || currentMin < endMin;
  }
}

export function nextOpenMinute(instantMs: number, policy: DeskPolicy, timezone: string): number {
  if (!quietHoursCover(instantMs, policy, timezone)) {
    return instantMs;
  }
  return nextOpenAtOrAfter(instantMs, policy, timezone);
}

export function nextOpenAtOrAfter(nowMs: number, policy: DeskPolicy, timezone: string): number {
  if (!quietHoursCover(nowMs, policy, timezone)) {
    return nowMs;
  }

  // Iterate minute by minute in steps of 60 seconds (bounded at 24 hours = 1440 mins)
  let testMs = Math.floor(nowMs / 60_000) * 60_000;
  for (let i = 0; i <= 1440; i++) {
    testMs += 60_000;
    if (!quietHoursCover(testMs, policy, timezone)) {
      return testMs;
    }
  }
  return nowMs;
}

export function msUntilLocalMidnight(nowMs: number, timezone: string): number {
  const d = new Date(nowMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);

  let hh = 0, mm = 0, ss = 0;
  for (const part of parts) {
    if (part.type === "hour") hh = parseInt(part.value, 10);
    if (part.type === "minute") mm = parseInt(part.value, 10);
    if (part.type === "second") ss = parseInt(part.value, 10);
  }
  if (hh === 24) hh = 0;

  const secondsPassed = hh * 3600 + mm * 60 + ss;
  const secondsInDay = 24 * 3600;
  const secondsRemaining = secondsInDay - secondsPassed;
  const ms = secondsRemaining * 1000 - (nowMs % 1000);
  return Math.max(ms, 1000);
}

export function gapBlocks(
  candidate: OutboundCandidate,
  nowMs: number,
  lastAutomatedSendMs: number | null,
  lastSameLeadSendMs: number | null,
  policy: DeskPolicy
): boolean {
  if (candidate.kind === "manual" || candidate.kind === "scheduled") {
    return false;
  }

  if (lastAutomatedSendMs != null) {
    const elapsedGlobal = nowMs - lastAutomatedSendMs;
    if (elapsedGlobal < policy.min_automated_gap_seconds * 1000) {
      return true;
    }
  }

  if (lastSameLeadSendMs != null) {
    const elapsedSameLead = nowMs - lastSameLeadSendMs;
    if (elapsedSameLead < policy.min_same_lead_gap_seconds * 1000) {
      return true;
    }
  }

  return false;
}

export function msUntilKindGap(
  candidate: OutboundCandidate,
  nowMs: number,
  lastAutomatedSendMs: number | null,
  lastSameLeadSendMs: number | null,
  policy: DeskPolicy
): number {
  if (candidate.kind === "manual" || candidate.kind === "scheduled") {
    return 0;
  }

  let remaining = 0;
  if (lastAutomatedSendMs != null) {
    const elapsed = nowMs - lastAutomatedSendMs;
    const needed = policy.min_automated_gap_seconds * 1000;
    if (elapsed < needed) {
      remaining = Math.max(remaining, needed - elapsed);
    }
  }

  if (lastSameLeadSendMs != null) {
    const elapsed = nowMs - lastSameLeadSendMs;
    const needed = policy.min_same_lead_gap_seconds * 1000;
    if (elapsed < needed) {
      remaining = Math.max(remaining, needed - elapsed);
    }
  }

  return remaining;
}

export function capBlocks(
  candidate: OutboundCandidate,
  dailyCounter: { automated_count: number; manual_count: number },
  policy: DeskPolicy
): boolean {
  if (candidate.kind === "sequence" || candidate.kind === "ai_reply") {
    return dailyCounter.automated_count >= policy.daily_automated_cap;
  }
  return dailyCounter.manual_count >= policy.daily_manual_cap;
}

export function olderThanCatchup(
  candidate: { due_at: number },
  nowMs: number,
  policy: DeskPolicy
): boolean {
  return nowMs - candidate.due_at > policy.max_catchup_age_seconds * 1000;
}
