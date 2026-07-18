import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";

// site build (homepage + demos). The library build uses vite.lib.config.ts.
// Multi-page: the infinite-canvas homepage, the 1-D "lane" demo, and the
// stereoscopic 3-D number cube.
const root = fileURLToPath(new URL(".", import.meta.url));

// /lane/<dataset>/ paths — one app shell (lane/index.html) serves them all.
// Dev/preview rewrite the request; the build copies the built page into
// each subdir so static hosting (Cloudflare Pages) needs no redirects.
const LANE_DATASETS = ["tree", "time", "signal", "agents"];
const laneRewrite: Connect.NextHandleFunction = (req, _res, next) => {
  if (
    req.url &&
    new RegExp(`^/lane/(${LANE_DATASETS.join("|")})(/|/index\\.html)?([?#]|$)`).test(req.url)
  ) {
    req.url = "/lane/index.html";
  }
  next();
};
const laneDatasetRoutes = (): Plugin => ({
  name: "lane-dataset-routes",
  configureServer(server) {
    server.middlewares.use(laneRewrite);
  },
  configurePreviewServer(server) {
    server.middlewares.use(laneRewrite);
  },
  closeBundle() {
    const built = root + "dist/lane/index.html";
    if (!existsSync(built)) return; // non-site builds
    for (const ds of LANE_DATASETS) {
      mkdirSync(`${root}dist/lane/${ds}`, { recursive: true });
      copyFileSync(built, `${root}dist/lane/${ds}/index.html`);
    }
  },
});

export default defineConfig({
  appType: "mpa",
  plugins: [laneDatasetRoutes()],
  server: {
    host: true,
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: root + "index.html",
        lane: root + "lane/index.html",
        cube: root + "cube/index.html",
        world: root + "world/index.html",
      },
    },
  },
});
