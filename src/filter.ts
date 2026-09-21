// Benchmark picker.
//
// The list is browsable before you type anything. With 2355 benchmarks, a
// search-only field asks you to already know what you are looking for, which is
// exactly the knowledge this site exists to supply. Opening to the most widely
// cited ones answers "what should I even track" on the first click.

import { MAX_TRACKED, type Benchmark } from "./model";

export interface FilterArgs {
  benchmarks: Benchmark[];
  names: Map<string, string>;
  tracked: string[];
  onToggle: (id: string) => void;
}

let outsideBound = false;
let suppressNextOutside = false;
let outsideClose: (() => void) | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function renderFilter(host: HTMLElement, a: FilterArgs): void {
  const full = a.tracked.length >= MAX_TRACKED;

  host.innerHTML = `
    <div class="pick">
      <div class="pick__field">
        <svg class="pick__icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>
        <input class="pick__input" type="text" role="combobox" aria-expanded="false" aria-controls="pick-list"
               placeholder="${full ? `Tracking ${MAX_TRACKED}, the maximum` : "Track a benchmark"}"
               autocomplete="off" ${full ? "disabled" : ""} />
        <kbd class="pick__hint">${a.benchmarks.length.toLocaleString()}</kbd>
      </div>
      <ul class="pick__list" id="pick-list" role="listbox" hidden></ul>
    </div>
    <div class="chips" aria-live="polite"></div>`;

  const input = host.querySelector<HTMLInputElement>(".pick__input")!;
  const list = host.querySelector<HTMLUListElement>(".pick__list")!;
  const chips = host.querySelector<HTMLDivElement>(".chips")!;
  let active = -1;

  const matches = (q: string): Benchmark[] => {
    const needle = q.trim().toLowerCase();
    const pool = a.benchmarks.filter((b) => !a.tracked.includes(b.id));
    if (!needle) return pool.slice(0, 40);                 // already sorted by reach
    return pool.filter((b) => (a.names.get(b.id) ?? b.id).toLowerCase().includes(needle)).slice(0, 40);
  };

  const paint = () => {
    const hits = matches(input.value);
    active = hits.length ? Math.min(Math.max(active, 0), hits.length - 1) : -1;
    list.innerHTML = hits.length
      ? hits.map((b, i) => `
          <li role="option" aria-selected="${i === active}" class="${i === active ? "on" : ""}">
            <button type="button" data-id="${esc(b.id)}">
              <span class="pick__name">${esc(a.names.get(b.id) ?? b.id)}</span>
              <span class="pick__meta"><span class="pick__reach">${b.lab_count}</span> lab${b.lab_count === 1 ? "" : "s"}, ${b.first_seen.slice(0, 4)} to ${b.last_seen.slice(0, 4)}</span>
            </button>
          </li>`).join("")
      : `<li class="pick__none">No benchmark matches that.</li>`;
    if (active >= 0) list.children[active]?.scrollIntoView({ block: "nearest" });
  };

  const open = () => { if (input.disabled) return; list.hidden = false; input.setAttribute("aria-expanded", "true"); paint(); };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };

  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("input", () => { active = 0; open(); });
  input.addEventListener("keydown", (e) => {
    const n = list.querySelectorAll("li[role=option]").length;
    if (e.key === "ArrowDown") { e.preventDefault(); active = n ? (active + 1) % n : -1; paint(); open(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = n ? (active - 1 + n) % n : -1; paint(); }
    else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      const id = list.children[active]?.querySelector("button")?.getAttribute("data-id");
      if (id) { input.value = ""; a.onToggle(id); }
    } else if (e.key === "Escape") { close(); input.blur(); }
  });

  list.addEventListener("mousedown", (e) => {
    const id = (e.target as Element).closest("button")?.getAttribute("data-id");
    if (!id) return;
    e.preventDefault();
    // The document-level handler fires after this one, by which point the
    // re-render has replaced .pick and the clicked button is detached, so it
    // would read as an outside click and shut the list the re-focus just
    // reopened. Skip exactly that one event.
    suppressNextOutside = true;
    input.value = "";
    a.onToggle(id);
  });

  // Registered once for the lifetime of the page, not per render. The earlier
  // version used { once: true }, which the very mousedown that opened the
  // picker consumed, leaving it impossible to dismiss by clicking away.
  outsideClose = () => close();
  if (!outsideBound) {
    document.addEventListener("mousedown", (e) => {
      if (suppressNextOutside) { suppressNextOutside = false; return; }
      const panel = document.querySelector(".pick");
      if (panel && !panel.contains(e.target as Node)) outsideClose?.();
    });
    outsideBound = true;
  }

  chips.innerHTML = a.tracked.length
    ? a.tracked.map((id, i) => `
        <button class="chip s${i + 1}" type="button" data-id="${esc(id)}">
          <span class="chip__dot" aria-hidden="true"></span>${esc(a.names.get(id) ?? id)}
          <span class="chip__x" aria-hidden="true">×</span><span class="vh">, stop tracking</span>
        </button>`).join("")
    : `<span class="muted chips__empty">Nothing tracked. Pick up to ${MAX_TRACKED} to compare their arcs.</span>`;

  chips.addEventListener("click", (e) => {
    const id = (e.target as Element).closest("button")?.getAttribute("data-id");
    if (id) a.onToggle(id);
  });
}
