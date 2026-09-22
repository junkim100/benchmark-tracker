// The release timeline, running down the page.
//
// Time is the vertical axis and the newest release is at the top, so reading
// backwards through it is an ordinary page scroll. Labs are the columns.
//
// It used to be the other way round, a horizontal scroller with labs as rows,
// and the scroller was the single buggiest thing here: restoring the reader's
// place across a resize took a dozen attempts, because a horizontal scroll
// offset has to be saved, converted between scales and put back by hand, and
// the browser clamps it mid-reflow while you are not looking. A vertical
// timeline in page flow has no offset to restore. The browser keeps the
// reader's place because it is the page's place.
//
// Lab identity is carried by the sticky header, never by colour: twelve
// categories cannot be told apart by hue and the validated palette caps at
// eight, so those eight are spent on tracked benchmarks.

import { LOGOS } from "./logos";
import { KIND_LABEL, dayNumber, type Lab, type Release } from "./model";
import { clearPicked, type SheetRequest } from "./sheet";

const PAD_DAYS = 30;
// Vertical scale. The span is about 1,460 days, so this makes the timeline
// roughly 2,900px: three or four screens of scrolling to cross four years,
// which is enough to feel like travel without becoming a chore. Marks are 8px
// and the busiest lab publishes on 140 distinct days, a median 10 days apart,
// so at this scale its marks sit about 20px apart and stay separate.
const PX_PER_DAY = 2;
const GUTTER_WIDE = 58;
const GUTTER_NARROW = 38;
// A column narrower than this cannot hold the 22px mark tile with room to
// breathe, so below it the timeline stops shrinking and scrolls sideways
// instead. Twelve of these plus the narrow gutter come to 350px, which a
// 360px phone clears once the timeline is allowed the full viewport. Only a
// genuinely small screen, 320px and under, ends up scrolling.
const MIN_COL = 26;
// The tap window, in CSS pixels, measured down the column from where the finger landed. A mark is painted 5.0px across on a 390px phone and the marks in one column sit a median 24px apart, with a quarter of adjacent pairs 8px or less apart, so no amount of enlarging makes them individually hittable: growing them to 24px would put 56% of adjacent pairs on top of each other, against 20% today. A tap therefore claims a 24px slice of whichever column it landed in, which is the 24x24 target WCAG 2.5.8 asks for at every width the timeline renders (the column never goes below 26px), and everything inside the slice is handed to the panel so the reader picks the release rather than the pixel. A slice this tall catches a median of 2 marks and at most 7.
const TAP_SLICE = 24;
// Half the tap slice. A mouse does not need the forgiveness a finger does, and
// a wider slice would start reporting releases a fortnight apart as one hover.
const HOVER_SLICE = 12;
// A press counts as a tap, not a scroll, within this much travel and this long.
const TAP_SLOP = 10;
const TAP_MS = 700;

export interface TimelineArgs {
  labs: Lab[];
  releases: Release[];
  trackedMembers: Set<number>[];   // one set of benchmark positions per slot, in slot order
  names: string[];                 // benchmark display names, by position
  onHover: (rs: Release[] | null, x: number, y: number) => void;
  /** A tap, on a pointer that cannot hover. Null closes whatever is open. */
  onPick: (r: SheetRequest | null) => void;
}

/** The scheme check at the one place data becomes a navigation.
 *
 *  scripts/normalize.mjs already refuses to write a source_url that is not an
 *  https URL on the lab's own domain, so in a correctly built bundle this can
 *  never be false. It is here because of what the failure looks like if that
 *  ever stops being true: window.open on a javascript: URL runs the script in
 *  this origin, so the whole distance between a data bug and script execution
 *  would be one regex in a build script two directories away. A check at the
 *  sink costs nothing and does not depend on being reached through the build. */
const isHttpUrl = (u: string): boolean => {
  try {
    // No base. A source_url is always absolute, and resolving against the page
    // would let a bare "evil" pass as a same-origin path.
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

// How far the year sits below its month label.
const YEAR_DY = 18;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function labMark(l: Lab, esc: (s: string) => string): string {
  const m = LOGOS[l.id];
  return m
    ? `<span class="tl__logo" style="--lg:${m.cl};--lgd:${m.cd}" aria-hidden="true"><svg viewBox="${m.vb}">${m.d}</svg></span>`
    : `<span class="tl__logo" aria-hidden="true">${esc(l.name.slice(0, 1))}</span>`;
}

export function renderTimeline(host: HTMLElement, a: TimelineArgs): void {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  const box = Math.round(host.getBoundingClientRect().width) || 900;
  const narrow = box < 640;
  // Narrow runs full width of the page, outside the body gutters, because
  // twelve columns need every pixel there is on a phone.
  const avail = narrow ? (document.documentElement.clientWidth || box) : box;
  const GUT = narrow ? GUTTER_NARROW : GUTTER_WIDE;
  const floor = GUT + a.labs.length * MIN_COL;
  const W = Math.max(floor, avail);
  const colW = (W - GUT) / a.labs.length;
  const scale = narrow ? 0.62 : 1;

  const days = a.releases.map((r) => dayNumber(r.date));
  const lo = Math.min(...days) - PAD_DAYS;
  const hi = Math.max(...days) + PAD_DAYS;
  // Room under the last month for its year. January draws its year 18px below
  // itself, so without this the oldest one, 2023, fell outside the canvas and
  // was clipped away. Suppressing it instead would have been worse: the year a
  // reader scrolled three screens to reach is the one worth printing.
  const H = Math.round((hi - lo) * PX_PER_DAY) + YEAR_DY + 6;
  // Newest at the top, so y counts down from the most recent day.
  const y = (iso: string) => (hi - dayNumber(iso)) * PX_PER_DAY;
  const cx = (i: number) => GUT + colW * i + colW / 2;

  // Slot by membership, not by identity. A tracked suite covers many
  // benchmarks, so the lookup is the other way round: given what a release
  // cites, find the first slot that claims any of it.
  // Narrowest match wins. Scanning in slot order meant that tracking a suite
  // and one of its versions coloured every mark with whichever was picked
  // first, so the version's own colour could never appear on a release that
  // only it covers. Preferring the smaller set gives the more specific answer.
  const order = a.trackedMembers
    .map((set, i) => ({ set, slot: i + 1 }))
    .sort((x, y) => x.set.size - y.set.size);
  const slotOfRelease = (cited: number[]): number | undefined => {
    for (const { set, slot } of order) {
      if (cited.some((at) => set.has(at))) return slot;
    }
    return undefined;
  };

  // One pass over the log to group it, rather than one pass per lab inside the
  // column loop and a third to build the hover index. The scan was twelve
  // times the length of the log and the log is the part of the dataset that
  // grows without bound.
  const byLab = new Map<string, Map<string, Release[]>>();
  for (const r of a.releases) {
    let dates = byLab.get(r.lab);
    if (!dates) byLab.set(r.lab, (dates = new Map()));
    const sameDay = dates.get(r.date);
    if (sameDay) sameDay.push(r);
    else dates.set(r.date, [r]);
  }

  // Month rules across the plot, labelled in the gutter. January takes the ink
  // and carries the year; the rest stay quiet.
  const ticks: { y: number; label: string; year: string; first: boolean }[] = [];
  {
    const d0 = new Date(hi * 864e5);
    let yr = d0.getUTCFullYear();
    let mo = d0.getUTCMonth();
    for (;;) {
      const ty = (hi - dayNumber(`${yr}-${String(mo + 1).padStart(2, "0")}-01`)) * PX_PER_DAY;
      if (ty > H) break;
      // January's year sits 18px below its month, so a January in the last 18px
      // of the canvas had its year drawn past the edge and clipped away. The
      // oldest year on the chart, 2023, was the one that went missing.
      if (ty >= 0) ticks.push({ y: ty, label: MONTH[mo], year: String(yr), first: mo === 0 });
      if (--mo < 0) { mo = 11; yr--; }
    }
  }

  const marks = a.labs.map((lab, li) => {
    const byDate = byLab.get(lab.id) ?? new Map<string, Release[]>();
    const dots = [...byDate.entries()].map(([date, rs]) => {
      const slot = slotOfRelease(rs.flatMap((r) => r.benchmarks));
      const many = rs.length > 1;
      const cls = `mark${slot ? ` mark--s${slot}` : ""}${many ? " mark--many" : ""}`;
      const r0 = (rs.length >= 3 ? 7 : rs.length === 2 ? 5.5 : 4) * scale;
      const label = `${lab.name}, ${date}, ${rs.length} release${rs.length > 1 ? "s" : ""}: ${rs.map((r) => `${r.model} (${KIND_LABEL[r.kind] ?? r.kind})`).join("; ")}`;
      return `<circle class="${cls}" cx="${cx(li).toFixed(1)}" cy="${y(date).toFixed(1)}" r="${r0.toFixed(2)}" data-key="${esc(lab.id + "|" + date)}" aria-label="${esc(label)}"></circle>`;
    }).join("");
    return `<g class="tlv__col" data-lab="${esc(lab.id)}">${dots}</g>`;
  }).join("");

  // Below 640px the header drops the lab names, because twelve columns share 350px and a name does not fit in 29px. That left twelve logos identified only by a title attribute, which a finger cannot summon, so a phone reader had no way at all to tell whose column was whose. The key says it once, in the same left-to-right order as the columns. Above 640px the names are in the header and the title is only a fallback for the ones that clamp.
  const key = narrow
    ? `<ul class="tlv__key" aria-label="Which lab each column is">${a.labs
        .map((l) => `<li>${labMark(l, esc)}${esc(l.name)}</li>`).join("")}</ul>`
    : "";

  const sizeKey = `<ul class="tlv__sizes" aria-label="What the size of a mark means">${
    [[1, "1 release"], [2, "2"], [3, "3 or more"]].map(([n, label]) =>
      `<li><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="mark" cx="8" cy="8" r="${n === 3 ? 7 : n === 2 ? 5.5 : 4}"/></svg>${esc(String(label))}</li>`
    ).join("")
  }</ul>`;

  host.innerHTML = `${key}${sizeKey}
    <div class="tlvwrap${narrow ? " tlvwrap--bleed" : ""}"><div class="tlv" style="min-width:${floor}px">
      <div class="tlv__head" style="--gut:${GUT}px;--cols:${a.labs.length}">
        <div class="tlv__gutcell" aria-hidden="true"></div>
        ${a.labs.map((l) => `<div class="tlv__lab"${narrow ? "" : ` title="${esc(l.name)}"`}>${labMark(l, esc)}${narrow ? "" : `<span class="tlv__name">${esc(l.name)}</span>`}</div>`).join("")}
      </div>
      <svg class="tlv__svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Releases per lab over time, newest first">
        <g class="ticks">${ticks.map((t) =>
          `<line class="${t.first ? "tick tick--year" : "tick"}" x1="${GUT}" y1="${t.y.toFixed(1)}" x2="${W}" y2="${t.y.toFixed(1)}"/>`
        ).join("")}</g>
        <g class="cols">${a.labs.map((_, i) =>
          `<line class="collline" x1="${(GUT + colW * i).toFixed(1)}" y1="0" x2="${(GUT + colW * i).toFixed(1)}" y2="${H}"/>`
        ).join("")}</g>
        <g class="axis">${ticks.map((t) =>
          `<text class="axis__m${t.first ? " axis__m--first" : ""}" x="${GUT - 8}" y="${(t.y + 4).toFixed(1)}">${t.label}</text>` +
          (t.first ? `<text class="axis__y" x="${GUT - 8}" y="${(t.y + YEAR_DY).toFixed(1)}">${t.year}</text>` : "")
        ).join("")}</g>
        ${marks}
      </svg>
    </div></div>`;

  const svg = host.querySelector<SVGSVGElement>(".tlv__svg")!;
  const cols = [...svg.querySelectorAll<SVGGElement>(".tlv__col")];
  const index = new Map<string, Release[]>();
  for (const [lab, dates] of byLab) for (const [date, rs] of dates) index.set(`${lab}|${date}`, rs);

  // Which interaction a reader gets is decided by the pointer in their hand, not by the width of their screen: a laptop with a touchscreen has both, and should get hover from the trackpad and the panel from a finger. Seeded from the media query so the first tap on a phone is already right, then kept up to date by whichever pointer is actually moving.
  let coarse = matchMedia("(hover: none)").matches;
  const notePointer = (e: PointerEvent) => { coarse = e.pointerType !== "mouse"; };
  svg.addEventListener("pointerdown", notePointer, { passive: true });
  svg.addEventListener("pointermove", notePointer, { passive: true });

  /** Which column a point is in and which marks sit within `slice` css px of it,
   *  newest first. One resolver for both pointers, because the problem it
   *  solves is the same one.
   *
   *  A mark is 4 to 7px across and two releases three days apart are 6px apart,
   *  so marks overlap constantly: 17 per cent of adjacent pairs in a column,
   *  and at the tenth percentile the gap is 4px. Whichever mark paints last
   *  wins the pixels, so asking what is under the pointer answers with the
   *  neighbour. Measured across six scroll positions, 27 per cent of on-screen
   *  marks had their own centre covered by another, and 20 per cent had no
   *  reachable pixel down their centre line at all. A fifth of the timeline was
   *  unhoverable on a mouse while being perfectly tappable on a phone, because
   *  touch already resolved by proximity and hover did not.
   *
   *  Returning every mark in the slice rather than the nearest one is the
   *  point: in a cluster the neighbours are the context, and the tooltip and
   *  the panel both already take a list. */
  const marksNear = (clientX: number, clientY: number, slice: number) => {
    const box = svg.getBoundingClientRect();
    // Above 350px the svg is drawn at 1:1 and below it sits in a scroller, but never assume: convert through the box it is actually occupying.
    const k = box.width / W;
    const ux = (clientX - box.left) / k;
    const li = Math.floor((ux - GUT) / colW);
    if (ux < GUT || li < 0 || li >= cols.length) return null;
    const uy = (clientY - box.top) / k;
    const half = slice / 2 / k;
    const near = ([...cols[li].children] as SVGCircleElement[])
      .map((c) => ({ c, cy: Number(c.getAttribute("cy")), key: c.getAttribute("data-key") ?? "" }))
      // Ascending cy is newest first, because y counts down from the most recent day, so the list reads in the same direction as the page.
      .filter((m) => Math.abs(m.cy - uy) <= half)
      .sort((x, y2) => x.cy - y2.cy);
    return near.length ? { lab: li, near } : null;
  };

  /** The marks within a tap slice of this point, newest first, or null. */
  const pickAt = (clientX: number, clientY: number): SheetRequest | null => {
    const hit = marksNear(clientX, clientY, TAP_SLICE);
    if (!hit) return null;
    clearPicked();
    for (const m of hit.near) m.c.classList.add("is-picked");
    const days = hit.near.map((m) => ({ date: m.key.slice(m.key.indexOf("|") + 1), releases: index.get(m.key) ?? [] }));
    return { title: a.labs[hit.lab].name, html: pickHTML(days, a.names, esc) };
  };

  svg.addEventListener("mousemove", (e) => {
    if (coarse) return;
    // Tighter than the tap slice, because a mouse is precise and the only job
    // here is to beat the overlap rather than to forgive a finger.
    const hit = marksNear(e.clientX, e.clientY, HOVER_SLICE);
    const rs = hit ? hit.near.flatMap((m) => index.get(m.key) ?? []) : null;
    a.onHover(rs && rs.length ? rs : null, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => a.onHover(null, 0, 0));
  svg.addEventListener("click", (e) => {
    // A tap is served by the pointer handlers below. Letting the click through as well would open the source behind the panel that just described it.
    if (coarse) return;
    const hit = marksNear(e.clientX, e.clientY, HOVER_SLICE);
    if (!hit) return;
    const box = svg.getBoundingClientRect();
    const uy = (e.clientY - box.top) / (box.width / W);
    const nearest = hit.near.reduce((best, m) => (Math.abs(m.cy - uy) < Math.abs(best.cy - uy) ? m : best));
    const rs = index.get(nearest.key);
    // Every mark opens something. Previously only single-release days did, so a
    // fifth of the marks offered a pointer cursor and did nothing.
    if (rs?.length && isHttpUrl(rs[0].source_url)) window.open(rs[0].source_url, "_blank", "noopener");
  });

  // The tap is read from the pointer rather than from a click, because most of the slice a tap claims is empty canvas and iOS Safari only synthesises a click on something it already considers clickable. Down and up within 10px and 700ms, which a scroll fling never is.
  let down: { x: number; y: number; t: number } | null = null;
  svg.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; }, { passive: true });
  svg.addEventListener("pointercancel", () => { down = null; }, { passive: true });
  svg.addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    if (!coarse || !d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP || e.timeStamp - d.t > TAP_MS) return;
    // A synthetic mousemove may have got in first on a hybrid machine.
    a.onHover(null, 0, 0);
    a.onPick(pickAt(e.clientX, e.clientY));
  }, { passive: true });
}

/** What a tap on the timeline puts in the panel.
 *
 *  Nothing is trimmed. The hover tooltip has to fit beside a cursor, so it counts rows and gives up at eight; the panel scrolls, the reader asked for it by tapping, and what it cited is the whole question. */
function pickHTML(
  days: { date: string; releases: Release[] }[],
  // By position, like everywhere else that reads the log. A release carries
  // indexes into this array rather than ids, which is what keeps the log from
  // repeating the same few thousand strings tens of thousands of times.
  names: string[],
  esc: (s: string) => string,
): string {
  const one = (r: Release) => {
    // Guarded, because new URL throws and this runs inside a template that
    // would otherwise take the whole panel down with one bad row.
    const site = isHttpUrl(r.source_url) ? new URL(r.source_url).hostname.replace(/^www\./, "") : "";
    const n = r.benchmarks.length;
    return `<div class="sheet__rel">
      <p class="sheet__m">${esc(r.model)}</p>
      <p class="sheet__k">${esc(KIND_LABEL[r.kind] ?? r.kind)}${n ? `, ${n} benchmark${n === 1 ? "" : "s"} cited` : ""}</p>
      ${n
        ? `<ul class="sheet__l">${r.benchmarks.map((b) => `<li>${esc(names[b] ?? String(b))}</li>`).join("")}</ul>`
        : `<p class="sheet__k">No benchmark cited.</p>`}
      ${isHttpUrl(r.source_url)
        ? `<a class="sheet__go" href="${esc(r.source_url)}" target="_blank" rel="noopener">Open the source on ${esc(site)}</a>`
        : `<p class="sheet__k">The recorded source is not a usable link.</p>`}
    </div>`;
  };
  return days.map((d) => `<div class="sheet__day">
      <p class="sheet__d">${esc(d.date)}</p>
      ${d.releases.map(one).join("")}
    </div>`).join("");
}

export function tooltipHTML(rs: Release[], names: string[], shown = 8, blocks = 3): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  // `shown` is a row cap, not a pixel budget. The caller renders, measures and
  // reduces it until the box fits, which is the only approach that survives
  // content that wraps unpredictably.
  const SHOWN = shown;
  const releases = Math.max(1, Math.min(blocks, rs.length));

  const one = (r: Release) => {
    const rest = r.benchmarks.length - SHOWN;
    // "and N more" is a footnote to a list, not a list. With SHOWN at zero it
    // was emitted on its own, giving a bulleted item reading "and 10 more"
    // under a heading, with nothing to be more than.
    const named = r.benchmarks.slice(0, SHOWN).map((at) => `<li>${esc(names[at] ?? String(at))}</li>`).join("");
    const bs = !r.benchmarks.length
      ? `<li class="muted">No benchmark cited</li>`
      : named + (named && rest > 0 ? `<li class="tt__rest">and ${rest} more</li>` : "")
        || `<li class="tt__rest">${r.benchmarks.length} benchmarks cited</li>`;
    // Escaped like every other field. The date is data-derived text and was the
    // one interpolation here that reached innerHTML raw, safe only because
    // normalize.mjs happens to match it against ^\d{4}-\d{2}-\d{2}$ three files
    // away. The kind falls back to its raw value the same way the mark's
    // aria-label already does, so an unrecognised kind reads as itself rather
    // than as the word "undefined".
    return `<div class="tt__h">${esc(r.model)}</div>
      <div class="tt__m">${esc(KIND_LABEL[r.kind] ?? r.kind)}, ${esc(r.date)}</div>
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
