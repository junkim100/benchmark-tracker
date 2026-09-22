import "./styles/tokens.css";
import "./styles/app.css";
// The dataset is fetched, not imported. Imported, it was compiled into the
// bundle as a JavaScript object literal: a megabyte of source that had to be
// downloaded and parsed as code before the first line of this file could run.
// `?url` keeps the content hash, so the two files a page loads are always the
// pair that build produced and a deploy can never leave them mismatched.
import coreUrl from "../data/timeline.json?url";
import logUrl from "../data/release-log.json?url";
import { MAX_TRACKED, buildTrackables, displayNames, memberIds, quarterOf, recount, type Release, type Timeline } from "./model";
import { aboutHTML, descKey, infoSheet, loadDescriptions, type Description, type Descriptions } from "./describe";
import { renderFilter } from "./filter";
import { mountSheet } from "./sheet";
import { renderTrend, type TrendView } from "./trend";

declare global {
  interface Window {
    /** Started by the inline script in index.html, while the head is still
     *  being parsed, so the data is in flight before this module is fetched.
     *
     *  `descriptions` is the odd one out: a content-hashed URL rather than a
     *  started fetch, because it is read only when a detail panel opens and it
     *  is about as large as the registry. Fetch it on that click. */
    btData?: { core?: Promise<Response>; log?: Promise<Response>; descriptions?: string };
    /** Reload past a stale GitHub Pages cache. Defined in index.html. */
    btRecoverStale?: () => boolean;
  }
}

const app = document.querySelector<HTMLDivElement>("#app")!;
// The masthead as index.html wrote it, before anything here touches the page.
// Every screen this module can draw begins with it unchanged, so the title
// paints once, in the right theme, and never moves afterwards.
const SHELL = app.innerHTML;

/* Theme: an explicit choice wins over the OS, and it persists. Storing nothing
   until the user chooses keeps "follow the system" as the real default.
   index.html applies the stored value during parse; these read and write the
   same key, and exist here for the toggle. */
type Theme = "light" | "dark" | null;
const readTheme = (): Theme => (localStorage.getItem("bt-theme") as Theme) ?? null;
const applyTheme = (t: Theme) => {
  if (t) document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
};
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const effective = (): "light" | "dark" => readTheme() ?? (systemDark() ? "dark" : "light");

async function load<T>(url: string, started?: Promise<Response>): Promise<T> {
  const res = await (started ?? fetch(url));
  // A cached index.html can name a hashed data file that the last deploy has
  // already deleted. That is the failure the stale-asset script in index.html
  // exists for, but a fetch raises no error event on an element, so it is
  // reported here instead. Only on a 404: a network failure means offline,
  // where reloading gives the browser's own error page rather than ours.
  if (res.status === 404 && window.btRecoverStale?.()) return new Promise<T>(() => {});
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json() as Promise<T>;
}

const corePromise = load<Timeline>(coreUrl, window.btData?.core);
const logPromise = load<Release[]>(logUrl, window.btData?.log);
// The log is only awaited once the registry has arrived and the page has been
// built. If the registry never arrives, nothing ever looks at this, and a
// rejection with no handler is reported to the console as an uncaught error on
// top of the one the reader is already being shown.
logPromise.catch(() => {});

// Nothing is under the masthead yet. On any ordinary connection the data
// arrives before this fires and it never appears; on a slow one it says what
// the page is waiting for instead of leaving a title over empty space. One
// muted line in the section's own type, no spinner and no reserved block.
const slowNote = window.setTimeout(() => {
  app.insertAdjacentHTML("beforeend", `<section class="tile tile--canvas" data-wait>
    <div class="tile__in"><p class="empty muted">Loading the dataset.</p></div></section>`);
}, 700);

// Under the masthead, in the page's own type, saying what happened and
// offering the one thing that can help. The alternative is a title over a
// blank screen, which looks the same as a site that is simply broken.
const failed = (err: unknown) => {
  clearTimeout(slowNote);
  console.error(err);
  app.innerHTML = `${SHELL}<section class="tile tile--canvas"><div class="tile__in"><div class="empty">
    <p>The dataset did not load.</p>
    <p class="muted">This site keeps no offline copy, so there is nothing to show until the connection comes back.</p>
    <p><button class="btn btn--sm" type="button" data-act="retry">Try again</button></p>
  </div></div></section>`;
  app.querySelector('[data-act="retry"]')!.addEventListener("click", () => location.reload());
};

corePromise.then(render, failed);

function render(data: Timeline) {
  clearTimeout(slowNote);
  if (data.release_log.count === 0) {
    app.innerHTML = `${SHELL}<section class="tile tile--canvas"><div class="tile__in"><div class="empty">
      <p>No scores, only what each lab chose to report.</p>
      <p class="muted">Tracking ${data.labs.length} labs. No releases recorded yet.</p></div></div></section>`;
    return;
  }
  const names = displayNames(data.benchmarks);
  const nowQ = quarterOf(new Date().toISOString().slice(0, 10));
  const partialQuarter = data.quarters.includes(nowQ) ? nowQ : null;
  // The window the recent share is measured over. Read from the build, not
  // written into the copy, because it moves every time the data is rebuilt and
  // a stated window that has quietly gone stale is worse than none.
  const win = data.recent_window;
  const recentMonths = win.months;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const fmtMonth = (d: string | null) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : "");
  // Rows read alphabetically. Any other order implies a ranking the data does
  // not support, and a reader looking for one lab should not have to hunt.
  const labs = [...data.labs].sort((a, b) => a.name.localeCompare(b.name, "en"));
  // Reassigned when a scope is applied, so every view reads one registry.
  let trackables = buildTrackables(data);

  // Open on four that already say something, rather than on an empty chart in
  // the largest space on the page. Four leaves half the eight slots free.
  //
  // All four climb, which is a change. HumanEval held this last slot because it
  // falls from 8 labs to 2 while Terminal-Bench climbs from 0 to 10, and both
  // are coding, so the pair read as a handoff from function completion to
  // terminal agents rather than as unrelated lines. SciCode is the newer
  // evaluation and the more current thing to be watching, and it is what the
  // owner asked to open on; the cost is that nothing on the default chart falls
  // any more, and that SciCode's line runs at 1 to 2 labs against a scale that
  // Terminal-Bench takes to 10, so it sits close to the axis. Both are visible
  // and neither is wrong. Anyone wanting the old contrast can add HumanEval
  // back in two clicks.
  //
  // Suites where one exists, so the line counts every version of the
  // evaluation: Terminal-Bench reads 11 labs as a suite against 9 for its
  // most-cited single version. SciCode has no versions, so it is tracked as
  // the benchmark it is.
  const DEFAULT_TRACKED = ["suite:terminal-bench", "suite:gdpval", "hle", "scicode"];
  // A suite stops existing if its members ever drop below two, and the data is
  // rebuilt every three days without anyone watching, so the default is
  // filtered against what actually exists and falls back rather than opening
  // empty.
  let tracked: string[] = DEFAULT_TRACKED.filter((id) => trackables.has(id));
  if (!tracked.length) tracked = data.benchmarks.slice(0, 4).map((b) => b.id);
  let view: TrendView = "chart";

  // Full-bleed tiles, alternating canvas and parchment. There is no wrapper
  // with a margin: each band paints the whole width and the colour change is
  // the only divider, which is what the design document means when it says to
  // change the surface before adding chrome.
  //
  // The sub-nav sits AFTER the hero rather than before it. Being sticky, it
  // scrolls up with the page and pins when it reaches the top, which is the
  // behaviour wanted with no scroll listener to get wrong, and it means the
  // hero is never covered by a bar on first paint.
  //
  // The hero itself is SHELL, reused byte for byte from what index.html
  // already painted. Writing it out again here would be a second copy of the
  // masthead to keep in step, and the one thing on the page that must not move
  // when the data lands is the thing the reader is already looking at.
  app.innerHTML = `${SHELL}
    <nav class="subnav" aria-label="Page actions">
      <div class="subnav__in">
        <span class="subnav__name">Frontier Benchmark Tracker</span>
        <span class="subnav__spacer"></span>
        <button class="btn btn--sm" type="button" data-act="pick">Change what's tracked</button>
      </div>
    </nav>

    <section class="tile tile--canvas" id="track" aria-label="Track benchmarks">
      <div class="tile__in">
        <div class="sec__head"><h2>Choose What to Track</h2></div>
        <div class="scope" hidden>
          <span class="facets__label" id="scope-label">Releases</span>
          <div class="scope__chips" role="group" aria-labelledby="scope-label"></div>
          <p class="scope__note" role="status"></p>
        </div>
        <div class="controls"></div>
      </div>
    </section>

    <section class="tile tile--parchment" aria-label="Adoption trend">
      <div class="tile__in">
        <div class="sec__head">
          <h2>Adoption Over Time</h2>
          <p class="howto howto--trend" hidden></p>
        </div>
        <div class="trendwrap"></div>
      </div>
    </section>

    <section class="tile tile--canvas" aria-label="Release timeline">
      <div class="tile__in">
        <div class="sec__head">
          <h2>Release Timeline<span class="tlv__sizes">
            <span class="tlv__sizes-label">Releases by one lab on one day</span>
            <span class="tlv__sizes-keys">
              <span><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="mark" cx="8" cy="8" r="4"/></svg>1</span>
              <span><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="mark" cx="8" cy="8" r="5.5"/></svg>2</span>
              <span><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="mark" cx="8" cy="8" r="7"/></svg>3 or more</span>
            </span>
          </span></h2>
          <p class="howto howto--tl"></p>
        </div>
          <div class="years" role="group" aria-label="Limit the timeline to one year"></div>
        <div class="tlwrap"></div>
      </div>
    </section>

    <footer class="tile tile--parchment ft">
      <div class="tile__in">
        <p>Sources are each lab's own site, model card, system card, or arXiv paper. Nothing is taken from news coverage or third-party leaderboards, and no score is recorded anywhere.</p>
        <p>Lab names and marks are the trademarks of their respective owners, shown to identify whose releases each row lists. This site reports on these companies and is neither endorsed by nor affiliated with any of them.</p>
        <p>Updated ${data.generated_at.slice(0, 10)}.</p>
        <p class="ft__legal">&copy; ${new Date().getUTCFullYear()} Jun Kim. Code under the MIT licence, data under CC BY 4.0. Lab marks are excluded from both.</p>
      </div>
    </footer>
    <div class="tt" role="tooltip" hidden></div>
    <div class="sheet" role="dialog" aria-labelledby="sheet-t" tabindex="-1" hidden>
      <div class="sheet__bar">
        <p class="sheet__t" id="sheet-t"></p>
        <button class="sheet__x" type="button" aria-label="Close details">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div class="sheet__body"></div>
    </div>
    <button class="corner corner--left" type="button" data-act="theme">
      <span class="vh"></span>
      <svg class="corner__i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></svg>
    </button>
    <button class="corner corner--right totop" type="button" aria-label="Back to top" title="Back to top">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>
    </button>`;

  const $ = <T extends Element>(s: string) => app.querySelector<T>(s)!;
  const tt = $<HTMLDivElement>(".tt");
  const sheetEl = $<HTMLElement>(".sheet");
  const sheet = mountSheet(sheetEl);

  // The page explains itself through hover, and a finger cannot hover, so the instruction has to be true for the reader in front of it rather than for the one the copy was written against. The timeline's standfirst said "Hover to view details, click to read the source", which on a phone described an interaction that does not exist and an outcome, the tooltip, that nobody there had ever seen.
  //
  // Repainted on change too: that is a laptop plugging in a mouse, or a tablet being put in a keyboard case.
  //
  // The chart's line is touch only. On a mouse the crosshair cursor and the band lighting up already say the chart answers questions, and this page has deliberately cut standfirsts that only restate what is visible; on a touchscreen there is no cursor and no hover, so nothing says it at all.
  const hoverless = matchMedia("(hover: none)");
  const paintHowto = () => {
    const touch = hoverless.matches;
    $(".howto--tl").textContent = touch
      ? "Each mark is a model release. Tap a mark to see what it cited and open its source."
      : "Each mark is a model release. Hover to view details, click to read the source.";
    const trend = $<HTMLElement>(".howto--trend");
    trend.textContent = "Tap a quarter to see which labs cited each tracked benchmark.";
    trend.hidden = !touch;
  };
  hoverless.addEventListener("change", paintHowto);
  paintHowto();

  /** Render, measure, trim, repeat. Every previous version computed the height
   *  from assumed row sizes and was wrong, because rows wrap. Asking the
   *  browser how tall it actually is cannot be wrong. `build(n)` returns the
   *  markup for at most n detail rows; we reduce n until it fits. */
  const showFitted = (build: (n: number, blocks?: number) => string, max: number, x: number, y: number) => {
    const room = window.innerHeight - 24;
    // Two levers, tried in order. Reducing rows alone could not help once the
    // block count itself exceeded the window, which sliced the footer on a
    // short landscape phone.
    // One pass when the builder ignores the second lever, so the trend tooltip
    // does not re-render identical markup three times per hover.
    // Blocks are reduced before rows, not after. Reducing rows first ran the
    // count to zero while still drawing three releases, so a short landscape
    // window showed three headers over bulleted lists reading only "and 8
    // more": three blocks naming nothing, where one naming eight would have
    // fitted. Fewer releases described properly beats more described not at
    // all.
    //
    // The row floor is 1 rather than 0 for the same reason. A block that names
    // no benchmark is not worth the space it takes.
    const levers = build.length > 1 ? [3, 2, 1] : [1];
    outer: for (const blocks of levers) {
      for (let n = max; n >= 1; n--) {
        tt.innerHTML = build(n, blocks);
        tt.hidden = false;
        tt.style.left = "0px";
        tt.style.top = "0px";
        if (tt.scrollHeight <= room) break outer;
        if (n === 0 && blocks === levers[levers.length - 1]) break outer;
      }
    }
    const b = tt.getBoundingClientRect();
    tt.style.left = `${Math.max(8, Math.min(x + 16, window.innerWidth - b.width - 12))}px`;
    tt.style.top = `${Math.max(8, Math.min(y + 16, window.innerHeight - b.height - 12))}px`;
  };

  const showTip = (html: string | null, x: number, y: number) => {
    if (!html) { tt.hidden = true; return; }
    tt.innerHTML = html;
    tt.hidden = false;
    // Measure from a neutral origin. Measuring while the element still carries
    // the previous hover's left made a 330px box report 154px, which inflated
    // the wrapped height and pushed the clamp badly off.
    tt.style.left = "0px";
    tt.style.top = "0px";
    const b = tt.getBoundingClientRect();
    tt.style.left = `${Math.max(8, Math.min(x + 16, window.innerWidth - b.width - 12))}px`;
    tt.style.top = `${Math.max(8, Math.min(y + 16, window.innerHeight - b.height - 12))}px`;
  };

  // A wheel scroll emits no mousemove, so neither the chart's mousemove nor its
  // mouseleave fires and the tooltip stayed pinned to the viewport over
  // whatever scrolled underneath it.
  const hideTip = () => { tt.hidden = true; };
  window.addEventListener("scroll", hideTip, { passive: true, capture: true });
  window.addEventListener("wheel", hideTip, { passive: true });

  // A sun and a moon, drawn as strokes so they inherit the button's colour and
  // stay legible at 16px. The icon shows the theme the click will switch TO,
  // and the label says so in words, because a lone sun is genuinely ambiguous
  // about whether it reports the current state or the next one.
  const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  const MOON = '<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.2 8.2 0 1 0 10.2 10.2Z"/>';
  const paintTheme = () => {
    const toDark = effective() !== "dark";
    const label = toDark ? "Switch to dark theme" : "Switch to light theme";
    $(".corner__i").innerHTML = toDark ? MOON : SUN;
    $('[data-act="theme"] .vh').textContent = label;
    $('[data-act="theme"]').setAttribute("title", label);
  };

  /** A suite or category counted over the same subset as its members.
   *
   *  Left alone, a scoped page would show "Terminal-Bench, all versions" at 11
   *  labs above a list of versions now totalling four, because the rollup came
   *  from the build while the versions came from the recount.
   *
   *  Counted by the same function as a benchmark, not a parallel one. Each kept
   *  release is rewritten to cite a single synthetic benchmark when it cites any
   *  member, so recount produces the group's distinct labs, its labs per quarter
   *  and its mean per-lab share with exactly the rules used everywhere else. Two
   *  implementations of "share of recent releases" would eventually disagree,
   *  and the disagreement would be invisible.
   */
  const rollup = (
    groups: Timeline["suites"],
    membersOf: (g: Timeline["suites"][number]) => Set<number>,
    kept: Release[],
  ): Timeline["suites"] =>
    groups.map((g) => {
      const members = membersOf(g);
      const asOne = kept.map((r) => ({ ...r, benchmarks: r.benchmarks.some((b) => members.has(b)) ? [0] : [] }));
      const rc = recount(asOne, 1, data.quarters, data.recent_window.quarters);
      return { ...g, lab_count: rc.labCount[0], labs_by_quarter: rc.labsByQuarter[0], recent_share: rc.recentShare[0] };
    });

  // Narrowing the page to one kind of model.
  //
  // Only offered once the release log has arrived, because it is the log that
  // carries modality and the log that every recounted figure is derived from,
  // and a control that cannot do anything yet is worse than one that appears
  // when it can.
  //
  // "all" is not a recount. With no scope the page uses the figures the build
  // computed, so the default view is byte-for-byte what it was before this
  // existed, and a reader who never touches the control cannot be affected by
  // it.
  // The page opens on language models, because that is what most readers come
  // for and it is the honest denominator for the benchmarks they are looking
  // at: a text benchmark's share should not be measured against the video and
  // speech releases that were never going to cite it.
  //
  // Scoping needs the log, and the log is where modality lives, so the first
  // draw waits for it rather than painting the unscoped figures and correcting
  // them a moment later. Measured on the live site, that costs nothing: the two
  // files are requested together in the head and finish in the same
  // millisecond, and the log is the smaller of the two. If it never arrives at
  // all the page falls back to "all" and the build's own figures, which is the
  // behaviour it had before any of this existed.
  // Scoping needs the log, and the log is where modality lives, so the page is
  // drawn unscoped and redrawn the moment the log lands. Measured on the live
  // site, the two data files are requested together in the head and finish in
  // the same millisecond, and a rescoped draw makes the same boxes with
  // different numbers in them, so nothing moves and nothing is read in between.
  //
  // The alternative, holding the first draw until the log arrived, was tried
  // and reverted: it left the page's own structure on screen with every section
  // empty and then filled them, which moved two tiles and cost a 0.227 layout
  // shift where there had been none.
  //
  // If the log never arrives the page falls back to "all" and the build's own
  // figures, which is the behaviour it had before any of this existed.
  // Offered only where the data can answer it, read from the build rather than
  // counted from the log, so the decision is made before the first paint. A
  // backfill that stopped halfway would otherwise give a control that silently
  // hid every release it never classified.
  const scopeOffered = data.modality_coverage >= 0.98 && data.modalities.length > 1;
  const DEFAULT_SCOPE = "language";
  let scope: string = scopeOffered ? DEFAULT_SCOPE : "all";
  const baseTrackables = trackables;

  /** Rebuild every trackable's figures over the releases the scope keeps. */
  const applyScope = () => {
    if (scope === "all" || !log) {
      trackables = baseTrackables;
      return;
    }
    const kept = log.filter((r) => r.modality?.includes(scope));
    const rc = recount(kept, data.benchmarks.length, data.quarters, data.recent_window.quarters);
    // The registry is rewritten rather than annotated, so nothing downstream
    // has to know a scope exists: the filter, the chart and the cards all read
    // the same fields they always read.
    const scoped: Timeline = {
      ...data,
      benchmarks: data.benchmarks.map((b, i) => ({
        ...b, lab_count: rc.labCount[i], recent_share: rc.recentShare[i], labs_by_quarter: rc.labsByQuarter[i],
      })),
      // Suites and categories are rollups of benchmarks, so they are recounted
      // from the members rather than left at their unscoped values, which would
      // have a suite claiming more labs than any version inside it.
      suites: rollup(data.suites, (g) => new Set(data.benchmarks.flatMap((b, i) => (b.suite === g.id ? [i] : []))), kept),
      categories: rollup(data.categories, (g) => new Set(data.benchmarks.flatMap((b, i) => (b.categories.includes(g.id) ? [i] : []))), kept),
    };
    trackables = buildTrackables(scoped);
  };

  /** The chips, and the line saying what the current one did.
   *
   *  The count rides in the chip because it is what decides whether a scope is
   *  worth choosing: Vision covers twenty releases and LLM covers five hundred
   *  and ninety-one, and finding that out by clicking is a worse deal than
   *  reading it. */
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  const paintScope = () => {
    const chips = app.querySelector<HTMLElement>(".scope__chips");
    const note = app.querySelector<HTMLElement>(".scope__note");
    if (!chips || !note) return;
    // Counts come from the registry, not the log, so the control is complete at
    // first paint. Waiting for the log meant a row of chips arriving after the
    // page and pushing it down.
    const total = data.release_log.count;
    const all = { id: "all", name: "All models", short: "All", releases: total };
    chips.innerHTML = [all, ...data.modalities].map((m) =>
      `<button type="button" data-scope="${esc(m.id)}" aria-pressed="${m.id === scope}">` +
      `<span class="scope__long">${esc(m.name)}</span><span class="scope__short">${esc(m.short)}</span>` +
      `<span class="scope__n">${m.releases.toLocaleString()}</span></button>`
    ).join("");
    if (scope === "all") {
      note.textContent = `Every release, including image, speech, video and embedding models.`;
      return;
    }
    const m = data.modalities.find((x) => x.id === scope);
    note.textContent = `${m?.releases.toLocaleString() ?? 0} of ${total.toLocaleString()} releases. Every count and share below is measured over those, not over all of them.`;
  };

  /** The releases the current scope keeps. One implementation, because the year chips, the timeline and the detail panel all have to be describing the same subset and three copies of one filter is three chances for them not to be. */
  const inView = (rows: Release[]): Release[] =>
    scope === "all" ? rows : rows.filter((r) => r.modality?.includes(scope));

  // The descriptions, once something has asked for them. Null means nobody has pressed an info button yet; an empty object means there is nothing to show, either because the file said so or because it was never worth asking for.
  let descs: Descriptions | null = null;
  // Whether the file is worth a request at all, decided from two numbers the registry already carries rather than by fetching a few hundred kilobytes to find out. A registry with nothing described is the resting state of a research pass that has not been run yet, and it is a real state this site will be in for a while.
  const anyDescribed = (data.descriptions?.described ?? 0) > 0;

  /** What a press on a card's info button opens.
   *
   *  Derived from inView() rather than from the whole log, so a panel can never report four labs under a card reading two. That is the same disagreement the suite rollup above exists to prevent, one screen further down the page.
   *
   *  Nothing is held back waiting for the descriptions file. It is fetched on the first press, it is about as large as the registry, most benchmarks have no entry in it at all, and the other three things the panel says are already in memory. So the panel is drawn from what is known and the sentence is dropped in if one arrives. Dropped into the block in place rather than by calling show() again, because show() scrolls the body back to its top and takes focus, and on a slow connection the reader may be on the link inside it by then. */
  const openInfo = (id: string) => {
    const t = trackables.get(id);
    if (!t) return;
    const key = descKey(t);
    const open = (desc: Description | null) =>
      sheet.show(infoSheet({ t, benchmarks: data.benchmarks, suites: data.suites, labs, releases: log && inView(log), desc }));
    if (descs) { open(descs[key] ?? null); return; }
    open(null);
    if (!anyDescribed) { descs = {}; return; }
    loadDescriptions().then((all) => {
      descs = all;
      if (!all[key]) return;
      const slot = sheetEl.querySelector<HTMLElement>("[data-about]");
      // Only if the panel is still the one that asked. A slow fetch can land after the reader has closed it or opened another card's.
      if (sheetEl.hidden || slot?.getAttribute("data-about") !== t.id) return;
      slot.innerHTML = aboutHTML(all[key]);
    });
  };

  const draw = () => {
    if (scopeOffered) {
      $<HTMLElement>(".scope").hidden = false;
      paintScope();
    }
    // A redraw replaces every mark and every band, so anything the panel is describing is about to stop existing. Closing it first also puts focus back before the filter hands it to the card that was just pressed.
    sheet.hide();
    renderFilter($(".controls"), {
      trackables, categories: data.categories, tracked,
      recentLabel: `the last ${recentMonths} months`,
      sinceLabel: fmtMonth(data.release_log.first),
      onInfo: openInfo,
      onToggle: (id) => {
        const adding = !tracked.includes(id);
        tracked = adding
          ? tracked.length < MAX_TRACKED ? [...tracked, id] : tracked
          : tracked.filter((t) => t !== id);
        // Taking a suite drops any of its versions that were already tracked.
        // A suite counts every lab citing any version, so a version's line can
        // only ever sit at or below it, and for some suites they coincide
        // exactly: HumanEval and its headline version are identical in all
        // eight recent quarters, which draws one line on top of another and
        // spends two of the eight slots doing it.
        //
        // One direction only. Clicking a version while its suite is tracked is
        // a deliberate ask for how much of the whole that version accounts for,
        // which is a real question, so that pairing is left alone.
        //
        // Categories are not treated this way. A category is a subject rather
        // than versions of one evaluation, so "SWE-bench against all of Coding"
        // is a comparison worth keeping, and dropping every coding benchmark
        // because someone opened the category would throw away four choices at
        // once.
        const t = adding ? trackables.get(id) : null;
        if (t?.kind === "suite") {
          // Membership is a set of positions in data.benchmarks, so a tracked
          // id has to be resolved to its own position before it can be tested.
          // Suites and categories have none and are never inside a suite.
          const inside = memberIds(t, data.benchmarks);
          tracked = tracked.filter((x) => {
            const at = trackables.get(x)?.at;
            return x === id || at === undefined || !inside.has(at);
          });
        }
        // No save-and-restore here any more. The browser's subject, sort,
        // grouping and query all live outside its render, so a redraw keeps
        // them on its own, and replaying a click could never restore a subject
        // during a search anyway: none is selected then.
        draw();
      },
    });
    renderTrend($(".trendwrap"), {
      tracked: tracked.map((id) => trackables.get(id)!).filter(Boolean),
      benchmarks: data.benchmarks,
      releases: () => log, labs, quarters: data.quarters, partialQuarter,
      view, onView: (v) => { view = v; draw(); }, onHover: showTip, onHoverFitted: showFitted,
      onPick: (r) => (r ? sheet.show(r) : sheet.hide()),
    });
    drawTimeline();
    paintTheme();
  };

  // The release log is the largest file in the dataset and the only view that
  // reads all of it sits two screens down, so it is fetched beside the
  // registry and drawn when it arrives rather than waited for. The module that
  // draws it is dynamic for the same reason: it is the heaviest of the three
  // views and none of its code is needed to put the chart on screen.
  //
  // Nothing above it moves when it lands. The section, its heading and its
  // standfirst are part of the page from the first paint; only the area below
  // them grows, and everything after it is the footer.
  // Which year the timeline is limited to, or "all".
  //
  // The timeline only. The chart is not filtered by it and must not be: the
  // chart's whole job is the shape of adoption across years, so narrowing it to
  // one would leave a single column of dots where a trend used to be. The
  // picker is not filtered either, because a benchmark's lab count is a fact
  // about the whole history and quietly rewriting it from a navigation control
  // would be the same overloading the mark sizes were just rescued from.
  //
  // So this sits inside the timeline section rather than above the page, where
  // a control's reach is as far as the reader can see it reaching.
  let year: string = "all";
  let log: Release[] | null = null;
  let timeline: typeof import("./timeline") | null = null;
  /** The year chips, counted under the scope currently in force. */
  const paintYears = () => {
    const el = app.querySelector<HTMLElement>(".years");
    if (!el || !log) return;
    const scoped = inView(log);
    const per = new Map<string, number>();
    for (const r of scoped) { const y = r.date.slice(0, 4); per.set(y, (per.get(y) ?? 0) + 1); }
    // Newest first, the direction the timeline already reads in.
    const years = [...per.keys()].sort().reverse();
    const chip = (id: string, label: string, n: number, disabled = false) =>
      `<button type="button" data-year="${esc(id)}" aria-pressed="${id === year}" ${disabled ? "disabled" : ""}>` +
      `${esc(label)}<span class="years__n">${n.toLocaleString()}</span></button>`;
    el.innerHTML = `<span class="facets__label" id="years-label">Show</span>` +
      chip("all", "All years", scoped.length) +
      years.map((y) => chip(y, y, per.get(y) ?? 0)).join("");
  };

  const drawTimeline = () => {
    if (!timeline || !log) return;
    // Narrowed into locals, so the hover closure below does not have to
    // re-check two module-scoped nullables every time the pointer moves.
    const tl = timeline;
    // The same subset every figure on the page was recounted over, so the marks
    // and the numbers describing them can never be answering different
    // questions.
    const scoped = inView(log);
    const rows = year === "all" ? scoped : scoped.filter((r) => r.date.slice(0, 4) === year);
    // Both ends fixed by the year rather than by what survived the filter, so a
    // year with a quiet December is still a whole year on the axis.
    const range = year === "all" ? null : { from: `${year}-01-01`, to: `${year}-12-31` };
    paintYears();
    tl.renderTimeline($(".tlwrap"), {
      labs, releases: rows, names, range,
      // A mark is coloured by the slot of whatever it cites, so a tracked suite
      // has to hand the timeline every version it covers, not its own id.
      trackedMembers: tracked.map((id) => {
        const t = trackables.get(id);
        return t ? memberIds(t, data.benchmarks) : new Set<number>();
      }),
      onHover: (rs, x, y) => {
        if (!rs || !rs.length) { showTip(null, 0, 0); return; }
        showFitted((n, blocks) => tl.tooltipHTML(rs, names, n, blocks), 8, x, y);
      },
      onPick: (r) => (r ? sheet.show(r) : sheet.hide()),
    });
  };

  Promise.all([logPromise, import("./timeline")]).then(([rows, mod]) => {
    log = rows;
    timeline = mod;
    // Offered only now, and only if the data can answer it. Coverage is read
    // rather than assumed: a backfill that stopped halfway would otherwise give
    // a control that silently hides every release it never classified.
    if (scopeOffered) {
      const el = $<HTMLElement>(".scope");
      el.addEventListener("click", (e) => {
        const v = (e.target as Element).closest("[data-scope]")?.getAttribute("data-scope");
        if (!v || v === scope) return;
        scope = v;
        for (const b of el.querySelectorAll<HTMLButtonElement>("[data-scope]"))
          b.setAttribute("aria-pressed", String(b.dataset.scope === scope));
        applyScope();
        paintScope();
        // A year with nothing left under the new scope would be an empty
        // timeline with no explanation, so the view falls back to all years.
        if (year !== "all" && log && !log.some((r) => r.date.slice(0, 4) === year && (scope === "all" || r.modality?.includes(scope)))) {
          year = "all";
        }
        draw();
        drawTimeline();
      });
      applyScope();
      paintScope();
    }
    // A year the current scope has emptied is not offered, so switching scope
    // has to put the reader back on a year that exists.
    app.querySelector(".years")?.addEventListener("click", (e) => {
      const v = (e.target as Element).closest("[data-year]")?.getAttribute("data-year");
      if (!v || v === year) return;
      year = v;
      drawTimeline();
    });
    draw();
    drawTimeline();
  }).catch((err) => {
    // Everything above the fold is already correct and working, so a failure
    // here costs the timeline and nothing else. Saying so in its own space is
    // better than throwing the whole page away for the view furthest down it.
    console.error(err);
    // The scope cannot be honoured without the log, and a page showing LLM
    // figures it could not compute would be worse than one showing all of
    // them. Fall back, and draw, because the first draw was waiting on this.
    scope = "all";
    applyScope();
    draw();
    $(".tlwrap").innerHTML = `<p class="empty muted">The release log did not load. Reload the page to try again.</p>`;
  });

  app.addEventListener("click", (e) => {
    const act = (e.target as Element).closest("[data-act]")?.getAttribute("data-act");
    if (act === "theme") {
      localStorage.setItem("bt-theme", effective() === "dark" ? "light" : "dark");
      applyTheme(readTheme());
      paintTheme();
      return;
    }
    // The picker is at the top of a page about three screens long, so once you
    // have scrolled to the timeline and decided you want a different benchmark
    // the only route back was the same distance in reverse. The sub-nav is
    // sticky, so this is reachable from anywhere.
    //
    // It clicks the real control rather than reaching into the filter's state:
    // one code path opens the panel, so the panel cannot end up open with the
    // button still saying "Browse".
    if (act === "pick") {
      const fold = app.querySelector<HTMLButtonElement>(".fold");
      if (fold?.getAttribute("aria-expanded") === "false") fold.click();
      // After, not before. Opening focuses the search field, and focusing
      // scrolls it into view, which would otherwise undo this.
      requestAnimationFrame(() => app.querySelector("#track")?.scrollIntoView({ block: "start" }));
    }
  });

  // Both the chart and the timeline measure their container when they draw, so
  // a width change has to redraw them or each keeps the size the last draw
  // found. Only past a few pixels: a scrollbar appearing is not a resize worth
  // a repaint.
  //
  // There is nothing to restore afterwards. The timeline runs down the page
  // now, so the reader's place in it is the page's scroll position, which the
  // browser keeps on its own.
  let chartW = $(".trendwrap").getBoundingClientRect().width;
  window.addEventListener("resize", () => {
    const w = $(".trendwrap").getBoundingClientRect().width;
    if (Math.abs(w - chartW) > 8) { chartW = w; draw(); }
  });

  // A way back up. The timeline runs about 2,800px, so reaching its foot puts
  // the masthead three screens away and the only route back is the same
  // distance in reverse.
  //
  // Always on screen, like the theme toggle it is paired with. It used to
  // appear only once the timeline's top had passed, which meant it was absent
  // for the first two screens and a reader could not learn where it lives: a
  // control that comes and goes cannot be reached for. Its twin never moves,
  // and now neither does it.
  //
  // Disabled at the very top rather than hidden, because there it has nowhere
  // to go, and offering an action that does nothing is worse than showing that
  // there is nothing to do. The pager arrows already disable at the ends of
  // their list, so the page has one grammar for "this way is exhausted".
  //
  // The whole sentinel is gone with it. It existed to answer "has the timeline
  // scrolled past", and the question now is simply whether the page is at the
  // top, which scrollY answers without a DOM read.
  const toTop = $<HTMLButtonElement>(".totop");
  // rAF-throttled, so the work is a handful of reads per painted frame at most.
  // The sub-nav's two pieces are revealed by the same pass, because both are
  // duplicates until you have scrolled away from what they duplicate. Sitting
  // 250px under an h1 reading "Frontier Benchmark Tracker", a bar reading
  // "Frontier Benchmark Tracker" is noise; so is a blue pill saying "Change
  // what's tracked" directly above a blue pill saying "Browse benchmarks".
  // Each appears exactly when the thing it stands in for is off screen.
  const subnav = $<HTMLElement>(".subnav");
  const navName = $<HTMLElement>(".subnav__name");
  const navPick = $<HTMLElement>('[data-act="pick"]');
  const hero = $(".hero");
  const controls = $(".controls");
  const navH = 52;

  let ticking = false;
  const syncToTop = () => {
    ticking = false;
    toTop.disabled = window.scrollY <= 0;
    navName.hidden = hero.getBoundingClientRect().bottom > 0;
    navPick.hidden = controls.getBoundingClientRect().bottom > navH;
    // With both pieces away the bar holds nothing, and an empty strip with a
    // hairline under it is a rule doing the job the surface change already
    // does. It keeps its 52px so nothing below it moves, and paints only once
    // it has something to carry, which is also the moment it pins.
    subnav.classList.toggle("is-bare", navName.hidden && navPick.hidden);
  };
  addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(syncToTop);
  }, { passive: true });
  addEventListener("resize", syncToTop, { passive: true });
  syncToTop();

  toTop.addEventListener("click", () => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
    // Keyboard focus follows, or the reader is returned to the top of the page
    // with their place in the tab order still three screens below it.
    const h1 = $<HTMLElement>("h1");
    h1.tabIndex = -1;
    h1.focus({ preventScroll: true });
  });

  draw();
}
