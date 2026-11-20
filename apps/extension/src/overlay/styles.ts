export const BAR_HEIGHT = 48;
export const PANEL_WIDTH = 340;
export const PANEL_SLIM = 36;

export const PAGE_STYLE_ID = "leaddesk-overlay-layout";

/**
 * The only CSS this extension puts on WhatsApp's own DOM: it shrinks the #app root so the
 * bar and panel never cover WhatsApp. Removing the <style> element restores WhatsApp exactly.
 */
export function pageLayoutCss(rightPx: number): string {
  return `#app{position:fixed!important;top:${BAR_HEIGHT}px!important;left:0!important;right:${rightPx}px!important;bottom:0!important;width:auto!important;height:auto!important;min-width:0!important;overflow:hidden!important;}`;
}

/** Distinct, readable stage colors (white text on all of them), cycled by stage position. */
export const STAGE_COLORS = [
  "#4f46e5",
  "#0284c7",
  "#0d9488",
  "#d97706",
  "#16a34a",
  "#db2777",
  "#7c3aed",
  "#dc2626",
  "#0891b2",
  "#475569",
];

export const SHADOW_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.root {
  --bg: #ffffff; --bg-subtle: #f1f5f9; --bg-hover: #e2e8f0; --text: #0f172a; --muted: #64748b;
  --line: #e2e8f0; --line-strong: #cbd5e1; --primary: #4f46e5; --primary-hover: #4338ca;
  --primary-soft: #eef2ff; --danger: #dc2626; --danger-soft: #fef2f2; --ok: #16a34a; --shadow: 0 10px 30px rgba(15,23,42,.18);
  font: 13px/1.45 "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
.root.dark {
  --bg: #111b21; --bg-subtle: #1b262d; --bg-hover: #23323b; --text: #e9edef; --muted: #8696a0;
  --line: #24323b; --line-strong: #33454f; --primary: #818cf8; --primary-hover: #a5b4fc;
  --primary-soft: rgba(129,140,248,.14); --danger: #f87171; --danger-soft: rgba(248,113,113,.12); --ok: #4ade80; --shadow: 0 10px 30px rgba(0,0,0,.5);
}
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: .55; }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }

/* ---------- top bar ---------- */
.bar {
  position: fixed; top: 0; left: 0; right: 0; height: ${BAR_HEIGHT}px; z-index: 2;
  display: flex; align-items: center; gap: 10px; padding: 0 8px 0 10px;
  background: var(--bg); border-bottom: 1px solid var(--line); pointer-events: auto;
}
.mark { display: flex; align-items: center; gap: 7px; flex: none; font-weight: 700; font-size: 13px; letter-spacing: .1px; }
.mark-logo {
  width: 26px; height: 26px; border-radius: 7px; background: var(--primary); color: #fff;
  display: grid; place-items: center; font-size: 12px; font-weight: 800;
}
.root.dark .mark-logo { color: #111b21; }
.stages { flex: 1; min-width: 0; display: flex; align-items: center; overflow-x: auto; scrollbar-width: none; padding: 0 2px; }
.stages::-webkit-scrollbar { display: none; }
.stage {
  position: relative; flex: none; height: 36px; min-width: 104px; max-width: 170px; margin-left: -6px;
  padding: 0 18px 0 20px; border: 0; color: #fff; text-align: left;
  display: flex; flex-direction: column; justify-content: center;
  clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%, 12px 50%);
  transition: filter .12s ease, transform .12s ease;
}
.stage:first-child { margin-left: 0; padding-left: 12px; clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%); border-radius: 6px 0 0 6px; }
.stage:hover { filter: brightness(1.08); }
.stage.all { background: #334155; }
.root.dark .stage.all { background: #3b4a54; }
.stage.active { box-shadow: inset 0 -3px 0 rgba(255,255,255,.95); filter: saturate(1.15); }
.stage.active .name { opacity: 1; font-weight: 700; }
.stage .count { font-size: 15px; font-weight: 700; line-height: 1.05; }
.stage .name { font-size: 11px; opacity: .92; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-status { flex: none; font-size: 12px; color: var(--muted); white-space: nowrap; max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.bar-status.err { color: var(--danger); }
.bar-action {
  flex: none; height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line-strong);
  background: var(--bg); color: var(--primary); font-size: 12px; font-weight: 600; white-space: nowrap;
}
.bar-action:hover { background: var(--primary-soft); }
.icon-btn {
  flex: none; width: 30px; height: 30px; border-radius: 8px; border: 1px solid transparent;
  background: transparent; color: var(--muted); display: grid; place-items: center;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.spin svg { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* minimized pill */
.pill {
  position: fixed; top: 0; left: 50%; transform: translateX(-50%); z-index: 3; pointer-events: auto;
  display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 10px 0 8px;
  border: 1px solid var(--line-strong); border-top: 0; border-radius: 0 0 8px 8px;
  background: var(--bg); color: var(--text); font-size: 11px; font-weight: 600; box-shadow: var(--shadow);
}
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); }

/* ---------- stage-filtered chat list (sits over WhatsApp's chat column) ---------- */
.chatlist {
  position: fixed; z-index: 1; pointer-events: auto; display: flex; flex-direction: column;
  background: var(--bg); border-right: 1px solid var(--line); overflow: hidden;
}
.cl-head-wrap { flex: none; border-bottom: 1px solid var(--line); }
.cl-head { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 10px 0 16px; }
.cl-swatch { width: 12px; height: 12px; border-radius: 4px; flex: none; }
.cl-title { font-size: 17px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cl-count { flex: 1; color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.cl-back {
  flex: none; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px;
  border-radius: 999px; border: 1px solid var(--line-strong); background: var(--bg); color: var(--text); font-size: 12px; font-weight: 600;
}
.cl-back:hover { background: var(--bg-hover); }
.cl-search { position: relative; padding: 0 12px 10px; }
.cl-search svg { position: absolute; left: 24px; top: 9px; color: var(--muted); pointer-events: none; }
.cl-search input[type=search] { padding: 7px 10px 7px 36px; border-radius: 8px; border-color: transparent; background: var(--bg-subtle); }
.cl-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
.cl-row {
  width: 100%; display: flex; align-items: center; gap: 13px; padding: 0 14px 0 13px; height: 72px;
  border: 0; background: transparent; text-align: left;
}
.cl-row:hover:not(:disabled) { background: var(--bg-subtle); }
.cl-row.active { background: var(--bg-hover); }
.cl-row.opening { opacity: .65; }
.cl-avatar {
  width: 49px; height: 49px; border-radius: 50%; flex: none; object-fit: cover;
  display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 16px;
}
.cl-main { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 3px; border-bottom: 1px solid var(--line); }
.cl-row:last-child .cl-main { border-bottom: 0; }
.cl-top, .cl-bottom { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cl-name { flex: 1; min-width: 0; font-size: 16px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cl-time { flex: none; font-size: 12px; color: var(--muted); }
.cl-time.unread { color: #1daa61; font-weight: 600; }
.cl-preview { flex: 1; min-width: 0; font-size: 13.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cl-me { color: var(--muted); font-weight: 600; }
.cl-tag { flex: none; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line-strong); color: var(--muted); }
.cl-tag.danger { color: var(--danger); border-color: var(--danger); }
.cl-unread {
  flex: none; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: #1daa61; color: #fff;
  font-size: 11.5px; font-weight: 700; display: grid; place-items: center;
}
.root.dark .cl-unread { color: #111b21; }
.cl-unread.dot { min-width: 12px; width: 12px; height: 12px; padding: 0; }
.cl-empty { padding: 28px 18px; color: var(--muted); text-align: center; }

/* ---------- side panel ---------- */
.panel {
  position: fixed; top: ${BAR_HEIGHT}px; right: 0; bottom: 0; width: ${PANEL_WIDTH}px; z-index: 1; pointer-events: auto;
  display: flex; flex-direction: column; background: var(--bg); border-left: 1px solid var(--line);
}
.panel.slim { width: ${PANEL_SLIM}px; align-items: center; padding-top: 8px; }
.slim-label {
  margin-top: 10px; writing-mode: vertical-rl; transform: rotate(180deg); font-size: 11px; font-weight: 600;
  color: var(--muted); letter-spacing: .4px; border: 0; background: transparent; padding: 6px 0;
}
.panel-head { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 8px 0 14px; border-bottom: 1px solid var(--line); flex: none; }
.panel-head .title { flex: 1; font-weight: 700; font-size: 13.5px; }
.panel-body { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.empty { margin: 32px 6px; text-align: center; color: var(--muted); line-height: 1.6; }
.empty strong { display: block; color: var(--text); font-size: 14px; margin-bottom: 4px; }

.section { display: flex; flex-direction: column; gap: 10px; }
.section + .section { border-top: 1px solid var(--line); padding-top: 14px; }
.section-title { font-size: 11px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 8px; }
.section-title .grow { flex: 1; }
.row { display: grid; grid-template-columns: 92px 1fr; align-items: center; gap: 8px; }
.row > label, .row > .lbl { color: var(--muted); font-size: 12.5px; }
.field-wrap { display: flex; align-items: center; gap: 6px; min-width: 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

input[type=text], input[type=email], input[type=search], select, textarea {
  width: 100%; min-width: 0; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--bg-subtle);
  padding: 6px 9px; outline: none; transition: border-color .12s ease, background .12s ease;
}
input:focus, select:focus, textarea:focus { border-color: var(--primary); background: var(--bg); }
select { appearance: auto; }
textarea { resize: vertical; min-height: 84px; line-height: 1.45; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px;
  border-radius: 8px; border: 1px solid var(--line-strong); background: var(--bg); font-weight: 600; white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--bg-hover); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.root.dark .btn.primary { color: #111b21; }
.btn.primary:hover:not(:disabled) { background: var(--primary-hover); }
.btn.danger { color: var(--danger); border-color: var(--danger); background: transparent; }
.btn.danger.confirm { background: var(--danger); color: #fff; }
.btn.block { width: 100%; }
.btn.sm { height: 28px; padding: 0 10px; font-size: 12px; }

.switch-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.switch-row .lbl { font-weight: 600; }
.switch-row .hint { font-size: 11.5px; color: var(--muted); }
.switch { position: relative; width: 38px; height: 22px; flex: none; }
.switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.switch .track { position: absolute; inset: 0; border-radius: 999px; background: var(--line-strong); transition: background .15s ease; pointer-events: none; }
.switch .track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s ease; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.switch input:checked + .track { background: var(--primary); }
.switch input:checked + .track::after { transform: translateX(16px); }
.switch input:focus-visible + .track { outline: 2px solid var(--primary); outline-offset: 2px; }
.switch input:disabled { cursor: default; }
.switch input:disabled + .track { opacity: .5; }

.badges { display: flex; flex-wrap: wrap; gap: 6px; }
.badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; border: 1px solid var(--line-strong); color: var(--muted); }
.badge.danger { color: var(--danger); border-color: var(--danger); background: var(--danger-soft); }
.badge.stage-badge { color: #fff; border: 0; }

.callout { border: 1px solid var(--line); background: var(--bg-subtle); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.callout .k { font-size: 11.5px; color: var(--muted); }
.callout .v { font-weight: 600; }
.next-body { font-size: 12.5px; color: var(--text); white-space: pre-wrap; word-break: break-word; max-height: 90px; overflow: hidden; }
.error { color: var(--danger); background: var(--danger-soft); border: 1px solid var(--danger); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; display: flex; gap: 8px; align-items: flex-start; }
.error span { flex: 1; }
.error button { border: 0; background: transparent; color: inherit; padding: 0; }
.saved { font-size: 11.5px; color: var(--ok); font-weight: 600; text-transform: none; letter-spacing: 0; }
.saving { font-size: 11.5px; color: var(--muted); font-weight: 600; text-transform: none; letter-spacing: 0; }
.contact-name { font-size: 15px; font-weight: 700; word-break: break-word; }
.muted { color: var(--muted); }
details.more > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; font-weight: 600; }
details.more > summary::-webkit-details-marker { display: none; }
details.more > summary svg { transition: transform .15s ease; }
details.more[open] > summary svg { transform: rotate(180deg); }
details.more .inner { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.link { display: inline-flex; align-items: center; gap: 6px; color: var(--primary); text-decoration: none; font-weight: 600; }
.link:hover { text-decoration: underline; }
.skeleton { height: 14px; border-radius: 6px; background: var(--bg-hover); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .5; } }
`;
