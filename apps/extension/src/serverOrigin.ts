/**
 * Which Lead Desk server addresses the extension may pair with.
 *
 * - The local desk over plain http on loopback (http://127.0.0.1:8787, http://[::1]:8787,
 *   http://localhost:8787).
 * - A remote desk (VPS) over https only, so the device token never crosses the network in
 *   clear text. The browser asks the operator to grant access to that one origin.
 */
export const LOOPBACK_ORIGINS = ["http://127.0.0.1:8787", "http://[::1]:8787", "http://localhost:8787"];

/** Normalize user input to a bare origin (scheme://host[:port]) or return an error message. */
export function parseServerOrigin(raw: string): { origin: string } | { error: string } {
  const input = raw.trim().replace(/\/+$/, "");
  if (!input) return { error: "Enter the Lead Desk server address." };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { error: "That is not a valid address." };
  }
  if (url.username || url.password) return { error: "The address must not contain a username or password." };
  if (url.pathname !== "/" || url.search || url.hash) {
    return { error: "Use only the site address, for example https://desk.example.com" };
  }
  const origin = url.origin;
  if (LOOPBACK_ORIGINS.includes(origin)) return { origin };
  if (url.protocol !== "https:") {
    return { error: "A remote server must use https:// (plain http is only allowed for this computer)." };
  }
  return { origin };
}

export const isLoopbackOrigin = (origin: string) => LOOPBACK_ORIGINS.includes(origin);

/** Match pattern for chrome.permissions, e.g. https://desk.example.com/* */
export const originPattern = (origin: string) => `${origin}/*`;
