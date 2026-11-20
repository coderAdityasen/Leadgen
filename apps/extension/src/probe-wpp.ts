// Runs in the MAIN world via chrome.scripting.executeScript({world:"MAIN"}).
// Records whether WPP already exists. Does not define or call WPP.
(globalThis as unknown as Record<string, unknown>)["__leadDeskForeignWpp"] =
  typeof (globalThis as { WPP?: unknown }).WPP !== "undefined";
