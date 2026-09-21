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
// Narrow viewports get a tighter day scale. At 6px a quarter is 540px wide,
// which is wider than a phone's 220px scroller, so most scroll positions
// showed no date label at all.
//
// Read per render rather than once at module load, so rotating a phone lands
// in the right geometry instead of keeping whichever width happened to be in
// effect when the bundle parsed.
//
// Marks shrink with the day scale, and they have to shrink by the same factor
// or they grow relative to the date axis. The day scale drops 2.5x, so 0.6
// left a 4.8px dot spanning two days where the desktop dot spans 1.33, and 49
// of 620 marks had their own centre covered by a neighbour. 0.4 restores the
// desktop profile.
function metrics() {
  const narrow = typeof window !== "undefined" && window.innerWidth < 760;
  return { narrow, pxPerDay: narrow ? 2.4 : 6, markScale: narrow ? 0.4 : 1 };
}

export function timelineBucket(): boolean {
  return metrics().narrow;
}

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
// Held in days, not pixels, because the pixel scale changes with the viewport
// bucket. Recorded on every scroll rather than read at redraw time: a resize
// reflows the scroller and clamps scrollLeft to the OLD content width before
// the resize event fires, so the value read at redraw was already corrupt.
//
// No width guard. An earlier version rejected scrolls taken at a width other
// than the last render's, meaning to drop the clamp. It could not work: a
// within-bucket resize does not redraw, so the recorded width went stale and
// the guard then rejected every real scroll until the next redraw, losing 548
// to 730 days on an ordinary window drag.
//
// Two things still have to be got right, and they pull in opposite
// directions. A scroll in flight is applied to the DOM at the start of the
// frame, before resize steps and long before scroll steps, so at redraw time
// this recorder is one frame stale and the DOM is fresher: a resize landing
// mid-flick lost 325 days. But a reflow also clamps the DOM value against
// content the scroller no longer has, which is what made reading the DOM
// wrong in the first place. Both are handled below, at the two points where
// the value crosses between here and the DOM.
let lastScroll: number | null = null;
let lastPxPerDay = 0;
// The restore's own scroll event must not be recorded. The browser clamps the
// restore to the new geometry, and recording the clamped result over the
// intent is a real loss: rotating to landscape and back left the reader 62
// days from where they started, at a width where the original date was
// perfectly reachable.
let pendingRestore = false;
// Whether the reader has scrolled since the last redraw. Without this the
// guard above was dead: it preserved the intent through the outbound leg, and
// then the return leg read the DOM and copied the clamped position back over
// it. A width the reader never chose is not a position to inherit, so the DOM
// is consulted only when they actually moved.
let userScrolled = false;

export function renderTimeline(host: HTMLElement, a: TimelineArgs): void {
  const { pxPerDay: PX_PER_DAY, markScale: MARK_SCALE } = metrics();

  // Where the reader is, resolved from two sources that each corrupt in a
  // different way. The DOM is a frame fresher, because a scroll in flight is
  // applied before resize steps while this recorder is only updated in scroll
  // steps. But a reflow also clamps the DOM against content the scroller no
  // longer has. A clamp is recognisable: it leaves the offset sitting on the
  // maximum. When it fires the DOM still bounds the answer from below, since
  // the offset was clamped down to get there, so the later of the two is never
  // worse than either alone.
  const keep = host.querySelector<HTMLDivElement>(".tl__scroll");
  if (keep && lastPxPerDay && userScrolled) {
    const dom = keep.scrollLeft / lastPxPerDay;
    const clamped = keep.scrollLeft >= keep.scrollWidth - keep.clientWidth - 0.5;
    lastScroll = clamped && lastScroll != null ? Math.max(lastScroll, dom) : dom;
  }
  lastPxPerDay = PX_PER_DAY;
  userScrolled = false;
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
      const r = (slot ? 5.5 : 4) * MARK_SCALE;
      const label = many ? `${rs.length} releases on ${date}` : `${rs[0].model}, ${date}`;
      return `<circle class="${cls}" cx="${x(date).toFixed(1)}" cy="${cy}" r="${(many ? r + 1.5 * MARK_SCALE : r).toFixed(2)}" data-key="${esc(lab.id + "|" + date)}" aria-label="${esc(label)}"></circle>`;
    }).join("");
    return `<g class="row" data-lab="${esc(lab.id)}"><line class="rowline" x1="0" y1="${cy}" x2="${width}" y2="${cy}"/>${dots}</g>`;
  }).join("");

  host.innerHTML = `
    <div class="tl">
      <div class="tl__labs" role="rowheader">
        ${a.labs.map((l) => `<div class="tl__lab" style="height:${ROW_H}px"><span class="tl__logo" aria-hidden="true">${esc(l.name.slice(0, 1))}</span><span class="tl__name">${esc(l.name)}</span></div>`).join("")}
      </div>
      <div class="tl__body">
      <div class="tl__range" aria-live="off"></div>
      <div class="tl__scroll" tabindex="0" role="group" aria-label="Release timeline, scroll sideways through time">
        <svg class="tl__svg" style="--mark-stroke: ${(2 * MARK_SCALE).toFixed(2)}; --mark-stroke-many: ${(2.5 * MARK_SCALE).toFixed(2)}" width="${width}" height="${height + 38}" role="img" aria-label="Releases per lab over time">
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
      </div>
    </div>`;

  // Open scrolled to the present. The most recent quarter is what a reader came
  // for, and starting at 2023 makes them drag through three years to reach it.
  const scroller = host.querySelector<HTMLDivElement>(".tl__scroll")!;
  // Open on content, not on the end gutter. PAD_DAYS puts empty space past the
  // last mark, wider than a phone's scroller, so scrolling to scrollWidth
  // landed on a strip containing no marks at all.
  const rightmost = Math.max(...a.releases.map((r) => x(r.date)));
  const openAt = Math.max(0, rightmost - scroller.clientWidth * 0.75);
  const before = scroller.scrollLeft;
  scroller.scrollLeft = lastScroll != null ? lastScroll * PX_PER_DAY : openAt;
  // Only arm the guard if the assignment actually moved the scroller. If it
  // did not, no scroll event is coming and an armed guard would eat the
  // reader's next real scroll instead.
  pendingRestore = scroller.scrollLeft !== before;

  // A readout of the visible range, updated on scroll. Labels drawn into the
  // canvas sit a whole quarter apart and vanish at any width where the
  // scroller is narrower than that, which was every width below about 1010px.
  const readout = host.querySelector<HTMLDivElement>(".tl__range")!;
  const atPx = (p: number) => {
    const d = new Date((lo + p / PX_PER_DAY) * 864e5);
    return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  };
  const paintRange = () => {
    const a1 = atPx(scroller.scrollLeft);
    const b1 = atPx(scroller.scrollLeft + scroller.clientWidth);
    readout.textContent = a1 === b1 ? a1 : `${a1} to ${b1}`;
  };
  scroller.addEventListener("scroll", () => {
    paintRange();
    if (pendingRestore) { pendingRestore = false; return; }
    userScrolled = true;
    lastScroll = scroller.scrollLeft / PX_PER_DAY;
  }, { passive: true });
  paintRange();
  if (lastScroll == null) lastScroll = scroller.scrollLeft / PX_PER_DAY;

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
    // Every mark opens something. Previously only single-release days did, so a
    // fifth of the marks offered a pointer cursor and did nothing, leaving 286
    // of 779 sources unreachable from the interface.
    if (rs?.length) window.open(rs[0].source_url, "_blank", "noopener");
  });
}

export function tooltipHTML(rs: Release[], names: Map<string, string>, shown = 8, blocks = 3): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  // `shown` is a row cap, not a pixel budget. The caller renders, measures and
  // reduces it until the box fits, which is the only approach that survives
  // content that wraps unpredictably.
  const SHOWN = shown;
  const releases = Math.max(1, Math.min(blocks, rs.length));

  const one = (r: Release) => {
    const rest = r.benchmarks.length - SHOWN;
    const bs = r.benchmarks.length
      ? r.benchmarks.slice(0, SHOWN).map((b) => `<li>${esc(names.get(b) ?? b)}</li>`).join("")
        + (rest > 0 ? `<li class="tt__rest">and ${rest} more</li>` : "")
      : `<li class="muted">No benchmark cited</li>`;
    return `<div class="tt__h">${esc(r.model)}</div>
      <div class="tt__m">${KIND_LABEL[r.kind]}, ${r.date}</div>
      <div class="tt__src">${esc(new URL(r.source_url).hostname.replace(/^www\./, ""))}</div>
      <ul class="tt__l">${bs}</ul>`;
  };
  const MAX_RELEASES = releases;
  const body = rs.slice(0, MAX_RELEASES).map(one).join(`<hr class="tt__hr"/>`);
  const foot = rs.length === 1
    ? "Click to open the source"
    : `${rs.length} releases that day${rs.length > MAX_RELEASES ? `, showing ${MAX_RELEASES}` : ""}. Click to open the first.`;
  return `${body}<div class="tt__f">${foot}</div>`;
}
