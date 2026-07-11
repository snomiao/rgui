/**
 * Demo entry for lane.html — the limited-visual-width / vertical-zoom mode.
 * Dogfoods src/lane exactly as a consumer would: two 1-D datasets (a synthetic
 * folder tree and a synthetic time series) behind one dataset-blind engine.
 */
import { createLane, type LaneSource } from "./lane/lane.js";
import { createTimelineSource } from "./lane/timeline.js";
import type { TimelineFold, TimelineSource } from "./lane/timeline.js";
import { FOLD_PERIOD_MS } from "./lane/temporal.js";
import { createSeriesSource } from "./lane/timeseries.js";
import { createTreeSource, type FileNode } from "./lane/tree.js";

// ── network monitor: show every external fetch in the debug panel ─────────
const netEl = document.querySelector<HTMLDivElement>("#net")!;
const net = { inflight: 0, total: 0, err: 0, hosts: new Map<string, number>() };
const SHORT: Record<string, string> = {
  "api.github.com": "github-api",
  "raw.githubusercontent.com": "github-raw",
  "query.wikidata.org": "wikidata",
  "ll.thespacedevs.com": "spacedevs",
};
function renderNet() {
  if (!net.total) {
    netEl.textContent = "";
    return;
  }
  const via = [...net.hosts.entries()]
    .map(([h, c]) => `${SHORT[h] ?? h} ${c}`)
    .join(" · ");
  netEl.innerHTML =
    `<span class="dim">net</span> ${net.inflight} live · ${net.total} req` +
    (net.err ? ` · <span class="hi">${net.err} err</span>` : "") +
    (via ? `\n<span class="dim">via</span> ${via}` : "");
}
const _fetch = window.fetch.bind(window);
const trackedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  let host = "?";
  try {
    const u = typeof input === "string" ? input : (input as Request).url ?? String(input);
    host = new URL(u, location.href).host;
  } catch {
    /* ignore */
  }
  net.inflight++;
  net.total++;
  net.hosts.set(host, (net.hosts.get(host) ?? 0) + 1);
  renderNet();
  return _fetch(input, init)
    .then(
      (r) => {
        if (!r.ok) net.err++;
        return r;
      },
      (e) => {
        net.err++;
        throw e;
      },
    )
    .finally(() => {
      net.inflight--;
      renderNet();
    });
};
window.fetch = Object.assign(trackedFetch, { preconnect: _fetch.preconnect });

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
// redraw when the timeline lazily fetches web data; also translate any new
// (fetched) labels so i18n keeps up with live data
timeSource.setOnUpdate(() => {
  lane.invalidate();
  void translateNew();
});

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
const repoInput = document.querySelector<HTMLInputElement>("#repo")!;
const repoStat = document.querySelector<HTMLSpanElement>("#repostat")!;
const axisBtn = document.querySelector<HTMLButtonElement>("#axis");
const foldBtn = document.querySelector<HTMLButtonElement>("#fold");
function refreshChrome() {
  if (logBtn) {
    logBtn.style.display = current === "series" ? "" : "none";
    logBtn.setAttribute("aria-pressed", String(seriesLog));
  }
  if (axisBtn) {
    // the log/linear axis only applies to the continuous (unfolded) view
    axisBtn.style.display = current === "time" && timeSource.getFold() === "none" ? "" : "none";
    const log = timeSource.isLogAxis();
    axisBtn.textContent = log ? "log axis" : "linear axis";
    axisBtn.setAttribute("aria-pressed", String(log));
  }
  if (foldBtn) {
    foldBtn.style.display = current === "time" ? "" : "none";
    const f = timeSource.getFold();
    foldBtn.textContent =
      foldMode === "auto" ? `fold: auto (${f === "none" ? "off" : f})` : f === "none" ? "fold: off" : `fold: ${f}`;
    foldBtn.setAttribute("aria-pressed", String(f !== "none"));
  }
  filters.style.display = current === "time" ? "flex" : "none";
  searchWrap.style.display = current === "time" ? "" : "none";
  repoInput.style.display = current === "tree" ? "" : "none";
  repoStat.style.display = current === "tree" ? "" : "none";
  for (const b of seg.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.src === current));
  }
}
axisBtn?.addEventListener("click", () => {
  timeSource.setLogAxis(!timeSource.isLogAxis());
  lane.fit(); // re-frame the biased fit in the new axis
  refreshChrome();
});
// ── temporal fold: full auto ladder, every scale ───────────────────────────
// "auto" (the default) picks the fold level from READABILITY, per the
// rg-merge principle: a scale change starts exactly when rendered elements
// become unreadable. A fold level is eligible while its rows AND slot
// columns render at ≥ 1rem on screen — the finest eligible level wins, and
// the row count is whatever the viewport allows (never a fixed number).
const YEAR_MS = FOLD_PERIOD_MS.year!;
const LADDER = ["year", "month", "week", "day", "hour"] as const;
type FoldLevel = (typeof LADDER)[number];
const FOLD_SLOTS: Record<FoldLevel, number> = { year: 12, month: 31, week: 7, day: 24, hour: 60 };
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
let foldMode: "auto" | "none" = "auto";

// last pointer position over the canvas: fold switches anchor on the instant
// UNDER THE CURSOR, so a switch that fires mid zoom-gesture keeps the user's
// zoom anchor fixed — the fold reads as the same zoom continuing, not a jump
let lastPointer: { y: number; at: number } | null = null;
for (const type of ["pointermove", "wheel"] as const) {
  canvas.addEventListener(type, (e) => {
    lastPointer = { y: (e as PointerEvent | WheelEvent).offsetY, at: performance.now() };
  }, { passive: true });
}
const HYST = 0.85; // keep the current level until its rows drop below HYST·1rem
const MIN_ROWS = 1.2; // below this a fold isn't folding anything — go continuous

/** finest ladder level whose rows and slot columns stay readable, or null.
 *  `keep` (the current level) gets the hysteresis allowance so tiny zoom
 *  changes at a boundary don't flap between adjacent levels. */
function foldLevelFor(spanMs: number, keep?: FoldLevel): FoldLevel | null {
  const rem = remPx();
  const v = lane.view;
  const usableW = Math.max(40, v.width - 90); // ≈ width minus the fold ruler
  let pick: FoldLevel | null = null;
  for (const f of LADDER) {
    const rows = spanMs / FOLD_PERIOD_MS[f]!;
    const rowH = v.height / rows;
    const slotW = usableW / FOLD_SLOTS[f];
    const minRowH = f === keep ? rem * HYST : rem;
    if (rows >= MIN_ROWS && rowH >= minRowH && slotW >= rem) pick = f;
  }
  return pick;
}

// orientation-preserving HARD switch (TODO.md: no morph yet): re-project the
// instant at the viewport center and jump there with setView — a focus
// animation would interpolate across two unrelated coordinate systems.
// `spanMs` = the time window the new viewport should show; every transition
// maps scale continuously, so auto switches feel like the same zoom
// continuing in a new coordinate system.
// debug ring buffer of fold transitions (QA aid, harmless in prod)
const foldLog: unknown[] = [];
(window as unknown as { __foldLog: unknown[] }).__foldLog = foldLog;
function applyFold(next: TimelineFold, spanMs: number) {
  const v = lane.view;
  foldLog.push({ t: Math.round(performance.now()), from: timeSource.getFold(), next, spanMs: Math.round(spanMs), zoomY: +v.zoomY.toFixed(2), scrollY: +v.scrollY.toFixed(3) });
  if (foldLog.length > 40) foldLog.shift();
  // anchor: the cursor's screen-y when fresh (mid-gesture), else the center
  const anchorY =
    lastPointer && performance.now() - lastPointer.at < 1500 ? lastPointer.y : v.height / 2;
  const tMs = timeSource.tMsForWorld(v.scrollY + anchorY / v.zoomY) ?? Date.now();
  timeSource.setFold(next, { animateFrom: { ...v } }); // morph-lite: glyphs glide old→new
  const anchorWorld = timeSource.worldForTMs(tMs);
  let zoomY: number;
  if (next !== "none") {
    // readability clamp, not a count clamp: rows span [1, height/1rem] so
    // every rendered row keeps ≥ 1rem after the switch
    const rows = Math.min(Math.max(spanMs / FOLD_PERIOD_MS[next]!, 1.05), v.height / remPx());
    zoomY = v.height / rows;
  } else {
    // world-span of the same window in the continuous axis's own units
    // (exact on linear, symlog-aware on log)
    const w1 = timeSource.worldForTMs(tMs - spanMs / 2);
    const w2 = timeSource.worldForTMs(tMs + spanMs / 2);
    zoomY = v.height / Math.max(Math.abs(w2 - w1), 1e-9);
  }
  // keep the anchored instant at the SAME screen y across the switch
  lane.setView({ zoomY, scrollY: anchorWorld - anchorY / zoomY });
  refreshChrome();
}

foldBtn?.addEventListener("click", () => {
  // toggle auto ⇄ off (auto is the default; specific levels come from zoom)
  foldMode = foldMode === "auto" ? "none" : "auto";
  if (foldMode === "none" && timeSource.getFold() !== "none") {
    const f = timeSource.getFold() as FoldLevel;
    applyFold("none", (lane.view.height / lane.view.zoomY) * FOLD_PERIOD_MS[f]!);
  }
  refreshChrome();
});

// auto-fold watcher: acts only once the view SETTLES (a few unchanged
// frames) — firing mid zoom-gesture or mid focus-animation would re-anchor
// on a transient center and land the fold somewhere the user wasn't going
// The auto ladder evaluates EVERY frame — fold switches happen mid-gesture
// (the rg flow: zoom IS the fold operation). Two guards only: lane focus()
// animations finish first (they'd re-anchor on a transient center), and a
// short min-interval between switches lets each morph read before the next.
const SWITCH_MIN_GAP_MS = 140;
let lastSwitchAt = 0;
function autoFoldTick() {
  requestAnimationFrame(autoFoldTick);
  if (current !== "time" || foldMode !== "auto") return;
  if (lane.isAnimating()) return;
  if (performance.now() - lastSwitchAt < SWITCH_MIN_GAP_MS) return;
  const v = lane.view;
  const fold = timeSource.getFold();
  if (fold === "none") {
    const tTop = timeSource.tMsForWorld(v.scrollY);
    const tBot = timeSource.tMsForWorld(v.scrollY + v.height / v.zoomY);
    if (tTop == null || tBot == null) return; // deep-time: no calendar here
    const spanMs = Math.abs(tBot - tTop);
    const level = foldLevelFor(spanMs);
    if (!level) return; // rows unreadable at every level → stay continuous
    // only fold when the window actually INTERSECTS the dataset's year range
    // (foldRowRange reports year rows while unfolded) — a center-year test
    // rejected wide windows whose edge overlapped the data (codex review)
    const yr = timeSource.foldRowRange();
    const winMin = new Date(Math.min(tTop, tBot)).getUTCFullYear();
    const winMax = new Date(Math.max(tTop, tBot)).getUTCFullYear();
    if (winMax < yr.min - 10 || winMin > yr.max + 10) return;
    lastSwitchAt = performance.now();
    applyFold(level, spanMs);
  } else {
    const f = fold as FoldLevel;
    const spanMs = (v.height / v.zoomY) * FOLD_PERIOD_MS[f]!;
    // re-pick from readability with hysteresis for the current level; a fast
    // zoom can fly several rungs at once, so this may jump levels or leave
    // the ladder entirely (null → continuous, both ends). The min-zoom clamp
    // needs no special case: parked at a small fold's extent the rows stay
    // readable (stable no-op); zoomed out further they shrink below 1rem and
    // the rule climbs coarser by itself.
    const target = foldLevelFor(spanMs, f);
    if (target !== f) {
      lastSwitchAt = performance.now();
      applyFold(target ?? "none", Math.max(spanMs, 60_000));
    }
  }
}
requestAnimationFrame(autoFoldTick);
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
  timeSource.setPulse(h);
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

// ── folder tree from any GitHub repo (default: torvalds/linux) ────────────
interface GhEntry {
  path: string;
  type: string;
  size?: number;
}
function buildFileTree(name: string, entries: GhEntry[]): FileNode {
  const root: FileNode = { name, children: [] };
  const dirs = new Map<string, FileNode>([["", root]]);
  const ensureDir = (path: string): FileNode => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const parts = path.split("/");
    const nm = parts.pop()!;
    const parent = ensureDir(parts.join("/"));
    const d: FileNode = { name: nm, children: [], path };
    parent.children!.push(d);
    dirs.set(path, d);
    return d;
  };
  for (const e of entries) {
    if (e.type === "tree") ensureDir(e.path);
    else if (e.type === "blob") {
      const parts = e.path.split("/");
      const fn = parts.pop()!;
      ensureDir(parts.join("/")).children!.push({
        name: fn,
        size: e.size ?? 0,
        path: e.path,
      });
    }
  }
  return root;
}
function parseRepo(s: string): { owner: string; repo: string } | null {
  const m =
    s.trim().match(/github\.com[/:]([^/]+)\/([^/#?\s]+)/) ??
    s.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  return m ? { owner: m[1]!, repo: m[2]!.replace(/\.git$/, "") } : null;
}

let repoToken = 0; // guards against out-of-order loads
async function loadRepo(owner: string, repo: string) {
  const my = ++repoToken;
  repoStat.textContent = "loading…";
  try {
    const info = await fetch(`https://api.github.com/repos/${owner}/${repo}`).then(
      (r) => (r.ok ? r.json() : null),
    );
    const branch = info?.default_branch ?? "HEAD";
    const tree = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    ).then((r) => (r.ok ? r.json() : null));
    if (my !== repoToken) return; // superseded
    if (!tree?.tree) {
      repoStat.textContent = "repo not found";
      return;
    }
    const root = buildFileTree(`${owner}/${repo}`, tree.tree as GhEntry[]);
    const src = createTreeSource(root, {
      fetchContent: (path) =>
        fetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodeURI(path)}`,
        )
          .then((r) => (r.ok ? r.text() : null))
          .catch(() => null),
    });
    src.setOnUpdate(() => lane.invalidate());
    sources.tree = src;
    if (current === "tree") lane.setSource(src);
    repoStat.textContent =
      `${(tree.tree as GhEntry[]).length.toLocaleString()} entries` +
      (tree.truncated ? " (truncated)" : "");
  } catch {
    if (my === repoToken) repoStat.textContent = "load failed";
  }
}
repoInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const parsed = parseRepo(repoInput.value);
  if (parsed) loadRepo(parsed.owner, parsed.repo);
  else repoStat.textContent = "bad repo";
});
// Don't fetch a multi-MB repo tree on load — the synthetic tree (with built-in
// content) is the instant default; a real GitHub repo is one ↵ away.
repoStat.textContent = "↵ load any GitHub repo";

// ── Wikipedia hover cards (deep-time view) ────────────────────────────────
interface WikiSummary {
  title?: string;
  extract?: string;
  type?: string;
  thumbnail?: { source: string };
  content_urls?: { desktop?: { page?: string } };
}
const cardEl = document.querySelector<HTMLAnchorElement>("#card")!;
const wikiCache = new Map<string, WikiSummary | null>();
let cardTitle: string | null = null;
let hoverTimer = 0;
let hideTimer = 0;
let overCard = false;

const WIKI_LANGS = (() => {
  const l = (navigator.language || "en").split("-")[0];
  return l === "en" ? ["en"] : [l, "en"]; // browser language first, en fallback
})();
async function wikiSummary(title: string): Promise<WikiSummary | null> {
  if (wikiCache.has(title)) return wikiCache.get(title) ?? null;
  for (const lang of WIKI_LANGS) {
    try {
      const r = await fetch(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`,
      );
      if (r.ok) {
        const j = (await r.json()) as WikiSummary;
        if (j?.extract && j.type !== "disambiguation") {
          wikiCache.set(title, j);
          return j;
        }
      }
    } catch {
      /* try next language */
    }
  }
  wikiCache.set(title, null);
  return null;
}
function positionCard(x: number, y: number) {
  const w = 290;
  const h = cardEl.offsetHeight || 200;
  let left = x + 18;
  let top = y + 12;
  if (left + w > innerWidth - 8) left = Math.max(8, x - w - 18);
  if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
  cardEl.style.left = `${left}px`;
  cardEl.style.top = `${top}px`;
}
async function showCard(title: string, x: number, y: number) {
  const s = await wikiSummary(title);
  if (cardTitle !== title) return; // pointer moved to another event
  if (!s || s.type === "disambiguation" || !s.extract) {
    hideCard();
    return;
  }
  cardEl.href =
    s.content_urls?.desktop?.page ??
    `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  const img = s.thumbnail?.source ? `<img src="${esc(s.thumbnail.source)}" alt="">` : "";
  cardEl.innerHTML =
    `${img}<div class="body"><p class="t">${esc(s.title ?? title)}</p>` +
    `<p class="x">${esc(s.extract)}</p><div class="src">WIKIPEDIA ↗</div></div>`;
  cardEl.classList.add("show");
  positionCard(x, y);
}
function hideCard() {
  if (overCard) return;
  cardEl.classList.remove("show");
  cardTitle = null;
}
canvas.addEventListener("pointermove", (e) => {
  if (current !== "time" || e.buttons) {
    hideCard();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const hit = timeSource.eventAt(e.clientX - rect.left, e.clientY - rect.top, lane.view);
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  if (hit) {
    if (hit.title !== cardTitle) {
      cardTitle = hit.title;
      const cx = e.clientX;
      const cy = e.clientY;
      hoverTimer = window.setTimeout(() => showCard(hit.title, cx, cy), 200);
    } else if (cardEl.classList.contains("show")) {
      positionCard(e.clientX, e.clientY);
    }
  } else {
    hideTimer = window.setTimeout(hideCard, 160);
  }
});
canvas.addEventListener("pointerleave", () => {
  hideTimer = window.setTimeout(hideCard, 160);
});
cardEl.addEventListener("pointerenter", () => {
  overCard = true;
  clearTimeout(hideTimer);
});
cardEl.addEventListener("pointerleave", () => {
  overCard = false;
  hideCard();
});

// ── theme toggle (mirrors index.html) ─────────────────────────────────────
const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
themeToggle?.addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("rgui-theme", next);
  lane.setTheme(next);
});

// ── i18n: translate labels into the browser's language (progressive) ──────
// Uses the built-in browser Translator API when available; renders English
// first and swaps in translations as they arrive — including labels from live
// fetches (translateNew runs again on each source update). No-op when
// unavailable or the browser is already English.
let translator: { translate(s: string): Promise<string> } | null = null;
const trCache = new Map<string, string>();
let translating = false;
async function translateNew() {
  if (!translator || translating) return;
  const todo = timeSource.strings().filter((s) => !trCache.has(s));
  if (!todo.length) return;
  translating = true;
  for (const s of todo) {
    try {
      trCache.set(s, await translator.translate(s));
    } catch {
      trCache.set(s, s); // keep English on failure
    }
  }
  translating = false;
  timeSource.setTranslate((s) => trCache.get(s) ?? s); // redraw with new text
}
async function initI18n() {
  const lang = (navigator.language || "en").split("-")[0];
  if (lang === "en") return;
  const T = (globalThis as unknown as { Translator?: any }).Translator;
  if (!T?.create) return;
  try {
    const avail = await T.availability?.({ sourceLanguage: "en", targetLanguage: lang });
    if (avail === "unavailable") return;
    translator = await T.create({ sourceLanguage: "en", targetLanguage: lang });
    await translateNew();
  } catch {
    /* Translator API unavailable — stay English */
  }
}
void initI18n();

// expose for host debugging / e2e
Object.assign(window as object, { lane, timeSource });
