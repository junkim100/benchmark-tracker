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

export interface TrendArgs {
  tracked: Benchmark[];
  releases: Release[];
  labs: Lab[];
  names: Map<string, string>;
  years: number[];
  partialYear: number | null;
  onHover: (html: string | null, x: number, y: number) => void;
}

const W = 760, H = 260, M = { t: 18, r: 132, b: 34, l: 38 };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function renderTrend(host: HTMLElement, a: TrendArgs): void {
  if (a.tracked.length === 0) {
    host.innerHTML = `<p class="muted trend__empty">Track a benchmark to see how many labs cited it each year, and which ones.</p>`;
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

  host.innerHTML = `
    <figure class="trend">
      <figcaption>Labs citing each tracked benchmark, by year${a.partialYear ? ` · ${a.partialYear} is still in progress and reads low` : ""}</figcaption>
      <svg viewBox="0 0 ${W} ${H}" class="trend__svg" role="img" aria-label="Number of labs citing each tracked benchmark per year">
        ${gridY.map((n) => `<g class="grid"><line x1="${M.l}" y1="${py(n)}" x2="${W - M.r}" y2="${py(n)}"/><text x="${M.l - 9}" y="${py(n) + 4}">${n}</text></g>`).join("")}
        ${a.partialYear !== null && a.years.length > 1 ? `<rect class="partial" x="${px(a.partialYear) - (iw / (a.years.length - 1)) / 2}" y="${M.t}" width="${(iw / (a.years.length - 1)) / 2 + M.r / 3}" height="${ih}"/>` : ""}
        ${a.years.map((y) => `<text class="xt${y === a.partialYear ? " xt--partial" : ""}" x="${px(y)}" y="${H - 12}">${y}${y === a.partialYear ? "*" : ""}</text>`).join("")}
        ${series}
      </svg>
      ${a.tracked.length >= 2 ? `<ul class="legend">${a.tracked.map((b, i) => `<li><span class="sw s${i + 1}"></span>${esc(a.names.get(b.id) ?? b.id)}</li>`).join("")}</ul>` : ""}
      <details class="tableview">
        <summary>Show as a table</summary>
        <table><thead><tr><th scope="col">Benchmark</th>${a.years.map((y) => `<th scope="col">${y}</th>`).join("")}</tr></thead>
        <tbody>${a.tracked.map((b) => `<tr><th scope="row">${esc(a.names.get(b.id) ?? b.id)}</th>${a.years.map((y) => `<td>${b.labs_by_year[String(y)] ?? 0}</td>`).join("")}</tr>`).join("")}</tbody></table>
      </details>
    </figure>`;

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
