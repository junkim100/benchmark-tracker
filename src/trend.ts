// How many labs cited each tracked benchmark, per year.
//
// This is the view the whole site exists for: adoption, saturation, and the
// quiet drop-off. Hovering a point names the labs and the models behind the
// count, because "six labs" is a number and "which six, and what did they
// ship" is the actual answer.
//
// A table view ships alongside the chart. That is not decoration: three of the
// eight slots fall below 3:1 contrast on the light surface, and the rule for
// that is relief through visible labels or a table.

import { detailFor, type Benchmark, type Lab, type Release } from "./model";

export type TrendView = "chart" | "table";

export interface TrendArgs {
  tracked: Benchmark[];
  releases: Release[];
  labs: Lab[];
  names: Map<string, string>;
  years: number[];
  partialYear: number | null;
  view: TrendView;
  onView: (v: TrendView) => void;
  onHover: (html: string | null, x: number, y: number) => void;
}

const W = 860, H = 320, M = { t: 22, r: 150, b: 40, l: 44 };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function renderTrend(host: HTMLElement, a: TrendArgs): void {
  if (a.tracked.length === 0) {
    host.innerHTML = `
      <div class="lede">
        <p>Pick a benchmark above. You will see how many labs cited it each year, and which ones stopped.</p>
      </div>`;
    return;
  }

  const labName = new Map(a.labs.map((l) => [l.id, l.name]));
  const maxY = Math.max(1, ...a.tracked.flatMap((b) => Object.values(b.labs_by_year)));
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const px = (y: number) => M.l + (a.years.length < 2 ? iw / 2 : ((y - a.years[0]) / (a.years.length - 1)) * iw);
  const py = (n: number) => M.t + ih - (n / maxY) * ih;

  const detail = new Map(a.tracked.map((b) => [b.id, detailFor(a.releases, b.id, a.years)]));

  const series = a.tracked.map((b, i) => {
    const slot = i + 1;
    const pts = a.years.map((y) => ({ y, n: b.labs_by_year[String(y)] ?? 0 }));
    const d = pts.map((p, j) => `${j ? "L" : "M"}${px(p.y).toFixed(1)},${py(p.n).toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1];
    const label = a.tracked.length <= 4
      ? `<text class="s-label s${slot}" x="${(px(last.y) + 10).toFixed(1)}" y="${(py(last.n) + 4).toFixed(1)}">${esc(a.names.get(b.id) ?? b.id)}</text>`
      : "";
    // Hit targets are deliberately larger than the visible dot.
    const dots = pts.map((p) => `
      <g class="s-hit" data-b="${esc(b.id)}" data-y="${p.y}">
        <circle class="s-halo" cx="${px(p.y).toFixed(1)}" cy="${py(p.n).toFixed(1)}" r="13"/>
        <circle class="s-dot s${slot}" cx="${px(p.y).toFixed(1)}" cy="${py(p.n).toFixed(1)}" r="4.5"/>
      </g>`).join("");
    return `<path class="s-line s${slot}" d="${d}"/>${dots}${label}`;
  }).join("");

  const gridY = Array.from({ length: maxY + 1 }, (_, n) => n).filter((n) => maxY <= 6 || n % 2 === 0);

  const chart = `
      <svg viewBox="0 0 ${W} ${H}" class="trend__svg" role="img" aria-label="Number of labs citing each tracked benchmark per year">
        ${gridY.map((n) => `<g class="grid"><line x1="${M.l}" y1="${py(n)}" x2="${W - M.r}" y2="${py(n)}"/><text x="${M.l - 11}" y="${py(n) + 4}">${n}</text></g>`).join("")}
        ${a.partialYear !== null && a.years.length > 1 ? `<rect class="partial" x="${px(a.partialYear) - (iw / (a.years.length - 1)) / 2}" y="${M.t}" width="${(iw / (a.years.length - 1)) / 2 + M.r / 3}" height="${ih}"/>` : ""}
        ${a.years.map((y) => `<text class="xt${y === a.partialYear ? " xt--partial" : ""}" x="${px(y)}" y="${H - 14}">${y}${y === a.partialYear ? "*" : ""}</text>`).join("")}
        ${series}
      </svg>
      ${a.tracked.length >= 5 ? `<ul class="legend">${a.tracked.map((b, i) => `<li><span class="sw s${i + 1}"></span>${esc(a.names.get(b.id) ?? b.id)}</li>`).join("")}</ul>` : ""}`;

  const table = `
      <table class="dt">
        <caption class="vh">Labs citing each tracked benchmark, by year</caption>
        <thead><tr><th scope="col">Benchmark</th>${a.years.map((y) => `<th scope="col">${y}${y === a.partialYear ? "*" : ""}</th>`).join("")}<th scope="col">Peak</th></tr></thead>
        <tbody>${a.tracked.map((b, i) => {
          const vals = a.years.map((y) => b.labs_by_year[String(y)] ?? 0);
          const peak = Math.max(...vals);
          return `<tr>
            <th scope="row"><span class="dt__dot s${i + 1}"></span>${esc(a.names.get(b.id) ?? b.id)}</th>
            ${vals.map((v, k) => `<td${v === peak && peak > 0 ? ' class="dt__peak"' : ""}>${v || "\u2013"}${k === vals.length - 1 && a.partialYear ? "" : ""}</td>`).join("")}
            <td class="dt__tot">${peak}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>`;

  host.innerHTML = `
    <figure class="trend">
      <div class="trend__bar">
        <figcaption>Labs citing each tracked benchmark${a.partialYear ? `. ${a.partialYear} is still in progress and reads low` : ""}</figcaption>
        <div class="seg" role="tablist" aria-label="Trend view">
          <button role="tab" type="button" data-view="chart" aria-selected="${a.view === "chart"}">Chart</button>
          <button role="tab" type="button" data-view="table" aria-selected="${a.view === "table"}">Table</button>
        </div>
      </div>
      ${a.view === "chart" ? chart : table}
    </figure>`;

  host.querySelector(".seg")!.addEventListener("click", (e) => {
    const v = (e.target as Element).closest("button")?.getAttribute("data-view") as TrendView | undefined;
    if (v && v !== a.view) a.onView(v);
  });

  if (a.view === "table") return;

  const svg = host.querySelector<SVGSVGElement>(".trend__svg")!;
  svg.addEventListener("mousemove", (e) => {
    const g = (e.target as Element).closest?.(".s-hit");
    if (!g) { a.onHover(null, 0, 0); return; }
    const bid = g.getAttribute("data-b")!, yr = Number(g.getAttribute("data-y"));
    const d = detail.get(bid)?.get(yr);
    const name = a.names.get(bid) ?? bid;
    const n = d?.labs.length ?? 0;
    const rows = n
      ? d!.labs.map((l) => `<li><span class="tt__lab">${esc(labName.get(l.lab) ?? l.lab)}</span><span class="tt__models">${esc(l.models.slice(0, 4).join(", "))}${l.models.length > 4 ? ` +${l.models.length - 4}` : ""}</span></li>`).join("")
      : `<li class="muted">No lab cited it this year</li>`;
    a.onHover(
      `<div class="tt__h">${esc(name)} · ${yr}</div>
       <div class="tt__m">${n} lab${n === 1 ? "" : "s"}</div>
       <ul class="tt__labs">${rows}</ul>`,
      e.clientX, e.clientY,
    );
  });
  svg.addEventListener("mouseleave", () => a.onHover(null, 0, 0));
}
