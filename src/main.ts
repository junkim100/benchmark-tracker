import "./styles/tokens.css";
import "./styles/app.css";
import raw from "../data/timeline.json";
import { MAX_TRACKED, buildTrackables, displayNames, memberIds, quarterOf, yearsSpanned, type Timeline } from "./model";
import { renderFilter } from "./filter";
import { renderTimeline, tooltipHTML } from "./timeline";
import { renderTrend, type TrendView } from "./trend";

const data = raw as unknown as Timeline;
const app = document.querySelector<HTMLDivElement>("#app")!;

/* Theme: an explicit choice wins over the OS, and it persists. Storing nothing
   until the user chooses keeps "follow the system" as the real default. */
type Theme = "light" | "dark" | null;
const readTheme = (): Theme => (localStorage.getItem("bt-theme") as Theme) ?? null;
const applyTheme = (t: Theme) => {
  if (t) document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
};
applyTheme(readTheme());
const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const effective = (): "light" | "dark" => readTheme() ?? (systemDark() ? "dark" : "light");

if (data.releases.length === 0) {
  app.innerHTML = `<main class="empty"><h1>Benchmark Tracker</h1>
    <p>Which benchmarks frontier labs cite when they ship a model. No scores, only what each lab chose to report.</p>
    <p class="muted">Tracking ${data.labs.length} labs. No releases recorded yet.</p></main>`;
} else {
  const names = displayNames(data.benchmarks);
  const years = yearsSpanned(data.releases);
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
  const trackables = buildTrackables(data);

  // Open on four that already say something, rather than on an empty chart in
  // the largest space on the page.
  //
  // Three rising and one falling, because four lines all climbing from zero
  // tell one story and the point of the chart is the contrast. HumanEval is the
  // fourth for a reason: it falls from 8 to 2 while Terminal-Bench climbs from
  // 0 to 10, crossing in Q1 2025, and both are coding, so it reads as a handoff
  // from function completion to terminal agents rather than as four unrelated
  // lines. Four leaves half the eight slots free.
  //
  // Suites, not their headline versions, so the line counts every version of
  // the evaluation. Terminal-Bench reads 11 labs as a suite against 9 for its
  // most-cited single version.
  const DEFAULT_TRACKED = ["suite:terminal-bench", "suite:gdpval", "hle", "suite:humaneval"];
  // A suite stops existing if its members ever drop below two, and the data is
  // rebuilt every three days without anyone watching, so the default is
  // filtered against what actually exists and falls back rather than opening
  // empty.
  let tracked: string[] = DEFAULT_TRACKED.filter((id) => trackables.has(id));
  if (!tracked.length) tracked = data.benchmarks.slice(0, 4).map((b) => b.id);
  let view: TrendView = "chart";

  app.innerHTML = `
    <header class="hd">
      <div class="hd__title">
        <h1>Benchmark Tracker</h1>
        <p class="hd__sub">Which benchmarks frontier labs cite when they ship, not how they scored, across ${data.releases.length.toLocaleString()} official releases from ${labs.length} labs since ${years[0]}.</p>
      </div>
      <button class="iconbtn" type="button" data-act="theme">
        <span class="vh"></span>
        <svg class="iconbtn__i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></svg>
      </button>
    </header>

    <div class="sec">
      <div class="sec__head">
        <h2>Choose what to track</h2>
        <p>Up to eight. A suite covers every version of an evaluation at once; a category covers a whole subject. Search ignores spelling, so "tau bench" finds &tau;&sup2;-Bench.</p>
      </div>
      <section class="controls" aria-label="Track benchmarks"></section>
    </div>

    <div class="sec">
      <div class="sec__head">
        <h2>Adoption over time</h2>
        <p>How many labs cited each tracked benchmark, by quarter.</p>
      </div>
      <section class="trendwrap" aria-label="Adoption trend"></section>
    </div>

    <div class="sec">
      <div class="sec__head">
        <h2>Every release</h2>
        <p>One row per lab. Each mark is a release; open one to read the source.</p>
      </div>
      <section class="tlwrap" aria-label="Release timeline"></section>
    </div>

    <footer class="ft">
      <div class="ft__notes">
        <p>Sources are each lab's own site, model card, system card, or arXiv paper. Nothing is taken from news coverage or third-party leaderboards, and no score is recorded anywhere.</p>
        <p>Lab names and marks are the trademarks of their respective owners, shown to identify whose releases each row lists. This site reports on these companies and is neither endorsed by nor affiliated with any of them.</p>
      </div>
      <p class="ft__meta">Updated ${data.generated_at.slice(0, 10)}. <a href="https://github.com/junkim100/benchmark-tracker">Data and code on GitHub</a></p>
    </footer>
    <div class="tt" role="tooltip" hidden></div>`;

  const $ = <T extends Element>(s: string) => app.querySelector<T>(s)!;
  const tt = $<HTMLDivElement>(".tt");

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
    const levers = build.length > 1 ? [3, 2, 1] : [1];
    outer: for (const blocks of levers) {
      for (let n = max; n >= 0; n--) {
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
    $(".iconbtn__i").innerHTML = toDark ? MOON : SUN;
    $(".iconbtn .vh").textContent = label;
    $(".iconbtn").setAttribute("title", label);
  };

  const draw = () => {
    renderFilter($(".controls"), {
      trackables, categories: data.categories, tracked,
      recentLabel: `the last ${recentMonths} months, ${fmtMonth(win.from)} to ${fmtMonth(win.to)}, covering ${win.releases.toLocaleString()} releases`,
      sinceLabel: fmtMonth(data.releases[0].date),
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
          const inside = memberIds(t, data.benchmarks);
          tracked = tracked.filter((x) => x === id || !inside.has(x));
        }
        // Keep the browser where it was. Re-rendering replaces the field and
        // the tab strip, so without this a second pick means retyping the
        // search and finding the category again.
        const before = app.querySelector<HTMLInputElement>(".browse__input")?.value ?? "";
        const activeTab = app.querySelector('.browse__tabs [aria-selected="true"]')?.getAttribute("data-tab") ?? "";
        draw();
        const after = app.querySelector<HTMLInputElement>(".browse__input");
        if (after && before) { after.value = before; after.dispatchEvent(new Event("input")); }
        if (activeTab) app.querySelector<HTMLButtonElement>(`.browse__tabs [data-tab="${activeTab}"]`)?.click();
      },
    });
    renderTrend($(".trendwrap"), {
      tracked: tracked.map((id) => trackables.get(id)!).filter(Boolean),
      benchmarks: data.benchmarks,
      releases: data.releases, labs, quarters: data.quarters, partialQuarter,
      view, onView: (v) => { view = v; draw(); }, onHover: showTip, onHoverFitted: showFitted,
    });
    renderTimeline($(".tlwrap"), {
      labs, releases: data.releases, names, quarters: data.quarters,
      // A mark is coloured by the slot of whatever it cites, so a tracked suite
      // has to hand the timeline every version it covers, not its own id.
      trackedMembers: tracked.map((id) => {
        const t = trackables.get(id);
        return t ? memberIds(t, data.benchmarks) : new Set<string>();
      }),
      onHover: (rs, x, y) => {
        if (!rs || !rs.length) { showTip(null, 0, 0); return; }
        showFitted((n, blocks) => tooltipHTML(rs, names, n, blocks), 8, x, y);
      },
    });
    paintTheme();
  };

  app.addEventListener("click", (e) => {
    if (!(e.target as Element).closest('[data-act="theme"]')) return;
    localStorage.setItem("bt-theme", effective() === "dark" ? "light" : "dark");
    applyTheme(readTheme());
    paintTheme();
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

  draw();
}
