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
// The reader's place in the timeline, held in days because the pixel scale
// changes with the viewport bucket.
//
// Nine earlier versions tried to work out, from the scroller's state, whether
// an offset was one the reader chose or one a reflow forced on them. The DOM
// cannot answer that, and it cannot even be asked: two size changes inside one
// frame produce a single resize event carrying only the final width, so a
// clamp at the intermediate width leaves no trace.
//
// Asking the reader instead was right, but the tenth version asked at the
// wrong moment. It compared a resize timestamp against an input timestamp at
// scroll-event time, by which point the resize handler had already written
// over the offset. A wheel reaches scrollLeft a frame before its scroll event
// is dispatched, so for one frame of every frame the scroller holds a reader
// offset carrying no evidence yet, and the comparison rejected it forever.
//
// The evidence is therefore a latch, not a timestamp. It is set by input and
// cleared only by the scroll event that spends it, so it still applies to the
// event arriving a frame after the input that caused it.
//
// Only the scroll event may spend it. A resize landing in the same frame as a
// wheel also calls adopt, on a scroller whose offset the compositor has not
// updated yet: it would read the pre-wheel value, clear the latch on it, and
// leave the reader's real offset to arrive a frame later with no evidence
// left to admit it. That cost the reader their last wheel in 16 of 20 trials.
// A scroll event is the only proof the delta has actually landed.
let lastScroll: number | null = null;
let lastPxPerDay = 0;
let ourValue = -1;
let inputSince = false;
let inputAt = -1e9;
let resizeAt = -1e9;
let lastClientWidth = -1;
let repaintRange: (() => void) | null = null;

// How long after a resize a scroll may still be the reflow's echo. Outside
// this window an unexplained scroll is the reader's: find-in-page, a scrollbar
// thumb drag and scrollIntoView all move the scroller without any input event
// reaching it, and dropping those cost 764 days.
const RESIZE_ECHO_MS = 120;

// How long the reader's evidence stays good. A wheel tick against the end of
// the timeline moves nothing and so fires no scroll event, leaving the latch
// set with nothing to spend it. Five seconds later a resize was still cashing
// it in to admit a clamp.
const INPUT_TTL_MS = 1000;

export function noteTimelineResize(): void {
  resizeAt = performance.now();
}

// Take the scroller's offset as the reader's place, unless it is still exactly
// what we last wrote, or unless a reflow just happened with no reader input to
// account for it.
function adopt(s: HTMLElement, ppd: number, fromScroll: boolean): void {
  // A redraw replaces the scroller, but the old node's listener closure is
  // still bound to it, and a wheel delta in flight makes Chrome fire a scroll
  // event there. A detached scroller reports scrollLeft 0 and scrollWidth 0,
  // so believing it put the reader at the very start of the timeline, from
  // wherever they actually were. It has no offset worth reading.
  if (!s.isConnected) return;
  if (!ppd || s.scrollLeft === ourValue) return;
  // The echo window belongs to scroll events only. It exists to drop the ones
  // a reflow provokes, and off that path there is no event to drop: the resize
  // handler stamps the time before it calls in here, so this always saw an
  // elapsed zero and refused every read. That left restoreTimelineScroll able
  // to write a stale record back but never to repair one, and any later resize
  // then cashed it in for up to 1331 days.
  const now = performance.now();
  const reader = inputSince && now - inputAt < INPUT_TTL_MS;
  if (fromScroll && !reader && now - resizeAt < RESIZE_ECHO_MS) return;
  // Off the scroll path, the offset is being read during a reflow: the
  // scroller's content still belongs to the previous layout while its width is
  // already the new one. An offset sitting on the maximum of that mismatched
  // pair is the browser's clamp, not a place the reader went, and the reader's
  // own in-flight wheel is exactly what makes the guard above wave it through.
  // Refusing it costs nothing when the reader really is at the end, because
  // the recorded place is then the end too.
  // Only while the width is actually changing, though. On a settled scroller
  // the two are the same number, so refusing every read at the maximum also
  // refuses the one that would correct a stale record, and the next restore
  // then drags the reader back to it. That cost up to 1250 days with no
  // viewport change involved at all.
  // And only while the viewport is WIDENING. A clamp needs the scroller's
  // maximum to shrink below where the reader was, which only a growing width
  // can do. Narrowing or a height-only change cannot clamp, so an offset at
  // the maximum there is simply a reader at the end, and refusing it was the
  // other half of the same 1331-day hole.
  const growing = s.clientWidth > lastClientWidth;
  if (!fromScroll && growing && s.scrollLeft >= s.scrollWidth - s.clientWidth - 0.5) return;
  lastScroll = s.scrollLeft / ppd;
  lastClientWidth = s.clientWidth;
  if (fromScroll) inputSince = false;
  ourValue = -1;
}

// Put the reader back, at whatever scale is now in effect. Recording what the
// scroller actually took, rather than what was asked for, is what lets the
// clamp of our own restore be recognised and ignored.
function restore(s: HTMLElement, ppd: number, fallback: number): void {
  s.scrollLeft = lastScroll != null ? lastScroll * ppd : fallback;
  ourValue = s.scrollLeft;
  lastClientWidth = s.clientWidth;
  if (lastScroll == null) lastScroll = s.scrollLeft / ppd;
}

// A resize inside one bucket redraws nothing, but a widened viewport still
// clamps the scroller and nothing else runs to put the reader back. The
// readout has to be repainted by hand here: the visible span depends on the
// scroller's width, so it goes stale on a resize that leaves the offset alone
// and fires no scroll event to trigger a repaint.
export function restoreTimelineScroll(host: HTMLElement): void {
  const s = host.querySelector<HTMLDivElement>(".tl__scroll");
  if (!s || !lastPxPerDay) return;
  adopt(s, lastPxPerDay, false);
  restore(s, lastPxPerDay, s.scrollLeft);
  repaintRange?.();
}

export function renderTimeline(host: HTMLElement, a: TimelineArgs): void {
  const { pxPerDay: PX_PER_DAY, markScale: MARK_SCALE } = metrics();

  const keep = host.querySelector<HTMLDivElement>(".tl__scroll");
  if (keep) adopt(keep, lastPxPerDay, false);
  lastPxPerDay = PX_PER_DAY;
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
  restore(scroller, PX_PER_DAY, openAt);

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
  // Evidence that the reader, not a reflow, moved the scroller. Registered on
  // the scroller rather than the window so that resizing the page cannot be
  // mistaken for scrolling it.
  for (const ev of ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"]) {
    scroller.addEventListener(ev, () => { inputSince = true; inputAt = performance.now(); }, { passive: true });
  }
  repaintRange = paintRange;
  scroller.addEventListener("scroll", () => {
    paintRange();
    adopt(scroller, PX_PER_DAY, true);
  }, { passive: true });
  paintRange();

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
