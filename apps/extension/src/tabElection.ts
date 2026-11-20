export interface TabRecord {
  tabId: number;
  ready: boolean;
  authenticated: boolean;
  lastSeenAt: number;
  href: string;
}

export function isTabEligible(tab: TabRecord, now: number): boolean {
  if (!tab.href || !tab.href.startsWith("https://web.whatsapp.com/")) return false;
  if (!tab.ready || !tab.authenticated) return false;
  return now - tab.lastSeenAt < 8000;
}

export function computeHasEligibleTab(tabs: Iterable<TabRecord>, now: number): boolean {
  for (const tab of tabs) {
    if (isTabEligible(tab, now)) {
      return true;
    }
  }
  return false;
}

export function electSenderTab(
  tabs: Map<number, TabRecord>,
  currentSenderTabId: number | null,
  role: "sender" | "grace" | "standby" | null,
  now: number
): number | null {
  if (role !== "sender") {
    return null;
  }

  // Sticky check: if currentSenderTabId is still eligible, keep it!
  if (currentSenderTabId != null) {
    const current = tabs.get(currentSenderTabId);
    if (current && isTabEligible(current, now)) {
      return currentSenderTabId;
    }
  }

  // Find all eligible tabs and pick the one with lowest tabId
  const eligibleIds: number[] = [];
  for (const tab of tabs.values()) {
    if (isTabEligible(tab, now)) {
      eligibleIds.push(tab.tabId);
    }
  }

  if (eligibleIds.length === 0) {
    return null;
  }

  return Math.min(...eligibleIds);
}
