// How many labs cited each tracked benchmark, quarter by quarter.
//
// This is the view the whole site exists for: adoption, saturation, and the
// quiet drop-off. Quarters rather than years because four annual points is not
// an arc, it is a sketch; fifteen quarters show when a benchmark actually
// caught on and when labs began leaving it out.
//
// Hovering a point names the labs and the models behind the count, because
// "six labs" is a number and "which six, and what did they ship" is the answer.

import { detailFor, memberIds, quarterLabel, type Benchmark, type Lab, type Release, type Trackable } from "./model";
import { clearPicked, type SheetRequest } from "./sheet";

export type TrendView = "chart" | "table";

export interface TrendArgs {
  tracked: Trackable[];
  benchmarks: Benchmark[];
  releases: Release[];
  labs: Lab[];
  quarters: string[];
  partialQuarter: string | null;
  view: TrendView;
  onView: (v: TrendView) => void;
  onHover: (html: string | null, x: number, y: number) => void;
  onHoverFitted: (build: (n: number) => string, max: number, x: number, y: number) => void;
  /** A tap, on a pointer that cannot hover. Null closes whatever is open. */
  onPick: (r: SheetRequest | null) => void;
}

// A press counts as a tap, not a scroll, within this much travel and this long.
const TAP_SLOP = 10;
const TAP_MS = 700;


// Survives re-renders, per scroller. Null means "never scrolled", which opens
// at the most recent end rather than at 2023.
const lastScroll: Record<string, number | null> = { ".dtwrap": null, ".trendscroll": null };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function renderTrend(host: HTMLElement, a: TrendArgs): void {
  if (a.tracked.length === 0) {
    host.innerHTML = `<div class="lede"><p>Pick a benchmark above. You will see how many labs cited it each quarter, and which ones stopped.</p></div>`;
    return;
  }

  // The canvas is the container, not a fixed 900. It used to be pinned to 900
  // in both min and max width, so a 351px phone got a third of the chart and a
  // scrollbar, and scaling it down instead would have taken the axis text with
  // it. Measuring means one pixel of viewBox is one pixel on screen at every
  // size, so the type stays the size it was drawn at.
  const avail = Math.round(host.getBoundingClientRect().width) || 900;
  const narrow = avail < 640;
  // The floor has to sit below any real viewport or it stops being a floor and
  // starts being a stretch: at a 320px screen the box measures 284 and a floor
  // of 300 had the CSS scale 300 units into 284 pixels, shrinking the axis type
  // by 5.3% at the one width where it can least afford it.
  const W = Math.max(240, avail);
  // Direct end labels are drawn for four series or fewer; past that they
  // collide and the legend does the work. The right margin exists only to hold
  // them, so it has to follow the same condition. It did not, so tracking five
  // things left 152px of empty gutter, 22 per cent of the chart at 768.
  const showEndLabels = !narrow && a.tracked.length <= 4;
  // Height follows width so the plot keeps its proportions instead of flattening
  // into a strip on a wide screen and squaring up on a phone. Bounded at both
  // ends: below 300 the gridlines crowd, above 430 the chart starts asking for
  // more of the fold than it earns.
  const H = Math.round(Math.min(430, Math.max(300, W * 0.36)));
  // The right margin exists only to hold the direct end labels. Below 640 there
  // is no room for them, so the margin goes and the legend underneath does that
  // work instead.
  const M = { t: 22, r: showEndLabels ? 152 : 16, b: 52, l: narrow ? 32 : 44 };

  const labName = new Map(a.labs.map((l) => [l.id, l.name]));
  const maxY = Math.max(1, ...a.tracked.flatMap((b) => Object.values(b.labs_by_quarter) as number[]));
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const px = (i: number) => M.l + (a.quarters.length < 2 ? iw / 2 : (i / (a.quarters.length - 1)) * iw);
  const py = (n: number) => M.t + ih - (n / maxY) * ih;
  const detail = new Map(a.tracked.map((b) => [b.id, detailFor(a.releases, memberIds(b, a.benchmarks))]));

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
    const label = showEndLabels
      ? (() => {
          const ly = labelY(py(last.n));
          // The right margin is the whole width budget. A name that would run
          // past it is truncated here rather than clipped by the scroller,
          // which produced a half-word with no ellipsis and no way to reach it.
          // The trackable carries its own name. Reading it from the benchmark
          // name map instead printed the raw id for anything that is not a
          // benchmark, so a tracked suite was labelled "suite:gdpval".
          const full = b.name;
          // 5.9px per character, measured on the rendered face at 12.5px. The
          // previous 7.8 over-counted and cut names that fitted: "GDPval, all
          // versions" needs 115.6px against a 126px budget and was still
          // truncated, and the cuts landed mid-punctuation, giving
          // "Terminal-Bench,…" and "HumanEval, all …".
          const fits = Math.max(6, Math.floor((M.r - 26) / 5.9));
          // Never end on a comma or a space before the ellipsis.
          const cut = full.slice(0, fits - 1).replace(/[\s,]+$/, "");
          const shown = full.length > fits ? `${cut}\u2026` : full;
          return `<circle class="s-labeldot s${slot}" cx="${(px(last.i) + 11).toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5"/>` +
                 `<text class="s-label" x="${(px(last.i) + 20).toFixed(1)}" y="${ly.toFixed(1)}"><title>${esc(full)}</title>${esc(shown)}</text>`;
        })()
      : "";
    const dots = pts.map((p) => `<circle class="s-dot s${slot}" cx="${px(p.i).toFixed(1)}" cy="${py(p.n).toFixed(1)}" r="3.6"/>`).join("");
    return `<path class="s-line s${slot}" d="${d}"/>${dots}${label}`;
  }).join("");

  // Always label the peak. Filtering to even values left an odd maximum
  // floating above the highest gridline, which 14 benchmarks hit.
  const gridY = [...new Set([...Array.from({ length: maxY + 1 }, (_, n) => n).filter((n) => maxY <= 6 || n % 2 === 0), maxY])].sort((x, y) => x - y);

  // Year boundaries carry the axis; quarters are ticked but only Q1 and Q3 are
  // labelled, because fifteen labels in that width collide.
  const yearMarks = a.quarters.map((q, i) => ({ q, i })).filter((x) => x.q.endsWith("Q1"));
  // Q1 and Q3 at full width; Q1 alone when narrow, where eight labels across
  // 300-odd pixels would touch.
  const qLabels = a.quarters.map((q, i) => ({ q, i }))
    .filter((x) => x.q.endsWith("Q1") || (!narrow && x.q.endsWith("Q3")));
  const partialIdx = a.partialQuarter ? a.quarters.indexOf(a.partialQuarter) : -1;

  const chart = `
      <div class="trendscroll"><svg viewBox="0 0 ${W} ${H}" class="trend__svg" role="img" aria-label="Number of labs citing each tracked benchmark per quarter">
        ${gridY.map((n) => `<g class="grid"><line x1="${M.l}" y1="${py(n)}" x2="${W - M.r}" y2="${py(n)}"/><text x="${M.l - 11}" y="${py(n) + 4}">${n}</text></g>`).join("")}
        ${partialIdx >= 0 ? `<rect class="partial" x="${px(partialIdx) - iw / (a.quarters.length - 1) / 2}" y="${M.t}" width="${iw / (a.quarters.length - 1) / 2}" height="${ih}"/>` : ""}
        ${yearMarks.map((y) => `<line class="yearline" x1="${px(y.i)}" y1="${M.t}" x2="${px(y.i)}" y2="${M.t + ih}"/>`).join("")}
        ${qLabels.map((x) => `<text class="xq${x.i === partialIdx ? " xq--partial" : ""}" x="${px(x.i)}" y="${H - 28}">Q${x.q.slice(6)}</text>`).join("")}
        ${qLabels.map((x) => `<text class="xy${x.q.endsWith("Q1") ? " xy--first" : ""}" x="${px(x.i)}" y="${H - 10}">${x.q.slice(0, 4)}</text>`).join("")}
        ${series}
        <g class="qbands">${a.quarters.map((q, i) => {
          const half = a.quarters.length > 1 ? iw / (a.quarters.length - 1) / 2 : iw / 2;
          return `<rect class="qband" data-q="${q}" x="${(px(i) - half).toFixed(1)}" y="${M.t}" width="${(half * 2).toFixed(1)}" height="${ih}"/>`;
        }).join("")}</g>
      </svg></div>
      ${a.tracked.length && !showEndLabels ? `<ul class="legend">${a.tracked.map((b, i) => `<li class="s${i + 1}"><svg class="sw" viewBox="0 0 22 10" aria-hidden="true"><line x1="1" y1="5" x2="21" y2="5"/></svg>${esc(b.name)}</li>`).join("")}</ul>` : ""}`;

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
          // The row carries the slot so each cell can tint itself by value.
          // Sixteen columns of bare digits are read one at a time; a wash in
          // the series' own colour lets the shape of a row be seen at once,
          // and ties the table to the chart it replaces.
          return `<tr class="s${i + 1}">
            <th scope="row"><span class="dt__dot"></span>${esc(b.name)}</th>
            ${vals.map((v) => `<td style="--v:${(v / maxY).toFixed(3)}"${v === peak && peak > 0 ? ' class="dt__peak"' : ""}>${v || "–"}</td>`).join("")}
            <td class="dt__tot">${peak}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>`;

  host.innerHTML = `
    <figure class="trend">
      <div class="trend__bar">
        <figcaption>${a.partialQuarter ? `${quarterLabel(a.partialQuarter)} is still in progress and reads low.` : ""}</figcaption>
        <div class="seg" role="group" aria-label="Trend view">
          <button type="button" data-view="chart" aria-pressed="${a.view === "chart"}">Chart</button>
          <button type="button" data-view="table" aria-pressed="${a.view === "table"}">Table</button>
        </div>
      </div>
      ${a.view === "chart" ? chart : table}
    </figure>`;

  // Both scrollers open on the present. The table is 18 columns wide and a
  // phone shows five of them, so starting at the left put the reader in Q1 2023
  // and asked them to drag through three years to reach what they came for.
  //
  // The position is remembered so that tracking a benchmark does not throw the
  // reader back. It is a horizontal offset, which this project has learned to
  // be careful with, but the scale here never changes: the columns are quarters
  // and a quarter is a quarter at every width.
  for (const sel of [".dtwrap", ".trendscroll"] as const) {
    const el = host.querySelector<HTMLElement>(sel);
    if (!el) continue;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 0) continue;
    const kept = lastScroll[sel];
    el.scrollLeft = kept == null ? max : Math.min(kept, max);
    el.addEventListener("scroll", () => { lastScroll[sel] = el.scrollLeft; }, { passive: true });
  }

  host.querySelector(".seg")!.addEventListener("click", (e) => {
    const v = (e.target as Element).closest("button")?.getAttribute("data-view") as TrendView | undefined;
    if (v && v !== a.view) a.onView(v);
  });

  if (a.view === "table") return;

  const svg = host.querySelector<SVGSVGElement>(".trend__svg")!;

  // Which interaction a reader gets follows the pointer in their hand rather than the width of their screen, for the reason the timeline gives: a laptop with a touchscreen has both and should get whichever is in use.
  let coarse = matchMedia("(hover: none)").matches;
  const notePointer = (e: PointerEvent) => { coarse = e.pointerType !== "mouse"; };
  svg.addEventListener("pointerdown", notePointer, { passive: true });
  svg.addEventListener("pointermove", notePointer, { passive: true });

  // Every tracked series for this quarter, so two sharing a value are both reported rather than one hiding the other. Shared by the hover tooltip, which trims the lab lists to fit beside a cursor, and by the tap panel, which scrolls and so names them all.
  const rowsFor = (q: string, rows: number) =>
    a.tracked.map((b, i) => {
      const cnt = b.labs_by_quarter[q] ?? 0;
      const det = detail.get(b.id)?.get(q);
      const labs = det?.labs.slice(0, rows).map((l) => labName.get(l.lab) ?? l.lab) ?? [];
      const more = (det?.labs.length ?? 0) - labs.length;
      return `<li class="tt__row s${i + 1}">
            <span class="tt__swatch" aria-hidden="true"></span>
            <span class="tt__name">${esc(b.name)}</span>
            <span class="tt__n">${cnt}</span>
            ${labs.length ? `<span class="tt__who">${esc(labs.join(", "))}${more > 0 ? ` and ${more} more` : ""}</span>` : ""}
          </li>`;
    }).join("");

  svg.addEventListener("mousemove", (e) => {
    if (coarse) return;
    const band = (e.target as Element).closest?.(".qband");
    if (!band) { a.onHover(null, 0, 0); return; }
    const q = band.getAttribute("data-q")!;
    svg.querySelectorAll(".qband").forEach((r) => r.classList.toggle("on", r === band));
    a.onHoverFitted((rows) => `<div class="tt__h">${quarterLabel(q)}</div>
        <div class="tt__m">labs citing each tracked benchmark</div>
        <ul class="tt__rows">${rowsFor(q, rows)}</ul>`, 6, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => {
    svg.querySelectorAll(".qband").forEach((r) => r.classList.remove("on"));
    a.onHover(null, 0, 0);
  });

  // Touch. The bands tile the plot with no gaps, but at 390px each one is only 21.6px wide, under the 24px a finger is entitled to and well under a fingertip, so the panel carries a step to either side: landing on the wrong quarter costs one press rather than a second attempt at a 21px target.
  const step = (q: string, dir: -1 | 1) => {
    const to = a.quarters[a.quarters.indexOf(q) + dir];
    if (!to) return "";
    const arrow = dir < 0 ? `<path d="M10 13 5 8l5-5"/>` : `<path d="m6 3 5 5-5 5"/>`;
    const svgIcon = `<svg viewBox="0 0 16 16" aria-hidden="true">${arrow}</svg>`;
    return `<button class="sheet__step" type="button" data-sheet-act="${esc(to)}">${
      dir < 0 ? svgIcon + esc(quarterLabel(to)) : esc(quarterLabel(to)) + svgIcon}</button>`;
  };
  const pickQuarter = (q: string): SheetRequest | null => {
    const band = svg.querySelector(`.qband[data-q="${CSS.escape(q)}"]`);
    if (!band) return null;
    // `on` belongs to hover and `is-picked` to the panel, kept apart so that closing the panel, which clears only its own class, cannot leave a band shaded with nothing open to explain it.
    clearPicked();
    svg.querySelectorAll(".qband").forEach((r) => r.classList.remove("on"));
    band.classList.add("is-picked");
    return {
      title: quarterLabel(q),
      html: `<p class="sheet__k">Labs citing each tracked benchmark.</p>
        <ul class="tt__rows">${rowsFor(q, 40)}</ul>
        <div class="sheet__steps">${step(q, -1)}${step(q, 1)}</div>`,
      onAct: (to) => a.onPick(pickQuarter(to)),
    };
  };

  let down: { x: number; y: number; t: number } | null = null;
  svg.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; }, { passive: true });
  svg.addEventListener("pointercancel", () => { down = null; }, { passive: true });
  svg.addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    if (!coarse || !d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP || e.timeStamp - d.t > TAP_MS) return;
    a.onHover(null, 0, 0);
    const band = (e.target as Element).closest?.(".qband");
    // Tapping the open quarter again shuts the panel, so it can be dismissed where the reader is already looking rather than at the close button.
    if (!band || band.classList.contains("is-picked")) { a.onPick(null); return; }
    a.onPick(pickQuarter(band.getAttribute("data-q")!));
  }, { passive: true });
}
