import { defineConfig } from "vite";

// library build: bun run build:lib → dist/rgui.js + dist/gantt.js (the headless @snomiao/rgui/gantt) + dist/gantt-canvas.js (@snomiao/rgui/gantt/canvas) + dist/*.d.ts
export default defineConfig({
  build: {
    lib: {
      entry: { rgui: "src/index.ts", gantt: "src/gantt/index.ts", "gantt-canvas": "src/gantt/canvas.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: ["d3-zoom", "d3-selection"],
    },
    sourcemap: true,
  },
});
