import { useState } from "react";
import { Link } from "../router.js";
import { formatDate } from "../format.js";
import type { BillingSummary } from "../types.js";

const DISMISS_KEY = "leaddesk.graceBannerDismissed";

function readDismissed(graceEndsAt: string | null): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === String(graceEndsAt);
  } catch {
    return false;
  }
}

/**
 * Compact app-shell banner from /me.billing.
 * grace: amber, dismissable for this browser session. expired: red, not dismissable.
 * (suspended accounts are refused at login, so nothing is shown here for them.)
 */
export function BillingBanner({ billing, onBillingPage }: { billing: BillingSummary; onBillingPage: boolean }) {
  const [dismissed, setDismissed] = useState(() => readDismissed(billing.graceEndsAt));

  if (billing.state === "grace") {
    if (dismissed) return null;
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-5 rounded-xl px-4 py-2.5 text-sm border bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/50 dark:border-amber-900 dark:text-amber-200"
      >
        <span className="font-semibold">
          Payment overdue. WhatsApp sending stops on {formatDate(billing.graceEndsAt)}.
        </span>
        {!onBillingPage && (
          <Link href="/billing" className="font-bold underline underline-offset-2">
            Pay now
          </Link>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          className="ml-auto opacity-60 hover:opacity-100 text-xs font-bold"
          onClick={() => {
            try {
              sessionStorage.setItem(DISMISS_KEY, String(billing.graceEndsAt));
            } catch {
              // ignore
            }
            setDismissed(true);
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  if (billing.state === "expired") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-5 rounded-xl px-4 py-2.5 text-sm border bg-rose-50 border-rose-200 text-rose-900 dark:bg-rose-950/50 dark:border-rose-900 dark:text-rose-200"
      >
        <span className="font-semibold">Your plan has expired. WhatsApp messages are not being sent.</span>
        {!onBillingPage && (
          <Link href="/billing" className="font-bold underline underline-offset-2">
            Choose a plan
          </Link>
        )}
      </div>
    );
  }

  return null;
}
