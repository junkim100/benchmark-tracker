// How many labs cited each tracked benchmark, per year.
//
// This is the view the whole site exists for: adoption, saturation, and the
// quiet drop-off. The build precomputes labs_by_year, so this only draws.
//
// A table view ships alongside the chart. That is not optional decoration:
// three of the eight slots fall below 3:1 contrast on the light surface, and
// the rule for that is relief through visible labels or a table.

import type { Benchmark } from "./model";

export interface TrendArgs {
  tracked: Benchmark[];            // in slot order
  names: Map<string, string>;
  years: number[];
  partialYear: number | null;      // the in-progress year, which reads low
}

const W = 720, H = 240, M = { t: 16, r: 116, b: 28, l: 34 };

export function renderTrend(host: HTMLElement, a: TrendArgs): void {
  if (a.tracked.length === 0) {
    host.innerHTML = `<p class="muted trend__empty">Track a benchmark above to see how many labs cited it each year.</p>`;
    return;
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const maxY = Math.max(1, ...a.tracked.flatMap((b) => Object.values(b.labs_by_year)));
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const px = (y: number) => M.l + (a.years.length < 2 ? iw / 2 : ((y - a.years[0]) / (a.years.length - 1)) * iw);
  const py = (n: number) => M.t + ih - (n / maxY) * ih;

  const series = a.tracked.map((b, i) => {
    const slot = i + 1;
    const pts = a.years.map((y) => ({ y, n: b.labs_by_year[String(y)] ?? 0 }));
    const d = pts.map((p, j) => `${j ? "L" : "M"}${px(p.y).toFixed(1)},${py(p.n).toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1];
    // Direct labels up to four series; beyond that the legend carries identity.
    const label = a.tracked.length <= 4
      ? `<text class="s-label s${slot}" x="${(px(last.y) + 8).toFixed(1)}" y="${(py(last.n) + 4).toFixed(1)}">${esc(a.names.get(b.id) ?? b.id)}</text>`
      : "";
    const dots = pts.map((p) => `<circle class="s-dot s${slot}" cx="${px(p.y).toFixed(1)}" cy="${py(p.n).toFixed(1)}" r="4.5"><title>${esc(a.names.get(b.id) ?? b.id)} · ${p.y} · ${p.n} lab${p.n === 1 ? "" : "s"}</title></circle>`).join("");
    return `<path class="s-line s${slot}" d="${d}"/>${dots}${label}`;
  }).join("");

  const gridY = Array.from({ length: maxY + 1 }, (_, n) => n).filter((n) => maxY <= 6 || n % 2 === 0);

  host.innerHTML = `
    <figure class="trend">
      <figcaption>Labs citing each tracked benchmark, by year${a.partialYear ? ` · ${a.partialYear} is still in progress and will read low` : ""}</figcaption>
      <svg viewBox="0 0 ${W} ${H}" class="trend__svg" role="img" aria-label="Line chart: number of labs citing each tracked benchmark per year">
        ${gridY.map((n) => `<g class="grid"><line x1="${M.l}" y1="${py(n)}" x2="${W - M.r}" y2="${py(n)}"/><text x="${M.l - 8}" y="${py(n) + 4}">${n}</text></g>`).join("")}
        ${a.partialYear !== null && a.years.length > 1 ? `<rect class="partial" x="${px(a.partialYear) - (iw / (a.years.length - 1)) / 2}" y="${M.t}" width="${(iw / (a.years.length - 1)) / 2 + M.r / 3}" height="${ih}"/>` : ""}
        ${a.years.map((y) => `<text class="xt${y === a.partialYear ? " xt--partial" : ""}" x="${px(y)}" y="${H - 8}">${y}${y === a.partialYear ? "*" : ""}</text>`).join("")}
        ${series}
      </svg>
      ${a.tracked.length >= 2 ? `<ul class="legend">${a.tracked.map((b, i) => `<li><span class="sw s${i + 1}"></span>${esc(a.names.get(b.id) ?? b.id)}</li>`).join("")}</ul>` : ""}
      <details class="tableview">
        <summary>Show as a table</summary>
        <table><thead><tr><th scope="col">Benchmark</th>${a.years.map((y) => `<th scope="col">${y}</th>`).join("")}</tr></thead>
        <tbody>${a.tracked.map((b) => `<tr><th scope="row">${esc(a.names.get(b.id) ?? b.id)}</th>${a.years.map((y) => `<td>${b.labs_by_year[String(y)] ?? 0}</td>`).join("")}</tr>`).join("")}</tbody></table>
      </details>
    </figure>`;
}
