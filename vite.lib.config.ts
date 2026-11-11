import { defineConfig } from "vite";

// library build: bun run build:lib → dist/rgui.js + dist/gantt.js (ESM, the @snomiao/rgui/gantt subpath) + dist/*.d.ts
export default defineConfig({
  build: {
    lib: {
      entry: { rgui: "src/index.ts", gantt: "src/gantt/index.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: ["d3-zoom", "d3-selection"],
    },
    sourcemap: true,
  },
});
