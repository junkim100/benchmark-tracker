// Layout faults, read off the rendered page. Paste into DevTools and call probe().
//
// Not a build step and not a test: it needs a real browser with real fonts, and adding a headless one to a static site's dependencies to run it costs more than it returns. It exists because "the fold button and the search bar overlap" was true, and was found by looking rather than by anything that could have caught it. Reading every box beats reading every rule.
//
//   probe()                      one report for the current size and scroll
//   probe.page()                 walks the whole page a screen at a time
//   probe.states()               search, no results, no chips, dark theme
//
// Resize the window between calls; the checks are all relative to the viewport.
//
// What it reports:
//   OVERFLOW  a box past the window edge that no scroll container can bring back
//   CLIPPED   content wider than its own box, where nothing says that was meant
//   OVERLAP   two in-flow siblings occupying the same pixels
//   FLUSH     two stacked blocks sharing an edge with no gap, which reads as collision
//   BLOCKED   a control whose own centre belongs to something else, so a click misses it

(() => {
  // Expected to sit above the page: the sticky header, the fixed corner buttons, and the two detail surfaces.
  const OVERLAY = ".sheet, .detail, .subnav, .corner";

  // Stacked blocks that are meant to share an edge. The tiles are full-bleed and alternate Canvas against Parchment, so a gap between them would be the fault; list rows and paragraphs stack; a panel's bar sits on its body with a hairline between.
  const byDesign = (a, b) =>
    ((a.tagName === "SECTION" || a.tagName === "FOOTER") && (b.tagName === "SECTION" || b.tagName === "FOOTER")) ||
    (a.tagName === b.tagName && ["LI", "P"].includes(a.tagName)) ||
    (/__bar/.test(a.className) && /__body/.test(b.className)) ||
    a.closest(".sheet__body, .detail__body") || b.closest(".sheet__body, .detail__body");

  // A box past the window edge is only a fault if nothing between it and the page can scroll it into reach. The timeline is 350px wide inside a 320px phone on purpose and scrolls sideways.
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };

  const vis = (el) => {
    const c = getComputedStyle(el);
    if (c.display === "none" || c.visibility === "hidden" || c.opacity === "0") return false;
    // Visually-hidden labels are clipped on purpose; that is the pattern, not a fault.
    if (el.classList.contains("vh") || c.clipPath === "inset(50%)") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const name = (el) => {
    const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const txt = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 18);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}${txt ? ` "${txt}"` : ""}`;
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const probe = (label = `${innerWidth}x${innerHeight}`) => {
    const W = innerWidth, H = innerHeight;
    const all = [...document.querySelectorAll("body *")].filter((el) => !el.closest("svg") && vis(el));
    const found = [];

    for (const el of all) {
      const r = el.getBoundingClientRect(), c = getComputedStyle(el);
      if ((r.right > W + 1 || r.left < -1) && !inScroller(el)) found.push(`OVERFLOW ${name(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      if (el.scrollWidth > el.clientWidth + 1 && !/auto|scroll/.test(c.overflowX) && c.textOverflow !== "ellipsis" && c.overflowX !== "visible") {
        found.push(`CLIPPED ${name(el)} ${el.scrollWidth}>${el.clientWidth}`);
      }
    }

    const seen = new Set();
    for (const el of all) {
      const kids = [...el.children].filter((k) => vis(k) && getComputedStyle(k).position === "static");
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const [A, B] = [kids[i], kids[j]];
          if (byDesign(A, B)) continue;
          const a = A.getBoundingClientRect(), b = B.getBoundingClientRect();
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          const key = `${name(A)} | ${name(B)}`;
          if (seen.has(key)) continue;
          if (ox > 1 && oy > 1) { seen.add(key); found.push(`OVERLAP ${key} by ${Math.round(ox)}x${Math.round(oy)}`); }
          else if (ox > 20 && oy > -0.5 && oy <= 0.5 && a.height > 8 && b.height > 8) { seen.add(key); found.push(`FLUSH ${key}`); }
        }
      }
    }

    for (const el of document.querySelectorAll('button, a[href], input, [role="option"]')) {
      if (!vis(el) || el.closest(OVERLAY)) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // Only controls fully on screen. One scrolled half under the sticky header is the page scrolling, not a layout fault.
      if (r.top < 0 || r.bottom > H || cx < 0 || cx > W) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el) || hit.closest(OVERLAY)) continue;
      found.push(`BLOCKED ${name(el)} <- ${name(hit)}`);
    }

    return found.map((f) => `${label}: ${f}`);
  };

  const openBrowse = async () => {
    const p = document.querySelector("#browse-panel");
    if (p?.hidden) { document.querySelector(".fold").click(); await wait(450); }
  };

  probe.page = async () => {
    await openBrowse();
    const found = [];
    const step = Math.round(innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      scrollTo(0, y);
      await wait(250);
      found.push(...probe(`y${y}`));
    }
    scrollTo(0, 0);
    return [...new Set(found)];
  };

  probe.states = async () => {
    await openBrowse();
    const found = [];
    const box = document.querySelector(".browse__input");
    const setQ = async (q) => { box.value = q; box.dispatchEvent(new Event("input", { bubbles: true })); await wait(500); };

    await setQ("a");
    document.querySelector(".browse__results")?.scrollIntoView({ block: "start" });
    await wait(350);
    found.push(...probe("search, pager shown"));
    await setQ("zzzznothingmatches");
    found.push(...probe("no results"));
    await setQ("SWE-Lancer");
    const info = [...document.querySelectorAll("button")].find((b) => /^About /.test(b.getAttribute("aria-label") || ""));
    if (info) { info.click(); await wait(700); found.push(...probe("longest name selected")); }
    await setQ("");

    let guard = 0;
    while (document.querySelector(".chip__x") && guard++ < 12) { document.querySelector(".chip").click(); await wait(350); }
    found.push(...probe("nothing tracked"));

    document.querySelector(".corner--left")?.click();
    await wait(400);
    found.push(...probe("dark theme"));
    document.querySelector(".corner--left")?.click();
    return [...new Set(found)];
  };

  globalThis.probe = probe;
  return "probe() / probe.page() / probe.states()";
})();
