// Applies the saved/preferred colour theme before first paint to avoid a
// light-mode flash. Loaded as an external file so it works under a strict
// `script-src 'self'` CSP (no inline scripts). Keep in sync with src/theme.ts.
(function () {
  try {
    var stored = localStorage.getItem("leaddesk.theme");
    var dark =
      stored === "dark" ||
      (stored !== "light" &&
        !!window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch (e) {
    /* storage unavailable: fall back to light until the app boots */
  }
})();
