// How many labs cited each tracked benchmark, quarter by quarter.
//
// This is the view the whole site exists for: adoption, saturation, and the
// quiet drop-off. Quarters rather than years because four annual points is not
// an arc, it is a sketch; fifteen quarters show when a benchmark actually
// caught on and when labs began leaving it out.
//
// Hovering a point names the labs and the models behind the count, because
// "six labs" is a number and "which six, and what did they ship" is the answer.

import { detailFor, quarterLabel, type Benchmark, type Lab, type Release } from "./model";

export type TrendView = "chart" | "table";

export interface TrendArgs {
  tracked: Benchmark[];
  releases: Release[];
  labs: Lab[];
  names: Map<string, string>;
  quarters: string[];
  partialQuarter: string | null;
  view: TrendView;
  onView: (v: TrendView) => void;
  onHover: (html: string | null, x: number, y: number) => void;
  onHoverFitted: (build: (n: number) => string, max: number, x: number, y: number) => void;
}

const W = 900, H = 330, M = { t: 22, r: 152, b: 52, l: 44 };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function renderTrend(host: HTMLElement, a: TrendArgs): void {
  if (a.tracked.length === 0) {
    host.innerHTML = `<div class="lede"><p>Pick a benchmark above. You will see how many labs cited it each quarter, and which ones stopped.</p></div>`;
    return;
  }

  const labName = new Map(a.labs.map((l) => [l.id, l.name]));
  const maxY = Math.max(1, ...a.tracked.flatMap((b) => Object.values(b.labs_by_quarter)));
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const px = (i: number) => M.l + (a.quarters.length < 2 ? iw / 2 : (i / (a.quarters.length - 1)) * iw);
  const py = (n: number) => M.t + ih - (n / maxY) * ih;
  const detail = new Map(a.tracked.map((b) => [b.id, detailFor(a.releases, b.id)]));

  // Series that finish on the same value would otherwise print their end labels
  // at identical coordinates and render as one unreadable overlap.
  const usedLabelY: number[] = [];
  const labelY = (want: number): number => {
    // Dodge alternately up and down, and stay inside the plot. An earlier
    // version only pushed downward with no bound, which walked labels into the
    // axis row and then out of the SVG entirely.
    const lo = M.t + 6, hi = M.t + ih - 6;
    const free = (y: number) => y >= lo && y <= hi && !usedLabelY.some((u) => Math.abs(u - y) < 15);
    if (free(want)) { usedLabelY.push(want); return want; }
    for (let step = 15; step <= ih; step += 15) {
      for (const y of [want - step, want + step]) if (free(y)) { usedLabelY.push(y); return y; }
    }
    usedLabelY.push(want);
    return Math.min(Math.max(want, lo), hi);
  };

  const series = a.tracked.map((b, si) => {
    const slot = si + 1;
    const pts = a.quarters.map((q, i) => ({ q, i, n: b.labs_by_quarter[q] ?? 0 }));
    const d = pts.map((p, j) => `${j ? "L" : "M"}${px(p.i).toFixed(1)},${py(p.n).toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1];
    const label = a.tracked.length <= 4
      ? (() => {
          const ly = labelY(py(last.n));
          // The right margin is the whole width budget. A name that would run
          // past it is truncated here rather than clipped by the scroller,
          // which produced a half-word with no ellipsis and no way to reach it.
          const full = a.names.get(b.id) ?? b.id;
          // 7.8px per character, measured against this face at 12.5px. The
          // earlier 6.1 under-counted and let 91 of 254 labels overrun the
          // margin, where the scroller clipped them without the ellipsis.
          const fits = Math.max(6, Math.floor((M.r - 26) / 7.8));
          const shown = full.length > fits ? `${full.slice(0, fits - 1)}\u2026` : full;
          return `<circle class="s-labeldot s${slot}" cx="${(px(last.i) + 11).toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5"/>` +
                 `<text class="s-label" x="${(px(last.i) + 20).toFixed(1)}" y="${ly.toFixed(1)}"><title>${esc(full)}</title>${esc(shown)}</text>`;
        })()
      : "";
    const dots = pts.map((p) => `
      <g class="s-hit" data-b="${esc(b.id)}" data-q="${p.q}">
        <circle class="s-halo" cx="${px(p.i).toFixed(1)}" cy="${py(p.n).toFixed(1)}" r="12"/>
        <circle class="s-dot s${slot}" cx="${px(p.i).toFixed(1)}" cy="${py(p.n).toFixed(1)}" r="3.6"/>
      </g>`).join("");
    return `<path class="s-line s${slot}" d="${d}"/>${dots}${label}`;
  }).join("");

  const gridY = Array.from({ length: maxY + 1 }, (_, n) => n).filter((n) => maxY <= 6 || n % 2 === 0);

  // Year boundaries carry the axis; quarters are ticked but only Q1 and Q3 are
  // labelled, because fifteen labels in that width collide.
  const yearMarks = a.quarters.map((q, i) => ({ q, i })).filter((x) => x.q.endsWith("Q1"));
  const qLabels = a.quarters.map((q, i) => ({ q, i })).filter((x) => x.q.endsWith("Q1") || x.q.endsWith("Q3"));
  const partialIdx = a.partialQuarter ? a.quarters.indexOf(a.partialQuarter) : -1;

  const chart = `
      <div class="trendscroll"><svg viewBox="0 0 ${W} ${H}" class="trend__svg" role="img" aria-label="Number of labs citing each tracked benchmark per quarter">
        ${gridY.map((n) => `<g class="grid"><line x1="${M.l}" y1="${py(n)}" x2="${W - M.r}" y2="${py(n)}"/><text x="${M.l - 11}" y="${py(n) + 4}">${n}</text></g>`).join("")}
        ${partialIdx >= 0 ? `<rect class="partial" x="${px(partialIdx) - iw / (a.quarters.length - 1) / 2}" y="${M.t}" width="${iw / (a.quarters.length - 1) / 2}" height="${ih}"/>` : ""}
        ${yearMarks.map((y) => `<line class="yearline" x1="${px(y.i)}" y1="${M.t}" x2="${px(y.i)}" y2="${M.t + ih}"/>`).join("")}
        ${qLabels.map((x) => `<text class="xq${x.i === partialIdx ? " xq--partial" : ""}" x="${px(x.i)}" y="${H - 28}">Q${x.q.slice(6)}</text>`).join("")}
        ${qLabels.map((x) => `<text class="xy${x.q.endsWith("Q1") ? " xy--first" : ""}" x="${px(x.i)}" y="${H - 10}">${x.q.slice(0, 4)}</text>`).join("")}
        ${series}
      </svg></div>
      ${a.tracked.length >= 5 ? `<ul class="legend">${a.tracked.map((b, i) => `<li class="s${i + 1}"><svg class="sw" viewBox="0 0 22 10" aria-hidden="true"><line x1="1" y1="5" x2="21" y2="5"/></svg>${esc(a.names.get(b.id) ?? b.id)}</li>`).join("")}</ul>` : ""}`;

  const years = [...new Set(a.quarters.map((q) => q.slice(0, 4)))];
  const table = `
      <div class="dtwrap">
      <table class="dt">
        <caption class="vh">Labs citing each tracked benchmark, by quarter</caption>
        <thead>
          <tr><td class="dt__corner"></td>${years.map((y) => `<th scope="colgroup" colspan="${a.quarters.filter((q) => q.startsWith(y)).length}" class="dt__year">${y}</th>`).join("")}<td class="dt__corner"></td></tr>
          <tr><th scope="col">Benchmark</th>${a.quarters.map((q) => `<th scope="col" class="${q === a.partialQuarter ? "dt__part" : ""}">Q${q.slice(6)}</th>`).join("")}<th scope="col">Peak</th></tr>
        </thead>
        <tbody>${a.tracked.map((b, i) => {
          const vals = a.quarters.map((q) => b.labs_by_quarter[q] ?? 0);
          const peak = Math.max(...vals);
          return `<tr>
            <th scope="row"><span class="dt__dot s${i + 1}"></span>${esc(a.names.get(b.id) ?? b.id)}</th>
            ${vals.map((v) => `<td${v === peak && peak > 0 ? ' class="dt__peak"' : ""}>${v || "–"}</td>`).join("")}
            <td class="dt__tot">${peak}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>`;

  host.innerHTML = `
    <figure class="trend">
      <div class="trend__bar">
        <figcaption>Labs citing each tracked benchmark, by quarter${a.partialQuarter ? `. ${quarterLabel(a.partialQuarter)} is still in progress and reads low.` : ""}</figcaption>
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
    const bid = g.getAttribute("data-b")!, q = g.getAttribute("data-q")!;
    const d = detail.get(bid)?.get(q);
    const n = d?.labs.length ?? 0;
    // The tooltip cannot scroll, because it ignores pointer events so it never
    // swallows a hover. So it must never promise more rows than it draws: at
    // ten labs the old fixed height showed four and silently ate six.
    const build = (SHOWN: number) => {
    const shown = d?.labs.slice(0, SHOWN) ?? [];
    const rows = n
      ? shown.map((l) => `<li><span class="tt__lab">${esc(labName.get(l.lab) ?? l.lab)}</span><span class="tt__models">${esc(l.models.slice(0, 3).join(", "))}${l.models.length > 3 ? ` and ${l.models.length - 3} more` : ""}</span></li>`).join("")
        + (n > SHOWN ? `<li class="tt__rest">and ${n - SHOWN} more ${n - SHOWN === 1 ? "lab" : "labs"}</li>` : "")
      : `<li class="muted">No lab cited it this quarter</li>`;
    return `<div class="tt__h">${esc(a.names.get(bid) ?? bid)}</div>
       <div class="tt__m">${n} lab${n === 1 ? "" : "s"} in ${quarterLabel(q)}</div>
       <ul class="tt__labs">${rows}</ul>`;
    };
    a.onHoverFitted(build, 7, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => a.onHover(null, 0, 0));
}
