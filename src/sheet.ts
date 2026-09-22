// The panel a tap opens.
//
// Hover carries most of the explaining on this page, and a finger cannot hover. Rather than shadowing each hover surface with a second one, every touch interaction lands in this one panel at the foot of the screen: it stays until it is dismissed, it can hold a real link, and it is the same thing whether the tap came from the timeline or from the chart, so there is one behaviour to learn rather than two.
//
// Not modal, and no scrim. The page behind stays scrollable, which matters on a timeline three screens long, and the design document has no overlay or scrim token at all. Its one bottom-anchored surface is the floating sticky bar: the page colour behind a blur with a hairline and no shadow, which is what this is.

export interface SheetRequest {
  /** The bar at the top. Short: it is ellipsized, not wrapped. */
  title: string;
  /** Markup for the scrolling body. The panel supplies its own chrome. */
  html: string;
  /** A press on anything carrying data-sheet-act, with that attribute's value. */
  onAct?: (act: string) => void;
}

export interface Sheet {
  show(r: SheetRequest): void;
  hide(): void;
}

/** Drops the "this is what the panel is about" highlight from wherever it is.
 *  One function rather than one per surface, because the panel is one panel: a
 *  tap on the chart has to take the highlight off the timeline mark that opened
 *  it last, and neither module knows about the other. */
export const clearPicked = (): void => {
  for (const el of document.querySelectorAll(".is-picked")) el.classList.remove("is-picked");
};

export function mountSheet(el: HTMLElement): Sheet {
  const bar = el.querySelector<HTMLElement>(".sheet__t")!;
  const body = el.querySelector<HTMLElement>(".sheet__body")!;
  let onAct: ((act: string) => void) | null = null;
  // Where focus was before the panel took it. A keyboard reader who opens this
  // from a mark and closes it should be back on the timeline, not on BODY.
  let returnTo: HTMLElement | null = null;

  const hide = () => {
    if (el.hidden) return;
    el.hidden = true;
    onAct = null;
    clearPicked();
    const back = returnTo;
    returnTo = null;
    back?.focus({ preventScroll: true });
  };

  const show = (r: SheetRequest) => {
    // Only on the way in from a closed panel. Tapping a second mark while it is
    // open must not record the panel itself as the place to go back to.
    if (el.hidden) returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    bar.textContent = r.title;
    body.innerHTML = r.html;
    onAct = r.onAct ?? null;
    el.hidden = false;
    body.scrollTop = 0;
    el.focus({ preventScroll: true });
  };

  el.addEventListener("click", (e) => {
    const t = e.target as Element;
    if (t.closest(".sheet__x")) { hide(); return; }
    const act = t.closest<HTMLElement>("[data-sheet-act]")?.getAttribute("data-sheet-act");
    if (act) onAct?.(act);
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });

  return { show, hide };
}
