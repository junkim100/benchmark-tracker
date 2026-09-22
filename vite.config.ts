import { defineConfig } from "vite";
import { dataBoot } from "./vite-data-boot";

// Project pages are served from https://junkim100.github.io/benchmark-tracker/,
// so every asset URL needs that prefix.
export default defineConfig({
  base: "/benchmark-tracker/",
  plugins: [dataBoot()],
  build: {
    outDir: "dist",
    // No source map in production. It was 124 kB of the deploy that only a
    // developer can use, and a developer can rebuild it.
    sourcemap: false,
    // The two data files must stay files. Inlined as base64 data URLs they
    // would be back inside the script, a third larger, and the boot script in
    // index.html would have nothing to point at.
    assetsInlineLimit: (file) => (/data\/(timeline|release-log)\.json$/.test(file) ? false : undefined),
  },
});
