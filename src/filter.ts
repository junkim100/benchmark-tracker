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
  recentLabel: string;           // the window the share is measured over
  sinceLabel: string;            // when the all-time count starts
  tracked: string[];
  onToggle: (id: string) => void;
}

// Folded shut on arrival, so the chart and the timeline are the first things
// on the page rather than a wall of cards. Held outside the render because
// tracking something redraws this and must not close what the reader opened.
let open = false;
// Outside the render, like `open`, and for the same reason. Both used to be
// locals, so every redraw reset them: a window resize wiped the search text and
// sent the reader back to "Most cited", and on a phone that fires on rotation.
// main.ts tried to restore them by reading the DOM and replaying a click, which
// could not work during a search, because no tab is selected then by design.
// Three separate axes, because they used to be one. The tab strip mixed a
// ranking ("Most cited"), a kind of thing ("Suites") and eleven subjects into
// one row, so there was no way to ask for the most cited coding benchmark, and
// no way to tell why those three sorts of chip sat side by side. Subject says
// what you want to look at, sort says how to order it, grouping says whether a
// suite stands for its versions or they all stand for themselves.
let subject = "all";
let sort: "labs" | "recent" = "labs";
let grouped = true;
let query = "";
let rawQuery = "";
// The card the reader last acted on, so focus can be put back on it after the
// re-render that acting on it causes.
let lastPicked: string | null = null;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Letters and digits only. Greek and superscripts first, because a lab writing
 *  τ²-bench and a reader typing "tau2 bench" mean the same evaluation. */
export const fold = (s: string): string =>
  s.toLowerCase()
    .replace(/τ/g, "tau").replace(/[²₂]/g, "2").replace(/[³₃]/g, "3").replace(/[¹₁]/g, "1")
    .replace(/[^a-z0-9]+/g, "");

// Two readings of a name's initials, because neither alone is right.
// Splitting on every run of letters and digits turns "Humanity's Last Exam"
// into Humanity + s + Last + Exam, giving "hsle", so "hle" missed the benchmark
// whose id literally is hle. Dropping one-letter fragments gives "hle".
// Keeping them is still needed elsewhere, so both are tried.
const initialsAll = (s: string): string =>
  (s.match(/[A-Za-z0-9]+/g) ?? []).map((w) => w[0].toLowerCase()).join("");
const initialsWords = (s: string): string =>
  (s.match(/[A-Za-z0-9]+/g) ?? []).filter((w) => w.length > 1).map((w) => w[0].toLowerCase()).join("");

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
  // its headline version. Both forms are scored and the better wins: searching
  // should not have to know about the suffix, and equally should not fail for
  // someone who read the card and typed what it says.
  //
  // Each form is scored whole, name and initials together. Deriving the
  // initials from the display name while matching against the bare one made
  // "Terminal-Bench, all versions" score its initials as "tbav", so "tb" ranked
  // the suite below its own 2.1 release.
  const bare = t.name.replace(/, all versions$/, "");
  return bare === t.name ? scoreOne(bare, q) : Math.max(scoreOne(bare, q), scoreOne(t.name, q));
}

function scoreOne(name: string, q: string): number {
  const n = fold(name);
  if (n === q) return 1000;
  if (q.length >= 2) {
    const ia = initialsAll(name), iw = initialsWords(name);
    // An exact acronym outranks a name that merely begins with those letters.
    // Without this "hle" returned HLE-Full, HLE-Text and HLE w/ tools, each of
    // which starts with the letters, and not Humanity's Last Exam, whose id is
    // literally hle and which every one of the twelve labs has cited.
    if (ia === q || iw === q) return 950;
  }
  if (n.startsWith(q)) return 900 - n.length;
  if (q.length >= 2) {
    // Initials still outrank a buried substring. Scored below it, "tb" was
    // pushed out of the results entirely: more than 36 tracked names contain
    // the literal letters "tb", so the cap evicted every initials match before
    // Terminal-Bench could be shown.
    const ia = initialsAll(name), iw = initialsWords(name);
    if (ia.startsWith(q) || iw.startsWith(q)) return 820;
  }
  const at = n.indexOf(q);
  if (at >= 0) return 700 - at;
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
    <div class="chips" aria-live="polite"></div>
    <button class="fold" type="button" aria-expanded="${open}" aria-controls="browse-panel">
      <svg class="fold__chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>
      ${open ? "Hide the list" : `Browse and search ${all.length.toLocaleString()} benchmarks, suites and categories`}
    </button>
    <div class="browse" id="browse-panel" ${open ? "" : "hidden"}>
      <p class="browse__note"><b>Labs</b> counts every lab that has cited it since ${esc(a.sinceLabel)}, so it never falls. <b>Recent releases</b> is the share still citing it across ${esc(a.recentLabel)}.</p>
      <div class="browse__field">
        <svg class="browse__icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>
        <input class="browse__input" type="search" autocomplete="off" spellcheck="false"
               placeholder="Search ${all.length.toLocaleString()} benchmarks, suites and categories"
               aria-label="Search benchmarks, suites and categories" />
        <button class="browse__clear" type="button" ${rawQuery ? "" : "hidden"} aria-label="Clear search">&times;</button>
      </div>
      <div class="facets">
        <div class="facets__subjects" role="group" aria-label="Subject"></div>
        <div class="facets__how">
          <div class="facets__sort">
            <span class="facets__label" id="sort-label">Sort by</span>
            <div class="seg" role="group" aria-labelledby="sort-label">
              <button type="button" data-sort="labs">Labs</button>
              <button type="button" data-sort="recent">Recent releases</button>
            </div>
          </div>
          <label class="facets__group">
            <input type="checkbox" class="facets__groupbox" />
            <span>Group versions</span>
          </label>
        </div>
      </div>
      <div class="browse__results" role="listbox" aria-label="Benchmarks"></div>
      <p class="browse__none" hidden></p>
      <p class="browse__more" hidden></p>
    </div>`;

  const input = host.querySelector<HTMLInputElement>(".browse__input")!;
  input.value = rawQuery;
  const clear = host.querySelector<HTMLButtonElement>(".browse__clear")!;
  const subjects = host.querySelector<HTMLDivElement>(".facets__subjects")!;
  const seg = host.querySelector<HTMLDivElement>(".seg")!;
  const groupBox = host.querySelector<HTMLInputElement>(".facets__groupbox")!;
  const results = host.querySelector<HTMLDivElement>(".browse__results")!;
  const none = host.querySelector<HTMLParagraphElement>(".browse__none")!;
  const more = host.querySelector<HTMLParagraphElement>(".browse__more")!;
  const chips = host.querySelector<HTMLDivElement>(".chips")!;

  let q = query;

  // "Other" is not offered as a place to browse. It is the residue of
  // classification rather than a subject anyone goes looking for, and at 1,017
  // benchmarks it is nearly half the list. Everything in it is still reachable
  // from All and from search.
  const SUBJECTS = [{ id: "all", name: "All" }, ...a.categories.filter((c) => c.id !== "other")];

  const CAP = 30;
  // Anything scored below this came from the edit-distance pass in scoreOne.
  const FUZZY = 700;
  let truncated = 0;

  // Search ignores the subject and the grouping both. Scoping it to the open
  // subject would have meant typing "terminal bench" inside Speech & audio and
  // being told there is no such thing; hiding versions behind their suite would
  // have meant "terminal-bench 2.1" finding nothing while the card for it
  // exists. Someone who types a specific name wants that exact thing, so the
  // facets go quiet and say they are not being applied.
  const paintFacets = () => {
    subjects.innerHTML = SUBJECTS.map((c) =>
      `<button type="button" data-subject="${esc(c.id)}" aria-pressed="${!q && c.id === subject}">${esc(c.name)}</button>`
    ).join("") + (q ? `<span class="browse__scope">Search covers every subject and every version</span>` : "");
    for (const b of seg.querySelectorAll<HTMLButtonElement>("[data-sort]"))
      b.setAttribute("aria-pressed", String(b.dataset.sort === sort));
    groupBox.checked = grouped;
    seg.classList.toggle("is-off", !!q);
    groupBox.closest("label")!.classList.toggle("is-off", !!q);
  };

  const rank = (x: Trackable, y: Trackable) =>
    sort === "labs"
      ? y.lab_count - x.lab_count || y.recent_share - x.recent_share
      : y.recent_share - x.recent_share || y.lab_count - x.lab_count;

  const pool = (): Trackable[] => {
    truncated = 0;
    if (q) {
      const hits = all.map((t) => ({ t, s: score(t, q) })).filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s || y.t.lab_count - x.t.lab_count);
      // Typo tolerance is a fallback, not a widener. Searching "swe bench"
      // turned up EBench, KWV Bench and SysBench in the tail, each two edits
      // away and none of them what anyone meant. So the near-misses are only
      // shown when the real matches are thin enough to need them.
      const strong = hits.filter((x) => x.s >= FUZZY);
      return (strong.length >= 8 ? strong : hits).slice(0, 36).map((x) => x.t);
    }
    // Grouping decides which kind stands for a family: the suite card, or every
    // version of it. Showing both put Terminal-Bench beside eleven of its own
    // versions, which is what made the list feel like noise rather than a list
    // of benchmarks.
    let items = all.filter((t) =>
      t.kind === "category" ? false : grouped ? t.kind === "suite" || !t.suite : t.kind !== "suite");
    if (subject !== "all") items = items.filter((t) => t.categories?.includes(subject));
    items.sort(rank);
    truncated = Math.max(0, items.length - CAP);
    items = items.slice(0, CAP);
    // The category itself leads its own subject, because tracking a whole
    // subject is a real thing to want and this is the only place to ask for it.
    const cat = subject === "all" ? undefined : a.trackables.get(`cat:${subject}`);
    return cat ? [cat, ...items] : items;
  };

  const paint = () => {
    const items = pool();
    none.hidden = items.length > 0;
    if (!items.length) none.textContent = `Nothing matches "${q}". Try fewer letters.`;
    // A silent cap is a lie about what is there. Say how many are behind it.
    more.hidden = truncated === 0;
    more.textContent = truncated
      ? `Showing the top ${CAP} of ${(truncated + CAP).toLocaleString()}. Search to reach any of the rest by name.`
      : "";
    results.innerHTML = items.map((t) => {
      const on = a.tracked.includes(t.id);
      // ", all versions" exists so a suite can be told from its headline
      // version when both are on screen. While grouping is on they never are,
      // and the meta line under the name already says how many versions there
      // are, so the suffix is just noise on every second card. Search shows
      // both kinds at once, so it keeps the suffix.
      const label = t.kind === "suite" && grouped && !q ? t.name.replace(/, all versions$/, "") : t.name;
      const subjects_ = (t.categories ?? []).map((c) => catName.get(c) ?? c).join(" · ");
      const meta = t.kind === "suite" ? `${t.members} versions${subjects_ ? ` · ${subjects_}` : ""}`
        : t.kind === "category" ? `Whole subject · ${t.members} benchmarks`
        : subjects_;
      const title = `${t.lab_count} of 12 labs have cited this. ${t.recent_share}% of releases in ${a.recentLabel} cite it.`;
      return `<button type="button" role="option" class="bcard bcard--${t.kind}" data-id="${esc(t.id)}"
               title="${esc(title)}" aria-selected="${on}" ${!on && full ? "disabled" : ""}>
        <span class="bcard__name">${esc(label)}</span>
        <span class="bcard__meta">${esc(meta)}</span>
        <span class="bcard__n"><b>${t.lab_count}</b> lab${t.lab_count === 1 ? "" : "s"}<span class="bcard__sep"> · </span><b>${t.recent_share}%</b> of recent releases</span>
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

  paintFacets(); paint(); paintChips();

  if (lastPicked) {
    const again = results.querySelector<HTMLElement>(`[data-id="${CSS.escape(lastPicked)}"]`);
    lastPicked = null;
    again?.focus({ preventScroll: true });
  }

  // Not `fold`: that name is the string normaliser at the top of this file.
  const foldBtn = host.querySelector<HTMLButtonElement>(".fold")!;
  const panel = host.querySelector<HTMLDivElement>(".browse")!;
  foldBtn.addEventListener("click", () => {
    open = !open;
    panel.hidden = !open;
    foldBtn.setAttribute("aria-expanded", String(open));
    foldBtn.lastChild!.textContent = open ? "Hide the list" : ` Browse and search ${all.length.toLocaleString()} benchmarks, suites and categories`;
    if (open) input.focus();
  });

  input.addEventListener("input", () => {
    const had = !!q;
    q = fold(input.value);
    query = q;
    rawQuery = input.value;
    clear.hidden = !input.value;
    if (had !== !!q) paintFacets();
    paint();
  });
  // Clearing returns to whichever subject was open before the search started.
  const endSearch = () => {
    if (!q) return;
    q = ""; query = ""; rawQuery = ""; input.value = ""; clear.hidden = true;
  };
  clear.addEventListener("click", () => { endSearch(); paintFacets(); paint(); input.focus(); });
  // Picking a subject is a request to browse it, so it ends the search rather
  // than sitting behind one that ignores it. Sorting and grouping do the same,
  // for the same reason: a control that visibly changes but does nothing is
  // worse than one that is not offered.
  subjects.addEventListener("click", (e) => {
    const v = (e.target as Element).closest("[data-subject]")?.getAttribute("data-subject");
    if (!v) return;
    subject = v; endSearch(); paintFacets(); paint();
  });
  seg.addEventListener("click", (e) => {
    const v = (e.target as Element).closest("[data-sort]")?.getAttribute("data-sort");
    if (v !== "labs" && v !== "recent") return;
    sort = v; endSearch(); paintFacets(); paint();
  });
  groupBox.addEventListener("change", () => {
    grouped = groupBox.checked; endSearch(); paintFacets(); paint();
  });
  results.addEventListener("click", (e) => {
    const card = (e.target as Element).closest<HTMLElement>("[data-id]");
    if (!card) return;
    // Remember which card was acted on. Re-rendering replaces every node, so
    // focus landed on BODY and a keyboard reader needed 22 tabs to get back to
    // where they were. Tracking two things in a row meant traversing the
    // masthead, the chips, the fold, the field and thirteen tabs again.
    lastPicked = card.getAttribute("data-id");
    a.onToggle(card.getAttribute("data-id")!);
  });
  chips.addEventListener("click", (e) => {
    const id = (e.target as Element).closest("[data-id]")?.getAttribute("data-id");
    if (id) a.onToggle(id);
  });
}
