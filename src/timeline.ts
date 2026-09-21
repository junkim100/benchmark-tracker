// The horizontal timeline: one row per lab, releases positioned by date.
//
// Lab identity is carried by the sticky left column, never by colour. Twelve
// categories cannot be told apart by hue, and the validated palette caps at
// eight, so the eight slots are spent on tracked benchmarks instead. A release
// that cites nothing tracked stays neutral; one that cites a tracked benchmark
// is drawn in that benchmark's fixed slot colour.

import { KIND_LABEL, dayNumber, type Lab, type Release } from "./model";

const ROW_H = 40;
const PAD_DAYS = 45;
// Density is set by the busiest lab, not by the viewport. Google publishes on
// 140 distinct days across this span; at six pixels per day its marks sit a
// median 36px apart and stay individually hoverable. Anything tighter collapses
// them into a smear, which is the one thing a timeline must not do.
const PX_PER_DAY = 6;

export interface TimelineArgs {
  labs: Lab[];
  quarters: string[];
  releases: Release[];
  tracked: string[];               // benchmark ids, in slot order
  names: Map<string, string>;
  onHover: (rs: Release[] | null, x: number, y: number) => void;
}

// Survives re-renders. Tracking a benchmark redraws the timeline, and a reader
// who had scrolled to mid-2024 should not be thrown back to the present.
let lastScroll: number | null = null;

export function renderTimeline(host: HTMLElement, a: TimelineArgs): void {
  const keep = host.querySelector<HTMLDivElement>(".tl__scroll");
  if (keep) lastScroll = keep.scrollLeft;
  const days = a.releases.map((r) => dayNumber(r.date));
  const lo = Math.min(...days) - PAD_DAYS;
  const hi = Math.max(...days) + PAD_DAYS;
  const width = Math.round((hi - lo) * PX_PER_DAY);
  const height = a.labs.length * ROW_H;
  const x = (iso: string) => (dayNumber(iso) - lo) * PX_PER_DAY;

  const slotOf = new Map(a.tracked.map((id, i) => [id, i + 1]));

  // A quarter grid rather than a year grid. Quarter boundaries are ticked and
  // labelled; the first quarter of each year gets a heavier rule and carries
  // the year, so the eye can find a date without counting.
  const qStart = (q: string) => dayNumber(`${q.slice(0, 4)}-${String((Number(q.slice(6)) - 1) * 3 + 1).padStart(2, "0")}-01`);
  const ticks = a.quarters
    .map((q) => ({ q, px: (qStart(q) - lo) * PX_PER_DAY }))
    .filter((t) => t.px >= 0 && t.px <= width);

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  // A lab often ships several things on one day. Drawing one circle per release
  // stacks them at identical coordinates, where the ones underneath can never be
  // hovered or clicked. One mark per day, carrying all of that day's releases,
  // is both honest and reachable.
  const marks = a.labs.map((lab, row) => {
    const cy = row * ROW_H + ROW_H / 2;
    const byDate = new Map<string, Release[]>();
    for (const r of a.releases) {
      if (r.lab !== lab.id) continue;
      byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    }
    const dots = [...byDate].map(([date, rs]) => {
      const hit = rs.flatMap((r) => r.benchmarks).find((b) => slotOf.has(b));
      const slot = hit ? slotOf.get(hit)! : 0;
      const many = rs.length > 1;
      const cls = `mark${slot ? ` mark--s${slot}` : ""}${many ? " mark--many" : ""}`;
      const r = slot ? 5.5 : 4;
      const label = many ? `${rs.length} releases on ${date}` : `${rs[0].model}, ${date}`;
      return `<circle class="${cls}" cx="${x(date).toFixed(1)}" cy="${cy}" r="${many ? r + 1.5 : r}" data-key="${esc(lab.id + "|" + date)}"><title>${esc(label)}</title></circle>`;
    }).join("");
    return `<g class="row" data-lab="${esc(lab.id)}"><line class="rowline" x1="0" y1="${cy}" x2="${width}" y2="${cy}"/>${dots}</g>`;
  }).join("");

  host.innerHTML = `
    <div class="tl">
      <div class="tl__labs" role="rowheader">
        ${a.labs.map((l) => `<div class="tl__lab" style="height:${ROW_H}px"><span class="tl__logo" aria-hidden="true">${esc(l.name.slice(0, 1))}</span><span class="tl__name">${esc(l.name)}</span></div>`).join("")}
      </div>
      <div class="tl__scroll" tabindex="0" role="group" aria-label="Release timeline, scroll sideways through time">
        <svg class="tl__svg" width="${width}" height="${height + 38}" role="img" aria-label="Releases per lab over time">
          <g class="ticks">${ticks.map((t) => {
            const first = t.q.endsWith("Q1");
            return `<line class="${first ? "tick tick--year" : "tick"}" x1="${t.px.toFixed(1)}" y1="0" x2="${t.px.toFixed(1)}" y2="${height}"/>`;
          }).join("")}</g>
          <g class="axis">${ticks.map((t) => {
            const first = t.q.endsWith("Q1");
            // Both parts on every tick. Labelling the year only on Q1 meant
            // that scrolling anywhere else left no year on screen at all.
            return `<text class="axis__q${first ? " axis__q--first" : ""}" x="${(t.px + 6).toFixed(1)}" y="${height + 16}">Q${t.q.slice(6)}</text>` +
              `<text class="axis__y${first ? " axis__y--first" : ""}" x="${(t.px + 6).toFixed(1)}" y="${height + 32}">${t.q.slice(0, 4)}</text>`;
          }).join("")}</g>
          ${marks}
        </svg>
      </div>
    </div>`;

  // Open scrolled to the present. The most recent quarter is what a reader came
  // for, and starting at 2023 makes them drag through three years to reach it.
  const scroller = host.querySelector<HTMLDivElement>(".tl__scroll")!;
  scroller.scrollLeft = lastScroll ?? scroller.scrollWidth;

  const svg = host.querySelector<SVGSVGElement>(".tl__svg")!;
  const index = new Map<string, Release[]>();
  for (const r of a.releases) {
    const k = `${r.lab}|${r.date}`;
    index.set(k, [...(index.get(k) ?? []), r]);
  }
  svg.addEventListener("mousemove", (e) => {
    const k = (e.target as Element).getAttribute?.("data-key");
    a.onHover(k ? index.get(k) ?? null : null, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => a.onHover(null, 0, 0));
  svg.addEventListener("click", (e) => {
    const k = (e.target as Element).getAttribute?.("data-key");
    const rs = k ? index.get(k) : null;
    if (rs?.length === 1) window.open(rs[0].source_url, "_blank", "noopener");
  });
}

export function tooltipHTML(rs: Release[], names: Map<string, string>): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const one = (r: Release) => {
    const bs = r.benchmarks.length
      ? r.benchmarks.map((b) => `<li>${esc(names.get(b) ?? b)}</li>`).join("")
      : `<li class="muted">No benchmark cited</li>`;
    return `<div class="tt__h">${esc(r.model)}</div>
      <div class="tt__m">${KIND_LABEL[r.kind]}, ${r.date}</div>
      <ul class="tt__l">${bs}</ul>`;
  };
  const body = rs.map(one).join(`<hr class="tt__hr"/>`);
  const foot = rs.length === 1 ? "Click to open the source" : `${rs.length} releases that day`;
  return `${body}<div class="tt__f">${foot}</div>`;
}
