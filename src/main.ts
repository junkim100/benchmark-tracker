import "./styles/tokens.css";
import "./styles/app.css";
import raw from "../data/timeline.json";
import { MAX_TRACKED, buildTrackables, displayNames, memberIds, quarterOf, type Timeline } from "./model";
import { renderFilter } from "./filter";
import { mountSheet } from "./sheet";
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
  app.innerHTML = `<main class="empty"><h1>Frontier Benchmark Tracker</h1>
    <p>Which benchmarks frontier labs cite when they ship a model. No scores, only what each lab chose to report.</p>
    <p class="muted">Tracking ${data.labs.length} labs. No releases recorded yet.</p></main>`;
} else {
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

  // Full-bleed tiles, alternating canvas and parchment. There is no wrapper
  // with a margin: each band paints the whole width and the colour change is
  // the only divider, which is what the design document means when it says to
  // change the surface before adding chrome.
  //
  // The sub-nav sits AFTER the hero rather than before it. Being sticky, it
  // scrolls up with the page and pins when it reaches the top, which is the
  // behaviour wanted with no scroll listener to get wrong, and it means the
  // hero is never covered by a bar on first paint.
  app.innerHTML = `
    <header class="tile tile--parchment hero">
      <div class="tile__in">
        <h1>Frontier Benchmark Tracker</h1>
        <p class="hero__sub">Which benchmarks frontier labs cite in their model releases.</p>
      </div>
    </header>

    <nav class="subnav" aria-label="Page actions">
      <div class="subnav__in">
        <span class="subnav__name">Frontier Benchmark Tracker</span>
        <span class="subnav__spacer"></span>
        <button class="btn btn--sm" type="button" data-act="pick">Change what's tracked</button>
      </div>
    </nav>

    <section class="tile tile--canvas" id="track" aria-label="Track benchmarks">
      <div class="tile__in">
        <div class="sec__head"><h2>Choose what to track</h2></div>
        <div class="controls"></div>
      </div>
    </section>

    <section class="tile tile--parchment" aria-label="Adoption trend">
      <div class="tile__in">
        <div class="sec__head">
          <h2>Adoption over time</h2>
          <p class="howto howto--trend" hidden></p>
        </div>
        <div class="trendwrap"></div>
      </div>
    </section>

    <section class="tile tile--canvas" aria-label="Release timeline">
      <div class="tile__in">
        <div class="sec__head">
          <h2>Release timeline</h2>
          <p class="howto howto--tl"></p>
        </div>
          <div class="tlwrap"></div>
      </div>
    </section>

    <footer class="tile tile--parchment ft">
      <div class="tile__in">
        <p>Sources are each lab's own site, model card, system card, or arXiv paper. Nothing is taken from news coverage or third-party leaderboards, and no score is recorded anywhere.</p>
        <p>Lab names and marks are the trademarks of their respective owners, shown to identify whose releases each row lists. This site reports on these companies and is neither endorsed by nor affiliated with any of them.</p>
        <p>Updated ${data.generated_at.slice(0, 10)}. <a href="https://github.com/junkim100/benchmark-tracker">Data and code on GitHub</a></p>
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
  const sheet = mountSheet($<HTMLElement>(".sheet"));

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

  const draw = () => {
    // A redraw replaces every mark and every band, so anything the panel is describing is about to stop existing. Closing it first also puts focus back before the filter hands it to the card that was just pressed.
    sheet.hide();
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
      releases: data.releases, labs, quarters: data.quarters, partialQuarter,
      view, onView: (v) => { view = v; draw(); }, onHover: showTip, onHoverFitted: showFitted,
      onPick: (r) => (r ? sheet.show(r) : sheet.hide()),
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
      onPick: (r) => (r ? sheet.show(r) : sheet.hide()),
    });
    paintTheme();
  };

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
