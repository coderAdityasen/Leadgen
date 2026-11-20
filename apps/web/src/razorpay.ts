/** Dynamic loader + minimal typings for Razorpay Checkout (subscriptions). */

export interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}

export interface RazorpayOptions {
  key: string;
  subscription_id: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string };
  theme?: { color?: string };
  handler: (resp: RazorpaySuccess) => void | Promise<void>;
  modal?: { ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
  on?: (event: string, cb: (resp: unknown) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

const SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
let loading: Promise<void> | null = null;

/** Loads checkout.js once. A failed load is forgotten so the next call retries. */
export function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (window.Razorpay) resolve();
      else {
        script.remove();
        loading = null;
        reject(new Error("Razorpay Checkout did not initialise."));
      }
    };
    script.onerror = () => {
      script.remove();
      loading = null;
      reject(new Error("Could not load Razorpay Checkout. Check your connection or ad-blocker and try again."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** The app's primary colour (CSS token), for the Checkout theme. */
export function primaryColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  return v || "#4f46e5";
}
