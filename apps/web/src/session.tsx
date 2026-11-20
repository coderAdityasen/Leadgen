import { createContext, useContext } from "react";
import type { Me } from "./types.js";

interface SessionState {
  /** null while loading (or on public pages). */
  me: Me | null;
  /** Re-fetch GET /me (e.g. after a payment, so the billing banner updates). */
  reloadMe: () => Promise<void>;
}

export const SessionContext = createContext<SessionState>({
  me: null,
  reloadMe: async () => {},
});

export function useSession() {
  return useContext(SessionContext);
}

/** Paths that must work while logged out. */
export function isPublicPath(path: string): boolean {
  return path === "/login";
}
