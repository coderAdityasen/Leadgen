// Tiny DOM helpers for the overlay. Text is always set with textContent / properties, never
// innerHTML, so lead names, notes and message bodies cannot inject markup.

export type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") {
        el.className = String(value);
      } else if (key === "style") {
        el.setAttribute("style", String(value));
      } else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), (event) => guard(() => (value as (e: Event) => void)(event)));
      } else if (key.startsWith("data-") || key.startsWith("aria-") || key === "role" || key === "title" || key === "for") {
        el.setAttribute(key, String(value));
      } else if (key in el) {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: (Child | Child[])[]) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

/** Run overlay code without ever letting an exception reach WhatsApp's page. */
export function guard(fn: () => unknown) {
  try {
    const out = fn();
    if (out && typeof (out as Promise<unknown>).catch === "function") {
      (out as Promise<unknown>).catch((err) => console.warn("[Lead Desk overlay]", err));
    }
  } catch (err) {
    console.warn("[Lead Desk overlay]", err);
  }
}

const ICONS: Record<string, string[]> = {
  chevronDown: ["M6 9l6 6 6-6"],
  chevronUp: ["M18 15l-6-6-6 6"],
  chevronLeft: ["M15 18l-6-6 6-6"],
  chevronRight: ["M9 18l6-6-6-6"],
  refresh: ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M21 21l-5-5"],
};

export function icon(name: keyof typeof ICONS | string, size = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Replace a container's children (blur handlers check renderState.replacing and skip), keeping focus, caret and typed value of the focused field
 * (matched by data-field) so a background refresh never eats what the operator is typing.
 */
export const renderState = { replacing: false };

export function replaceKeepingFocus(root: ShadowRoot, container: HTMLElement, next: (Child | Child[])[]) {
  const active = root.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const field = active && container.contains(active) ? active.getAttribute("data-field") : null;
  const saved =
    field && active
      ? {
          value: active.value,
          start: "selectionStart" in active ? active.selectionStart : null,
          end: "selectionEnd" in active ? active.selectionEnd : null,
        }
      : null;
  renderState.replacing = true;
  try {
    container.replaceChildren();
    append(container, next);
  } finally {
    renderState.replacing = false;
  }
  if (field && saved) {
    const again = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${CSS.escape(field)}"]`);
    if (again) {
      again.value = saved.value;
      again.focus({ preventScroll: true });
      try {
        if (saved.start != null && saved.end != null) again.setSelectionRange(saved.start, saved.end);
      } catch {
        // some input types do not support selection
      }
    }
  }
}
