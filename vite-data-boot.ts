import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/** The two files main.ts imports for their URL, as written on disk. Named here
 *  as well as there because the boot script has to find them again under the
 *  content-hashed names the build gave them. */
const DATA = ["data/timeline.json", "data/release-log.json"] as const;

/** The placeholders index.html carries, in source order. */
const SLOTS = ['"BT_CORE_URL"', '"BT_LOG_URL"'] as const;

/** The benchmark descriptions, which are handled differently from the two above in both directions.
 *
 *  They are emitted by this plugin rather than reached through a `?url` import, because nothing in the module graph imports them and nothing should: an import is a promise to download, and the whole point of splitting this file out is that it is downloaded on a click that most visits never make. Emitting it here still gets it a content hash, so it cannot be served as a stale pair with a registry it does not match.
 *
 *  And its slot receives a URL rather than a started fetch. The other two are in flight before the module is requested because every visit needs them; this one is fetched by the interface when a reader opens a detail panel, and starting it in the head would put a registry's worth of bytes back on the path to first paint, which is the cost this split exists to avoid. */
const DESCRIPTIONS = "data/descriptions-site.json";
const DESCRIPTIONS_SLOT = '"BT_DESC_URL"';
/** The rollup asset name, which is the basename: `assets/descriptions-site-<hash>.json` is what comes out. */
const DESCRIPTIONS_ASSET = "descriptions-site.json";

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
  let root = ".";
  return {
    name: "bt-data-boot",
    configResolved(config) {
      base = config.base;
      root = config.root;
    },
    // renderStart rather than buildStart, because this hook runs during output generation and so only on a build. The dev server has no bundle to emit into, and it does not need one: the dev branch below serves the file off disk under the same base, exactly as it does for the other two.
    //
    // The file is always there to read. Both npm scripts run normalize.mjs before vite, and normalize writes this file on every run even when it is empty, so a missing one means the build was invoked some other way and the page would otherwise have shipped pointing at nothing.
    renderStart() {
      const from = `${root}/${DESCRIPTIONS}`;
      let source: string;
      try {
        source = readFileSync(from, "utf8");
      } catch {
        throw new Error(`bt-data-boot: ${from} is missing. Run npm run normalize first, which writes it.`);
      }
      this.emitFile({ type: "asset", name: DESCRIPTIONS_ASSET, source });
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
      // The descriptions asset was emitted by renderStart above, so it is in the bundle under its hashed name but with no originalFileName to match on. Found by the name it was emitted under instead.
      const descriptionsUrl = (): string => {
        if (!ctx.bundle) return base + DESCRIPTIONS;
        for (const [file, out] of Object.entries(ctx.bundle)) {
          if (out.type === "asset" && out.name === DESCRIPTIONS_ASSET) return base + file;
        }
        throw new Error(`bt-data-boot: ${DESCRIPTIONS_ASSET} was emitted but is not in the bundle`);
      };

      let out = html;
      DATA.forEach((source, i) => {
        const slot = SLOTS[i];
        if (!out.includes(slot)) throw new Error(`bt-data-boot: index.html no longer contains ${slot}`);
        out = out.replace(slot, JSON.stringify(url(source)));
      });
      if (!out.includes(DESCRIPTIONS_SLOT)) throw new Error(`bt-data-boot: index.html no longer contains ${DESCRIPTIONS_SLOT}`);
      out = out.replace(DESCRIPTIONS_SLOT, JSON.stringify(descriptionsUrl()));
      return out;
    },
  };
}
