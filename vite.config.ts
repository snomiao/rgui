import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// site build (homepage + demos). The library build uses vite.lib.config.ts.
// Multi-page: the infinite-canvas homepage, the 1-D "lane" demo, and the
// stereoscopic 3-D number cube.
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  appType: "mpa",
  build: {
    rollupOptions: {
      input: {
        main: root + "index.html",
        lane: root + "lane/index.html",
        cube: root + "cube/index.html",
      },
    },
  },
});
