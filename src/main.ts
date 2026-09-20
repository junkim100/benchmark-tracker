import "./styles/tokens.css";
import "./styles/app.css";
import raw from "../data/timeline.json";
import { MAX_TRACKED, displayNames, yearsSpanned, type Benchmark, type Timeline } from "./model";
import { renderTimeline, tooltipHTML } from "./timeline";
import { renderTrend } from "./trend";

const data = raw as unknown as Timeline;
const app = document.querySelector<HTMLDivElement>("#app")!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

if (data.releases.length === 0) {
  app.innerHTML = `<main class="empty"><h1>Benchmark Tracker</h1>
    <p>Which benchmarks frontier labs actually cite when they ship a model. No scores, only what each lab chose to report.</p>
    <p class="muted">Tracking ${data.labs.length} labs. No releases recorded yet.</p></main>`;
} else {
  const names = displayNames(data.releases);
  const years = yearsSpanned(data.releases);
  // The current year is incomplete, so its counts read low. Saying so beats
  // letting every benchmark look like it is dying each January.
  const partialYear = years.includes(new Date().getUTCFullYear()) ? new Date().getUTCFullYear() : null;
  const byId = new Map(data.benchmarks.map((b) => [b.id, b]));

  // Slot order is assignment order, so deselecting one never repaints the rest.
  let tracked: string[] = [];
  let query = "";

  app.innerHTML = `
    <header class="hd">
      <h1>Benchmark Tracker</h1>
      <p class="sub">Which benchmarks frontier labs cite when they ship. Not how they scored.</p>
      <button class="theme" type="button" aria-label="Switch colour theme">Theme</button>
    </header>
    <section class="controls" aria-label="Track benchmarks">
      <label class="srch"><span class="vh">Search benchmarks</span>
        <input type="search" placeholder="Search ${data.benchmarks.length} benchmarks, e.g. GSM8K" autocomplete="off"/>
      </label>
      <div class="chips" aria-live="polite"></div>
      <ul class="sugg" role="listbox" aria-label="Benchmark suggestions"></ul>
    </section>
    <section class="trendwrap" aria-label="Adoption trend"></section>
    <section class="tlwrap" aria-label="Release timeline"></section>
    <footer class="ft">
      <span>${data.releases.length} releases · ${data.labs.length} labs · ${data.benchmarks.length} benchmarks</span>
      <span>Official lab sources only. Generated ${data.generated_at.slice(0, 10)}.</span>
    </footer>
    <div class="tt" role="tooltip" hidden></div>`;

  const $ = <T extends Element>(s: string) => app.querySelector<T>(s)!;
  const input = $<HTMLInputElement>(".srch input");
  const chips = $<HTMLDivElement>(".chips");
  const sugg = $<HTMLUListElement>(".sugg");
  const tt = $<HTMLDivElement>(".tt");

  const drawChips = () => {
    chips.innerHTML = tracked.length
      ? tracked.map((id, i) => `<button class="chip s${i + 1}" data-id="${esc(id)}" type="button">${esc(names.get(id) ?? id)}<span aria-hidden="true">×</span><span class="vh">, stop tracking</span></button>`).join("")
      : `<span class="muted">Nothing tracked yet. Up to ${MAX_TRACKED} at once.</span>`;
  };

  const drawSuggestions = () => {
    const q = query.trim().toLowerCase();
    if (!q) { sugg.innerHTML = ""; return; }
    const hits = data.benchmarks
      .filter((b) => !tracked.includes(b.id) && (names.get(b.id) ?? b.id).toLowerCase().includes(q))
      .slice(0, 8);
    sugg.innerHTML = hits.length
      ? hits.map((b) => `<li><button type="button" data-id="${esc(b.id)}">${esc(names.get(b.id) ?? b.id)}<span class="muted"> · ${b.lab_count} lab${b.lab_count === 1 ? "" : "s"}</span></button></li>`).join("")
      : `<li class="muted no">No benchmark matches that.</li>`;
  };

  const draw = () => {
    drawChips();
    drawSuggestions();
    renderTrend($(".trendwrap"), { tracked: tracked.map((id) => byId.get(id)!).filter(Boolean) as Benchmark[], names, years, partialYear });
    renderTimeline($(".tlwrap"), {
      labs: data.labs, releases: data.releases, tracked, names,
      onHover: (rs, x, y) => {
        if (!rs || rs.length === 0) { tt.hidden = true; return; }
        tt.innerHTML = tooltipHTML(rs, names);
        tt.hidden = false;
        const box = tt.getBoundingClientRect();
        tt.style.left = `${Math.min(x + 14, window.innerWidth - box.width - 12)}px`;
        tt.style.top = `${Math.min(y + 14, window.innerHeight - box.height - 12)}px`;
      },
    });
  };

  input.addEventListener("input", () => { query = input.value; drawSuggestions(); });
  sugg.addEventListener("click", (e) => {
    const id = (e.target as Element).closest("button")?.getAttribute("data-id");
    if (!id || tracked.length >= MAX_TRACKED || tracked.includes(id)) return;
    tracked.push(id); query = ""; input.value = ""; draw();
  });
  chips.addEventListener("click", (e) => {
    const id = (e.target as Element).closest("button")?.getAttribute("data-id");
    if (!id) return;
    tracked = tracked.filter((t) => t !== id); draw();
  });
  $(".theme").addEventListener("click", () => {
    const now = document.documentElement.getAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", now === "dark" ? "light" : "dark");
  });

  draw();
}
