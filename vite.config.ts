import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// site build (homepage + demos). The library build uses vite.lib.config.ts.
// Multi-page: the infinite-canvas homepage plus the 1-D "lane" demo, which
// renders folder trees & time series in limited-visual-width / vertical-zoom
// mode (see src/lane).
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  appType: "mpa",
  build: {
    rollupOptions: {
      input: {
        main: root + "index.html",
        lane: root + "lane/index.html",
      },
    },
  },
});
