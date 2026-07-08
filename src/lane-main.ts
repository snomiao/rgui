/**
 * Demo entry for lane.html — the limited-visual-width / vertical-zoom mode.
 * Dogfoods src/lane exactly as a consumer would: two 1-D datasets (a synthetic
 * folder tree and a synthetic time series) behind one dataset-blind engine.
 */
import { createLane, type LaneSource } from "./lane/lane.js";
import { createTimelineSource } from "./lane/timeline.js";
import type { TimelineSource } from "./lane/timeline.js";
import { createSeriesSource } from "./lane/timeseries.js";
import { createTreeSource, type FileNode } from "./lane/tree.js";

const canvas = document.querySelector<HTMLCanvasElement>("#viewer")!;
const debug = document.querySelector<HTMLDivElement>("#debug")!;

// ── seeded PRNG so the demo (and e2e) is deterministic ────────────────────
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── synthetic project tree ────────────────────────────────────────────────
function genTree(seed: number): FileNode {
  const rnd = mulberry32(seed);
  const pick = <T>(a: T[]): T => a[(rnd() * a.length) | 0]!;
  const words = [
    "core", "utils", "render", "model", "view", "graph", "layout", "index",
    "parser", "cache", "worker", "client", "server", "store", "hooks", "theme",
    "codec", "buffer", "stream", "vector", "matrix", "shader", "atlas", "query",
  ];
  const codeExt = ["ts", "tsx", "js", "json"];
  const docExt = ["md", "txt"];
  const assetExt = ["png", "svg", "gif", "css"];
  const BINARY = new Set(["png", "svg", "gif", "jpg"]);
  const kb = (min: number, max: number) =>
    Math.round((min + rnd() * (max - min)) * 1024);

  // plausible, deterministic source text so zooming into a file reveals code
  const ids = [
    "value", "result", "node", "item", "index", "data", "ctx", "view", "state",
    "total", "count", "buffer", "offset", "width", "height", "color", "input",
    "output", "cursor", "layout", "bounds", "weight", "depth", "sample",
  ];
  const types = ["number", "string", "Node", "View", "Rect", "boolean", "T"];
  function genCode(name: string, n: number): string {
    const out: string[] = [
      `// ${name} — generated module`,
      `import { ${pick(ids)}, ${pick(ids)} } from "./${pick(ids)}";`,
      "",
    ];
    let indent = 0;
    const pad = () => "  ".repeat(indent);
    while (out.length < n) {
      const r = rnd();
      if (r < 0.1) out.push("");
      else if (r < 0.26) out.push(`${pad()}// ${pick(ids)} the ${pick(ids)}`);
      else if (r < 0.44) {
        out.push(`${pad()}export function ${pick(ids)}(${pick(ids)}: ${pick(types)}) {`);
        indent++;
      } else if (r < 0.6 && indent > 0) {
        out.push(`${pad()}const ${pick(ids)} = ${pick(ids)}(${pick(ids)}, ${(rnd() * 99) | 0});`);
      } else if (r < 0.72 && indent > 0 && indent < 4) {
        out.push(`${pad()}if (${pick(ids)} > ${(rnd() * 100) | 0}) {`);
        indent++;
      } else if (r < 0.82 && indent > 1) {
        indent--;
        out.push(`${pad()}}`);
      } else if (r < 0.9 && indent > 0) {
        out.push(`${pad()}return ${pick(ids)}.${pick(ids)};`);
      } else out.push(`${pad()}${pick(ids)}.${pick(ids)}(${pick(ids)});`);
    }
    while (indent-- > 0) out.push("  ".repeat(indent) + "}");
    return out.join("\n");
  }

  const file = (base: string, exts: string[], min = 1, max = 80): FileNode => {
    const ext = pick(exts);
    const size = kb(min, max);
    const node: FileNode = { name: `${base}.${ext}`, size };
    if (!BINARY.has(ext)) {
      node.content = genCode(base, Math.max(6, Math.min(110, Math.round(size / 220))));
    }
    return node;
  };

  const dir = (
    name: string,
    depth: number,
    maxDepth: number,
    fan: number,
  ): FileNode => {
    const children: FileNode[] = [];
    const nFiles = 1 + ((rnd() * fan) | 0);
    for (let i = 0; i < nFiles; i++) children.push(file(pick(words), codeExt));
    if (depth < maxDepth) {
      const nDirs = (rnd() * Math.max(1, fan - depth)) | 0;
      for (let i = 0; i < nDirs; i++) {
        children.push(
          dir(pick(words), depth + 1, maxDepth, Math.max(2, fan - 1)),
        );
      }
    }
    return { name, children };
  };

  // a believable monorepo: a big node_modules + a real-looking source tree
  const pkgs: FileNode[] = [];
  const pkgNames = [
    "react", "react-dom", "vite", "d3-zoom", "d3-selection", "typescript",
    "esbuild", "rollup", "lodash", "zod", "chalk", "commander", "picocolors",
    "semver", "glob", "yargs", "date-fns", "nanoid", "ws", "undici",
  ];
  for (const p of pkgNames) {
    const files: FileNode[] = [
      { name: "package.json", size: kb(1, 4) },
      { name: "README.md", size: kb(2, 30) },
      { name: "LICENSE", size: kb(1, 2) },
      dir("dist", 2, 4, 4),
      dir("src", 2, 4, 5),
    ];
    pkgs.push({ name: p, children: files });
  }

  return {
    name: "rgui/",
    children: [
      dir("src", 1, 5, 6),
      dir("assets", 1, 2, 4),
      { name: "node_modules", children: pkgs },
      dir("docs", 1, 2, 5),
      dir("dist", 1, 2, 3),
      dir("tests", 1, 3, 5),
      { name: "package.json", size: kb(1, 3) },
      { name: "README.md", size: kb(8, 20) },
      { name: "bun.lock", size: kb(40, 60) },
      { name: "tsconfig.json", size: kb(1, 2) },
      { name: ".gitignore", size: kb(1, 1) },
      file("vite.config", ["ts"]),
      ...Array.from({ length: 6 }, () => file(pick(words), assetExt, 4, 400)),
      ...Array.from({ length: 4 }, () => file(pick(words), docExt, 1, 10)),
    ],
  };
}

// ── synthetic time series (sines + noise + bursts) ────────────────────────
function genSeries(seed: number, n: number): Float64Array {
  const rnd = mulberry32(seed);
  const out = new Float64Array(n);
  let drift = 0;
  for (let i = 0; i < n; i++) {
    const t = i;
    drift += (rnd() - 0.5) * 0.03;
    let v =
      Math.sin(t / 53) * 0.6 +
      Math.sin(t / 11 + 1) * 0.25 +
      Math.sin(t / 3.1) * 0.08 +
      drift * 0.4 +
      (rnd() - 0.5) * 0.05;
    // occasional bursts
    if (rnd() < 0.0012) v += (rnd() - 0.5) * 3;
    out[i] = v;
  }
  return out;
}

// ── build sources + engine ────────────────────────────────────────────────
const signalData = genSeries(0x7e12, 12000);
let seriesLog = false;
const buildSeries = () =>
  createSeriesSource(signalData, {
    sampleRate: 50,
    label: "signal · 50 Hz",
    color: "#b25ce0",
    logScale: seriesLog,
  });

const timeSource: TimelineSource = createTimelineSource();
const sources: Record<string, LaneSource> = {
  tree: createTreeSource(genTree(0x51a1)),
  time: timeSource,
  series: buildSeries(),
};
// ── URL-hash deep links (#src=…&y=scrollY&z=zoomY) ────────────────────────
function parseHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const src = p.get("src");
  const y = p.get("y");
  const z = p.get("z");
  return {
    src: src && sources[src] ? src : null,
    scrollY: y != null && isFinite(+y) ? +y : null,
    zoomY: z != null && isFinite(+z) ? +z : null,
  };
}
const restored = parseHash();
let current = restored.src ?? "tree";

let hashTimer = 0;
function writeHash() {
  const p = new URLSearchParams();
  p.set("src", current);
  p.set("y", lane.view.scrollY.toPrecision(8));
  p.set("z", lane.view.zoomY.toPrecision(6));
  history.replaceState(null, "", "#" + p.toString());
}
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(writeHash, 250);
}

const lane = createLane(canvas, {
  source: sources[current]!,
  theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
  debug,
  maxDpr: 2,
  onFrame: scheduleHash,
});
if (restored.scrollY != null || restored.zoomY != null) {
  lane.setView({
    scrollY: restored.scrollY ?? undefined,
    zoomY: restored.zoomY ?? undefined,
  });
}
// redraw when the timeline lazily fetches web data (Linux commits)
timeSource.setOnUpdate(() => lane.invalidate());

// ── dataset switcher ──────────────────────────────────────────────────────
const seg = document.querySelector<HTMLDivElement>("#dataset")!;
const logBtn = document.querySelector<HTMLButtonElement>("#logscale");
const filters = document.querySelector<HTMLDivElement>("#filters")!;

// event-type filter chips (deep-time view)
for (const c of timeSource.categories) {
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.type = "button";
  chip.dataset.cat = c.cat;
  chip.setAttribute("aria-pressed", "true");
  chip.innerHTML = `<span class="swatch" style="background:${c.color}"></span>${c.label}`;
  chip.addEventListener("click", () => {
    const on = chip.getAttribute("aria-pressed") !== "true";
    chip.setAttribute("aria-pressed", String(on));
    timeSource.setEnabled(c.cat, on);
    lane.invalidate();
  });
  filters.appendChild(chip);
}

const searchWrap = document.querySelector<HTMLDivElement>("#searchwrap")!;
function refreshChrome() {
  if (logBtn) {
    logBtn.style.display = current === "series" ? "" : "none";
    logBtn.setAttribute("aria-pressed", String(seriesLog));
  }
  filters.style.display = current === "time" ? "flex" : "none";
  searchWrap.style.display = current === "time" ? "" : "none";
  for (const b of seg.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.src === current));
  }
}
seg.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-src]");
  if (!btn) return;
  const key = btn.dataset.src!;
  const src = sources[key];
  if (!src) return;
  current = key;
  lane.setSource(src);
  clearSearch();
  refreshChrome();
  scheduleHash();
});

// ── search-to-focus (deep-time dataset) ──────────────────────────────────
const searchEl = document.querySelector<HTMLInputElement>("#search")!;
const suggestEl = document.querySelector<HTMLDivElement>("#suggest")!;
type Hit = ReturnType<typeof timeSource.find>[number];
let hits: Hit[] = [];
let activeIdx = -1;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
function renderSuggest() {
  suggestEl.innerHTML = hits
    .map(
      (h, i) =>
        `<div class="hit${i === activeIdx ? " active" : ""}" data-i="${i}">` +
        `<span class="swatch" style="background:${h.color}"></span>` +
        `<span>${esc(h.label)}</span>` +
        (h.detail ? `<span class="det">${esc(h.detail)}</span>` : "") +
        `</div>`,
    )
    .join("");
}
function clearSearch() {
  searchEl.value = "";
  hits = [];
  activeIdx = -1;
  renderSuggest();
}
function doSearch() {
  const q = searchEl.value;
  hits = current === "time" && q.trim() ? timeSource.find(q, 7) : [];
  activeIdx = hits.length ? 0 : -1;
  renderSuggest();
}
function focusHit(h: Hit) {
  lane.focus({ center: h.center, zoom: lane.view.height / h.scale });
  hits = [];
  renderSuggest();
  searchEl.blur();
}
searchEl.addEventListener("input", doSearch);
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    activeIdx = Math.min(hits.length - 1, activeIdx + 1);
    renderSuggest();
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    activeIdx = Math.max(0, activeIdx - 1);
    renderSuggest();
    e.preventDefault();
  } else if (e.key === "Enter") {
    if (hits[activeIdx]) focusHit(hits[activeIdx]!);
  } else if (e.key === "Escape") {
    clearSearch();
    searchEl.blur();
  }
});
// mousedown (not click) so it fires before the input's blur clears the list
suggestEl.addEventListener("mousedown", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".hit");
  if (!el) return;
  e.preventDefault();
  focusHit(hits[+el.dataset.i!]!);
});
searchEl.addEventListener("blur", () => {
  setTimeout(() => {
    hits = [];
    renderSuggest();
  }, 120);
});

// ── log-scale toggle (only for the Signal dataset) ────────────────────────
logBtn?.addEventListener("click", () => {
  seriesLog = !seriesLog;
  sources.series = buildSeries();
  lane.setSource(sources.series);
  refreshChrome();
});
refreshChrome();

// ── theme toggle (mirrors index.html) ─────────────────────────────────────
const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
themeToggle?.addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("rgui-theme", next);
  lane.setTheme(next);
});

// expose for host debugging / e2e
(window as unknown as { lane: typeof lane }).lane = lane;
