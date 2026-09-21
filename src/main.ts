import "./styles/tokens.css";
import "./styles/app.css";
import raw from "../data/timeline.json";
import { MAX_TRACKED, displayNames, yearsSpanned, type Benchmark, type Timeline } from "./model";
import { renderFilter } from "./filter";
import { renderTimeline, tooltipHTML } from "./timeline";
import { renderTrend } from "./trend";

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
  const partialYear = years.includes(new Date().getUTCFullYear()) ? new Date().getUTCFullYear() : null;
  const byId = new Map(data.benchmarks.map((b) => [b.id, b]));
  const top = data.benchmarks[0];

  let tracked: string[] = [];

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

    <section class="stats" aria-label="Coverage">
      <div class="stat"><span class="stat__n">${data.releases.length.toLocaleString()}</span><span class="stat__l">releases</span></div>
      <div class="stat"><span class="stat__n">${data.labs.length}</span><span class="stat__l">labs</span></div>
      <div class="stat"><span class="stat__n">${data.benchmarks.length.toLocaleString()}</span><span class="stat__l">benchmarks</span></div>
      <div class="stat stat--wide"><span class="stat__n">${esc(names.get(top.id) ?? top.id)}</span><span class="stat__l">most widely cited, ${top.lab_count} labs</span></div>
    </section>

    <section class="controls" aria-label="Track benchmarks"></section>
    <section class="trendwrap" aria-label="Adoption trend"></section>
    <section class="tlwrap" aria-label="Release timeline"></section>

    <footer class="ft">
      <span>Official lab sources only. No scores, by design.</span>
      <span>Generated ${data.generated_at.slice(0, 10)} · <a href="https://github.com/junkim100/benchmark-tracker">source</a></span>
    </footer>
    <div class="tt" role="tooltip" hidden></div>`;

  const $ = <T extends Element>(s: string) => app.querySelector<T>(s)!;
  const tt = $<HTMLDivElement>(".tt");

  const showTip = (html: string | null, x: number, y: number) => {
    if (!html) { tt.hidden = true; return; }
    tt.innerHTML = html;
    tt.hidden = false;
    const b = tt.getBoundingClientRect();
    tt.style.left = `${Math.max(8, Math.min(x + 16, window.innerWidth - b.width - 12))}px`;
    tt.style.top = `${Math.max(8, Math.min(y + 16, window.innerHeight - b.height - 12))}px`;
  };

  const paintTheme = () => { $(".iconbtn__l").textContent = effective() === "dark" ? "Dark" : "Light"; };

  const draw = () => {
    renderFilter($(".controls"), {
      benchmarks: data.benchmarks, names, tracked,
      onToggle: (id) => {
        tracked = tracked.includes(id)
          ? tracked.filter((t) => t !== id)
          : tracked.length < MAX_TRACKED ? [...tracked, id] : tracked;
        draw();
      },
    });
    renderTrend($(".trendwrap"), {
      tracked: tracked.map((id) => byId.get(id)!).filter(Boolean) as Benchmark[],
      releases: data.releases, labs: data.labs, names, years, partialYear, onHover: showTip,
    });
    renderTimeline($(".tlwrap"), {
      labs: data.labs, releases: data.releases, tracked, names,
      onHover: (rs, x, y) => showTip(rs && rs.length ? tooltipHTML(rs, names) : null, x, y),
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
