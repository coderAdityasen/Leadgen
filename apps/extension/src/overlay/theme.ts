// Follow WhatsApp Web's theme. WhatsApp puts `dark` on <body> when its dark theme is on
// (including "system default" resolving to dark). Before WhatsApp has rendered, fall back
// to the OS preference so the loading state does not flash the wrong palette.

function whatsAppRendered(): boolean {
  const app = document.getElementById("app");
  return Boolean(app && app.childElementCount > 0);
}

export function isDarkNow(): boolean {
  if (document.body?.classList.contains("dark")) return true;
  if (whatsAppRendered()) return false;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** Calls `onChange` whenever the effective theme flips. Returns a stop function. */
export function watchTheme(onChange: (dark: boolean) => void): () => void {
  let last = isDarkNow();
  const check = () => {
    const next = isDarkNow();
    if (next !== last) {
      last = next;
      onChange(next);
    }
  };
  const observer = new MutationObserver(check);
  if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  let media: MediaQueryList | null = null;
  try {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", check);
  } catch {
    media = null;
  }
  // WhatsApp may render its first frame after us; re-check a few times while it boots.
  const boot = setInterval(check, 2000);
  const bootStop = setTimeout(() => clearInterval(boot), 60_000);
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", check);
    clearInterval(boot);
    clearTimeout(bootStop);
  };
}
