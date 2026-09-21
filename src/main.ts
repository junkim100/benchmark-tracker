import "./styles/tokens.css";
import "./styles/app.css";
import raw from "../data/timeline.json";
import { MAX_TRACKED, displayNames, quarterOf, yearsSpanned, type Benchmark, type Timeline } from "./model";
import { renderFilter } from "./filter";
import { noteTimelineResize, renderTimeline, restoreTimelineScroll, timelineBucket, tooltipHTML } from "./timeline";
import { renderTrend, type TrendView } from "./trend";

const data = raw as unknown as Timeline;
const app = document.querySelector<HTMLDivElement>("#app")!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

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
  // Rows read alphabetically. Any other order implies a ranking the data does
  // not support, and a reader looking for one lab should not have to hunt.
  const labs = [...data.labs].sort((a, b) => a.name.localeCompare(b.name, "en"));
  const byId = new Map(data.benchmarks.map((b) => [b.id, b]));
  const top = data.benchmarks[0];

  // Open with the four most-cited benchmarks already tracked. An empty chart
  // was the first thing a reader saw, in the largest space on the page, and it
  // could only explain in words what one glance would have shown. Four is
  // enough to read as a comparison and leaves half the eight slots free.
  let tracked: string[] = data.benchmarks.slice(0, 4).map((b) => b.id);
  let view: TrendView = "chart";

  app.innerHTML = `
    <header class="hd">
      <div class="hd__title">
        <h1>Benchmark Tracker</h1>
        <p class="hd__sub">Which benchmarks frontier labs cite when they ship. Not how they scored.</p>
      </div>
      <button class="iconbtn" type="button" data-act="theme">
        <span class="vh"></span>
        <svg class="iconbtn__i" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></svg>
      </button>
    </header>

    <section class="scope" aria-label="What is covered">
      <p>Every benchmark named in <b>${data.releases.length.toLocaleString()}</b> official releases from <b>${labs.length}</b> frontier labs since ${years[0]}. ${esc(names.get(top.id) ?? top.id)} is the most widely cited, reported by all ${top.lab_count}.</p>
    </section>

    <div class="sec">
      <div class="sec__head">
        <h2>Track a benchmark</h2>
        <p>Pick up to eight and compare how widely each one is cited.</p>
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
      <p>Sources are each lab's own site, model card, system card, or arXiv paper. Nothing is taken from news coverage or third-party leaderboards, and no score is recorded anywhere.</p>
      <p>Lab names and marks are the trademarks of their respective owners, shown to identify whose releases each row lists. This site reports on these companies and is neither endorsed by nor affiliated with any of them.</p>
      <p>Updated ${data.generated_at.slice(0, 10)}. <a href="https://github.com/junkim100/benchmark-tracker">Data and code on GitHub</a></p>
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
      benchmarks: data.benchmarks, names, tracked,
      onToggle: (id) => {
        const adding = !tracked.includes(id);
        tracked = adding
          ? tracked.length < MAX_TRACKED ? [...tracked, id] : tracked
          : tracked.filter((t) => t !== id);
        draw();
        // Re-rendering replaces the input, so focus has to be put back or
        // picking a second benchmark means reaching for the mouse again. The
        // quiet flag keeps the list shut on the way in, so focus returns
        // without the panel covering the chart.
        if (adding) {
          const i = app.querySelector<HTMLInputElement>(".pick__input");
          if (i) { i.dataset.quiet = "1"; i.focus(); }
        }
      },
    });
    renderTrend($(".trendwrap"), {
      tracked: tracked.map((id) => byId.get(id)!).filter(Boolean) as Benchmark[],
      releases: data.releases, labs, names, quarters: data.quarters, partialQuarter,
      view, onView: (v) => { view = v; draw(); }, onHover: showTip, onHoverFitted: showFitted,
    });
    renderTimeline($(".tlwrap"), {
      labs, releases: data.releases, tracked, names, quarters: data.quarters,
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

  // The timeline picks its day scale from the viewport, so a rotation has to
  // redraw it. Only on a bucket change: resizing within one bucket changes
  // nothing and a redraw would cost the reader their scroll position.
  let narrow = timelineBucket();
  window.addEventListener("resize", () => {
    noteTimelineResize();
    if (timelineBucket() !== narrow) { narrow = !narrow; draw(); return; }
    // Same bucket, so no redraw, but a widened viewport still clamps the
    // scroller and no redraw is coming to undo it.
    restoreTimelineScroll($(".tlwrap"));
  });

  draw();
}
