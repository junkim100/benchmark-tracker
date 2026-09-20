import { defineConfig } from "vite";

// Project pages are served from https://junkim100.github.io/benchmark-tracker/,
// so every asset URL needs that prefix.
export default defineConfig({
  base: "/benchmark-tracker/",
  build: { outDir: "dist", sourcemap: true },
});
