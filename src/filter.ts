// Browsing and search for things you can track.
//
// The old picker was a text field and a dropdown, which asks you to already
// know the name of what you want. That is exactly the knowledge this site
// exists to supply: most people arrive wanting to know which benchmarks exist,
// not to look one up. So the list is now open by default, grouped by category,
// and typing narrows it rather than summoning it.
//
// Search is spelling-insensitive by construction. Both the query and every name
// collapse to letters and digits only, with the Greek tau and the superscript
// digits transliterated first, so "tau bench", "tau-bench", "taubench" and
// "τ²-bench" all reach the same rows. Beyond that there is a small edit-distance
// pass for real typos, and an initials pass so "tb" finds Terminal-Bench.

import { MAX_TRACKED, type Trackable } from "./model";

export interface FilterArgs {
  trackables: Map<string, Trackable>;
  categories: { id: string; name: string }[];
  tracked: string[];
  onToggle: (id: string) => void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Letters and digits only. Greek and superscripts first, because a lab writing
 *  τ²-bench and a reader typing "tau2 bench" mean the same evaluation. */
export const fold = (s: string): string =>
  s.toLowerCase()
    .replace(/τ/g, "tau").replace(/[²₂]/g, "2").replace(/[³₃]/g, "3").replace(/[¹₁]/g, "1")
    .replace(/[^a-z0-9]+/g, "");

const initials = (s: string): string =>
  (s.match(/[A-Za-z0-9]+/g) ?? []).map((w) => w[0].toLowerCase()).join("");

/** Bounded Levenshtein: stops as soon as the distance exceeds max, which keeps
 *  a full-list fuzzy pass cheap enough to run on every keystroke. */
function within(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Higher is better; 0 means no match. */
export function score(t: Trackable, q: string): number {
  if (!q) return 0;
  // A suite's display name carries ", all versions" so a chip can be told from
  // its headline version. Searching should not have to know that.
  const n = fold(t.name.replace(/, all versions$/, ""));
  if (n === q) return 1000;
  if (n.startsWith(q)) return 900 - n.length;
  const at = n.indexOf(q);
  if (at >= 0) return 700 - at;
  if (q.length >= 2 && initials(t.name).startsWith(q)) return 500;
  // Typos, and only for queries long enough that a near-miss means something.
  if (q.length >= 4) {
    const max = q.length >= 8 ? 2 : 1;
    const d = within(q, n.slice(0, q.length + max), max);
    if (d <= max) return 300 - d * 10;
  }
  return 0;
}

export function renderFilter(host: HTMLElement, a: FilterArgs): void {
  const full = a.tracked.length >= MAX_TRACKED;
  const all = [...a.trackables.values()];
  const catName = new Map(a.categories.map((c) => [c.id, c.name]));

  host.innerHTML = `
    <div class="browse">
      <div class="browse__field">
        <svg class="browse__icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>
        <input class="browse__input" type="search" autocomplete="off" spellcheck="false"
               placeholder="Search ${all.length.toLocaleString()} benchmarks, suites and categories"
               aria-label="Search benchmarks, suites and categories" />
        <button class="browse__clear" type="button" hidden aria-label="Clear search">&times;</button>
      </div>
      <div class="browse__tabs" role="tablist" aria-label="Browse by category"></div>
      <div class="browse__results" role="listbox" aria-label="Benchmarks"></div>
      <p class="browse__none" hidden></p>
    </div>
    <div class="chips" aria-live="polite"></div>`;

  const input = host.querySelector<HTMLInputElement>(".browse__input")!;
  const clear = host.querySelector<HTMLButtonElement>(".browse__clear")!;
  const tabs = host.querySelector<HTMLDivElement>(".browse__tabs")!;
  const results = host.querySelector<HTMLDivElement>(".browse__results")!;
  const none = host.querySelector<HTMLParagraphElement>(".browse__none")!;
  const chips = host.querySelector<HTMLDivElement>(".chips")!;

  let tab = "top";
  let q = "";

  const TABS = [{ id: "top", name: "Most cited" }, { id: "suites", name: "Suites" }, ...a.categories.filter((c) => c.id !== "other").map((c) => ({ id: `cat:${c.id}`, name: c.name }))];

  const paintTabs = () => {
    tabs.innerHTML = TABS.map((t) =>
      `<button type="button" role="tab" data-tab="${esc(t.id)}" aria-selected="${t.id === tab}">${esc(t.name)}</button>`
    ).join("");
  };

  const pool = (): Trackable[] => {
    if (q) {
      return all.map((t) => ({ t, s: score(t, q) })).filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s || y.t.lab_count - x.t.lab_count).slice(0, 36).map((x) => x.t);
    }
    if (tab === "top") return all.filter((t) => t.kind !== "category").sort((x, y) => y.lab_count - x.lab_count).slice(0, 24);
    if (tab === "suites") return all.filter((t) => t.kind === "suite").sort((x, y) => y.lab_count - x.lab_count);
    const id = tab.slice(4);
    const cat = all.find((t) => t.kind === "category" && t.id === `cat:${id}`);
    const members = all.filter((t) => t.kind === "benchmark" && t.categories?.includes(id))
      .sort((x, y) => y.lab_count - x.lab_count).slice(0, 24);
    return cat ? [cat, ...members] : members;
  };

  const paint = () => {
    const items = pool();
    none.hidden = items.length > 0;
    if (!items.length) none.textContent = `Nothing matches "${q}". Try fewer letters.`;
    results.innerHTML = items.map((t) => {
      const on = a.tracked.includes(t.id);
      const meta = t.kind === "suite" ? `Suite · ${t.members} versions`
        : t.kind === "category" ? `Category · ${t.members} benchmarks`
        : (t.categories ?? []).map((c) => catName.get(c) ?? c).join(" · ");
      return `<button type="button" role="option" class="bcard bcard--${t.kind}" data-id="${esc(t.id)}"
               aria-selected="${on}" ${!on && full ? "disabled" : ""}>
        <span class="bcard__name">${esc(t.name)}</span>
        <span class="bcard__meta">${esc(meta)}</span>
        <span class="bcard__n"><b>${t.lab_count}</b> lab${t.lab_count === 1 ? "" : "s"}</span>
      </button>`;
    }).join("");
  };

  const paintChips = () => {
    chips.innerHTML = a.tracked.length
      ? a.tracked.map((id, i) => {
          const t = a.trackables.get(id);
          return `<button type="button" class="chip s${i + 1}" data-id="${esc(id)}" aria-label="Stop tracking ${esc(t?.name ?? id)}">
            <span class="chip__dot" aria-hidden="true"></span>${esc(t?.name ?? id)}
            <span class="chip__x" aria-hidden="true">×</span></button>`;
        }).join("")
      : `<span class="chips__empty muted">Nothing tracked. Pick up to ${MAX_TRACKED} to compare.</span>`;
  };

  paintTabs(); paint(); paintChips();

  input.addEventListener("input", () => {
    q = fold(input.value);
    clear.hidden = !input.value;
    paint();
  });
  clear.addEventListener("click", () => { input.value = ""; q = ""; clear.hidden = true; paint(); input.focus(); });
  tabs.addEventListener("click", (e) => {
    const t = (e.target as Element).closest("[data-tab]")?.getAttribute("data-tab");
    if (!t) return;
    tab = t; paintTabs(); paint();
  });
  results.addEventListener("click", (e) => {
    const id = (e.target as Element).closest("[data-id]")?.getAttribute("data-id");
    if (id) a.onToggle(id);
  });
  chips.addEventListener("click", (e) => {
    const id = (e.target as Element).closest("[data-id]")?.getAttribute("data-id");
    if (id) a.onToggle(id);
  });
}
