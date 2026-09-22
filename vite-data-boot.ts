import type { Plugin } from "vite";

/** The two files main.ts imports for their URL, as written on disk. Named here
 *  as well as there because the boot script has to find them again under the
 *  content-hashed names the build gave them. */
const DATA = ["data/timeline.json", "data/release-log.json"] as const;

/** The placeholders index.html carries, in source order. */
const SLOTS = ['"BT_CORE_URL"', '"BT_LOG_URL"'] as const;

/** Points the inline boot script in index.html at the emitted data files.
 *
 *  The dataset is fetched rather than imported, so something has to say where
 *  it is. Leaving that to the module means an extra round trip on every visit:
 *  parse the HTML, fetch the script, run it, and only then discover what to
 *  download. Starting both fetches from the head means they are in flight
 *  before the module has even been requested.
 *
 *  A `<link rel=preload as=fetch>` would do the same job, but a preload has to
 *  agree with the eventual request's CORS and credentials mode or the browser
 *  quietly downloads the file twice, and a doubled half-megabyte is a worse
 *  bug than the one being fixed. Handing the module the promise itself cannot
 *  be got wrong.
 *
 *  The URLs are content-hashed, which also pins a page to one build. The
 *  registry and the release log address each other by array position, so they
 *  must never be served as a mismatched pair.
 *
 *  The fetches go inside the page's existing inline script rather than into
 *  one of their own. A content security policy that permits inline script by
 *  hash has to name every block, and one block is one hash to keep in step.
 *
 *  This runs at the default hook order, not "post", so that any plugin which
 *  hashes the finished HTML (a content security policy, say) sees the
 *  substituted URLs rather than the placeholders. */
export function dataBoot(): Plugin {
  let base = "/";
  return {
    name: "bt-data-boot",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml(html, ctx) {
      const url = (source: string): string => {
        // Dev serves the files straight off disk under the same base.
        if (!ctx.bundle) return base + source;
        for (const [file, out] of Object.entries(ctx.bundle)) {
          if (out.type !== "asset") continue;
          const from = out.originalFileNames ?? (out.originalFileName ? [out.originalFileName] : []);
          if (from.some((f) => f.replace(/\\/g, "/") === source)) return base + file;
        }
        // Loud rather than quiet. A miss means main.ts stopped importing the
        // file, or it was small enough to be inlined, and either way the page
        // would silently go back to discovering its data a round trip late.
        throw new Error(`bt-data-boot: ${source} is not in the bundle, so the page cannot be told where it went`);
      };
      let out = html;
      DATA.forEach((source, i) => {
        const slot = SLOTS[i];
        if (!out.includes(slot)) throw new Error(`bt-data-boot: index.html no longer contains ${slot}`);
        out = out.replace(slot, JSON.stringify(url(source)));
      });
      return out;
    },
  };
}
