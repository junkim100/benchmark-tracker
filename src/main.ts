import "./styles/tokens.css";
import "./styles/app.css";
import raw from "../data/timeline.json";
import { MAX_TRACKED, displayNames, quarterOf, yearsSpanned, type Benchmark, type Timeline } from "./model";
import { renderFilter } from "./filter";
import { renderTimeline, tooltipHTML } from "./timeline";
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

  let tracked: string[] = [];
  let view: TrendView = "chart";

  app.innerHTML = `
    <header class="hd">
      <div class="hd__title">
        <h1>Benchmark Tracker</h1>
        <p class="hd__sub">Which benchmarks frontier labs cite when they ship. Not how they scored.</p>
      </div>
      <button class="iconbtn" type="button" data-act="theme" aria-label="Switch colour theme" title="Switch colour theme">
        <span class="iconbtn__l" aria-hidden="true"></span>
      </button>
    </header>

    <section class="scope" aria-label="What is covered">
      <p>Every benchmark named in <b>${data.releases.length.toLocaleString()}</b> official releases from <b>${labs.length}</b> frontier labs since ${years[0]}. ${esc(names.get(top.id) ?? top.id)} is the most widely cited, reported by all ${top.lab_count}.</p>
    </section>

    <section class="controls" aria-label="Track benchmarks"></section>
    <section class="trendwrap" aria-label="Adoption trend"></section>
    <section class="tlwrap" aria-label="Release timeline"></section>

    <footer class="ft">
      <p>Sources are each lab's own site, model card, system card, or arXiv paper. Nothing is taken from news coverage or third-party leaderboards, and no score is recorded anywhere.</p>
      <p>Updated ${data.generated_at.slice(0, 10)}. <a href="https://github.com/junkim100/benchmark-tracker">Data and code on GitHub</a></p>
    </footer>
    <div class="tt" role="tooltip" hidden></div>`;

  const $ = <T extends Element>(s: string) => app.querySelector<T>(s)!;
  const tt = $<HTMLDivElement>(".tt");

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

  const paintTheme = () => { $(".iconbtn__l").textContent = effective() === "dark" ? "Dark" : "Light"; };

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
        // picking a second benchmark means reaching for the mouse again.
        if (adding) app.querySelector<HTMLInputElement>(".pick__input")?.focus();
      },
    });
    renderTrend($(".trendwrap"), {
      tracked: tracked.map((id) => byId.get(id)!).filter(Boolean) as Benchmark[],
      releases: data.releases, labs, names, quarters: data.quarters, partialQuarter,
      view, onView: (v) => { view = v; draw(); }, onHover: showTip,
    });
    renderTimeline($(".tlwrap"), {
      labs, releases: data.releases, tracked, names, quarters: data.quarters,
      onHover: (rs, x, y) => showTip(rs && rs.length ? tooltipHTML(rs, names, window.innerHeight - 48) : null, x, y),
    });
    paintTheme();
  };

  app.addEventListener("click", (e) => {
    if (!(e.target as Element).closest('[data-act="theme"]')) return;
    localStorage.setItem("bt-theme", effective() === "dark" ? "light" : "dark");
    applyTheme(readTheme());
    paintTheme();
  });

  draw();
}
