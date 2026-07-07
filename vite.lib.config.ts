import { defineConfig } from "vite";

// library build: bun run build:lib → dist/rgui.js (ESM) + dist/*.d.ts (tsgo)
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "rgui",
    },
    rollupOptions: {
      external: ["d3-zoom", "d3-selection"],
    },
    sourcemap: true,
  },
});
