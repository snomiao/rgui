/**
 * Demo entry for lane.html — the limited-visual-width / vertical-zoom mode.
 * Dogfoods src/lane exactly as a consumer would: two 1-D datasets (a synthetic
 * folder tree and a synthetic time series) behind one dataset-blind engine.
 */
import { createGitHistorySource, gitCacheStats } from "./lane/githistory.js";
import { createLane, type LaneSource } from "./lane/lane.js";
import { createTimelineSource } from "./lane/timeline.js";
import type { TimelineFold, TimelineSource } from "./lane/timeline.js";
import { FOLD_PERIOD_MS } from "./lane/temporal.js";
import { createSeriesSource } from "./lane/timeseries.js";
import { createLazyTreeSource, createTreeSource, type FileNode } from "./lane/tree.js";
import type { TreeProvider, TreeProviderEntry } from "./lane/treeprovider.js";

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
  const cache = gitCacheStats();
  const cacheLine = cache.entries
    ? `\n<span class="dim">cache</span> ${(cache.bytes / 1024).toFixed(0)} KB · ${cache.entries} win`
    : "";
  if (!net.total) {
    netEl.innerHTML = cacheLine.trimStart();
    return;
  }
  const via = [...net.hosts.entries()]
    .map(([h, c]) => `${SHORT[h] ?? h} ${c}`)
    .join(" · ");
  netEl.innerHTML =
    `<span class="dim">net</span> ${net.inflight} live · ${net.total} req` +
    (net.err ? ` · <span class="hi">${net.err} err</span>` : "") +
    (via ? `\n<span class="dim">via</span> ${via}` : "") +
    cacheLine;
}
// optional GitHub token: raises the API limit from 60 to 5,000 req/h. Kept
// in localStorage, injected below for api.github.com only.
const GH_TOKEN_KEY = "lane-gh-token";
let ghToken = localStorage.getItem(GH_TOKEN_KEY) ?? "";

const _fetch = window.fetch.bind(window);
const trackedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  let host = "?";
  try {
    const u = typeof input === "string" ? input : (input as Request).url ?? String(input);
    host = new URL(u, location.href).host;
  } catch {
    /* ignore */
  }
  if (host === "api.github.com" && ghToken) {
    init = {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${ghToken}`,
      },
    };
  }
  net.inflight++;
  net.total++;
  net.hosts.set(host, (net.hosts.get(host) ?? 0) + 1);
  renderNet();
  return _fetch(input, init)
    .then(
      (r) => {
        if (!r.ok) net.err++;
        // rate-limited without a token → walk the user through getting one
        if ((r.status === 403 || r.status === 429) && host === "api.github.com")
          maybeShowTokenPanel();
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
renderNet(); // a fully cache-served load makes no fetches — still show the cache line

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
// the git-history timeline is repo-swappable (↵ in the repo box replaces it)
const DEFAULT_GIT_REPOS = ["snomiao/rgui"];
// shareable git view: #r=owner/repo,owner/repo names the repo set in the URL
const hashRepos = (() => {
  const r = new URLSearchParams(location.hash.slice(1)).get("r");
  const list = r?.split(",").map((s) => s.trim()).filter(Boolean);
  return list?.length ? list : null;
})();
let gitRepos = hashRepos ?? DEFAULT_GIT_REPOS;
let gitSource: TimelineSource = createGitHistorySource({ repos: gitRepos, pageCap: ghToken ? 12 : 4, graphql: !!ghToken });
const treeSource = createTreeSource(genTree(0x51a1));

// ── lazy provider demo: the same generated repo behind a paginated, ────────
// artificially slow TreeProvider — exercises viewport-driven listing,
// unknown-vs-empty rendering, and the ≥-tiered aggregates.
function demoProvider(root: FileNode): TreeProvider {
  const find = (path: string): FileNode | null => {
    if (!path) return root;
    let cur: FileNode | undefined = root;
    for (const seg of path.split("/")) {
      cur = cur?.children?.find((c) => c.name === seg);
      if (!cur) return null;
    }
    return cur ?? null;
  };
  let rng = 0x9e3779b9;
  const rnd = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff), rng / 0x7fffffff);
  return {
    async list(path, { cursor, limit, signal }) {
      await new Promise((r) => setTimeout(r, 120 + rnd() * 380)); // network-ish
      if (signal.aborted) throw signal.reason;
      const dir = find(path);
      if (!dir?.children) throw new Error(`not a directory: ${path}`);
      const entries: TreeProviderEntry[] = dir.children.map((c) => ({
        name: c.name,
        kind: c.children ? "directory" : "file",
        size: c.size,
      }));
      const start = cursor ? parseInt(cursor, 10) : 0;
      const end = Math.min(entries.length, start + (limit ?? 32));
      return {
        entries: entries.slice(start, end),
        cursor: end < entries.length ? String(end) : undefined,
        complete: end >= entries.length,
        version: 1, // static demo snapshot
      };
    },
    read: async (path) => find(path)?.content ?? null,
  };
}
const lazyTreeSource = createLazyTreeSource(demoProvider(genTree(0x51a1)), {
  rootName: "rgui/",
  pageLimit: 32,
});

const sources: Record<string, LaneSource> = {
  tree: treeSource,
  time: timeSource,
  git: gitSource,
  series: buildSeries(),
};
// timeline-engine sources share their chrome (filters, fold, axis, search);
// whatever backs `current` right now is the one the chrome talks to
const timelines: Record<string, TimelineSource> = {
  time: timeSource,
  git: gitSource,
};
const activeTimeline = (): TimelineSource | null => timelines[current] ?? null;
// the demo trees mutate/materialize asynchronously — repaint on change
treeSource.setOnUpdate(() => lane.invalidate());
lazyTreeSource.setOnUpdate(() => lane.invalidate());
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
// ── path-per-dataset routing: /lane/tree/ · /lane/time/ · /lane/signal/ ──
// One app shell serves every path (vite rewrites the dataset paths to
// lane/index.html; the build copies it into each subdir). The path names
// the dataset; the hash keeps only the view (y/z). Legacy #src= links
// still resolve, then canonicalize to the path form on the first write.
const PATH_TO_SRC: Record<string, string> = { tree: "tree", time: "time", signal: "series", git: "git", agents: "git" }; // agents = legacy path
const SRC_TO_PATH: Record<string, string> = { tree: "tree", time: "time", series: "signal", git: "git" };
const lanePath = (key: string) => `/lane/${SRC_TO_PATH[key] ?? key}/`;
function srcFromPath(): string | null {
  const m = /\/lane\/([a-z]+)\/?/.exec(location.pathname);
  return m ? PATH_TO_SRC[m[1]!] ?? null : null;
}

const restored = parseHash();
let current = srcFromPath() ?? restored.src ?? "tree";

let hashTimer = 0;
function writeHash() {
  const p = new URLSearchParams();
  p.set("y", lane.view.scrollY.toPrecision(8));
  p.set("z", lane.view.zoomY.toPrecision(6));
  // non-default repo sets ride the hash so the git view is shareable
  if (current === "git" && gitRepos.join(",") !== DEFAULT_GIT_REPOS.join(","))
    p.set("r", gitRepos.join(","));
  // keep / and , literal — legal in a fragment, and the URL stays readable
  const h = p.toString().replace(/%2F/gi, "/").replace(/%2C/gi, ",");
  history.replaceState(null, "", lanePath(current) + "#" + h);
}
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(writeHash, 250);
}
// back/forward across dataset paths: swap the source, re-apply the view
window.addEventListener("popstate", () => {
  const key = srcFromPath();
  if (key && key !== current && sources[key]) {
    current = key;
    lane.setSource(sources[key]!);
    refreshChrome();
  }
  // a navigated-to git URL may name a different repo set
  const rp = new URLSearchParams(location.hash.slice(1)).get("r");
  const wantRepos = rp?.split(",").map((s) => s.trim()).filter(Boolean);
  const repos = wantRepos?.length ? wantRepos : DEFAULT_GIT_REPOS;
  if (current === "git" && repos.join(",") !== gitRepos.join(","))
    installGitSource(repos);
  const r = parseHash();
  if (r.scrollY != null || r.zoomY != null) {
    lane.setView({ scrollY: r.scrollY ?? undefined, zoomY: r.zoomY ?? undefined });
  }
});

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
// commit subjects stay English — feeding hundreds of live-fetched subjects
// through the on-device translator would swamp it for little gain
function wireGit(src: TimelineSource) {
  src.setOnUpdate(() => {
    lane.invalidate();
    updateGitStat();
  });
}
wireGit(gitSource);

// ── dataset switcher ──────────────────────────────────────────────────────
const seg = document.querySelector<HTMLDivElement>("#dataset")!;
const logBtn = document.querySelector<HTMLButtonElement>("#logscale");
const filters = document.querySelector<HTMLDivElement>("#filters")!;

// track filter chips — rebuilt when the active timeline changes (each
// timeline dataset brings its own track list; toggle state lives in the
// source, so a rebuild reflects it instead of resetting it)
let chipsFor: TimelineSource | null = null;
function buildFilterChips(tl: TimelineSource) {
  filters.innerHTML = "";
  for (const c of tl.categories) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.type = "button";
    chip.dataset.cat = c.cat;
    chip.setAttribute("aria-pressed", String(tl.isEnabled(c.cat)));
    chip.innerHTML = `<span class="swatch" style="background:${c.color}"></span>${c.label}`;
    chip.addEventListener("click", () => {
      const on = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", String(on));
      tl.setEnabled(c.cat, on);
      lane.invalidate();
    });
    filters.appendChild(chip);
  }
  chipsFor = tl;
}

const searchWrap = document.querySelector<HTMLDivElement>("#searchwrap")!;
const repoInput = document.querySelector<HTMLInputElement>("#repo")!;
const repoStat = document.querySelector<HTMLSpanElement>("#repostat")!;
// a shared #r= URL pre-fills the repo box with its repo set
if (hashRepos) repoInput.value = gitRepos.join(" ");

// ── GitHub token input + read-only-token tutorial panel ───────────────────
const ghTokenInput = document.querySelector<HTMLInputElement>("#ghtoken");
const tokenHelpBtn = document.querySelector<HTMLButtonElement>("#ghtokenHelp");
const tokenPanel = document.querySelector<HTMLDivElement>("#tokenPanel");
if (ghTokenInput) ghTokenInput.value = ghToken;
let tokenPanelAutoShown = false;
function maybeShowTokenPanel() {
  // auto-open once per session, and only when a token would actually help
  if (tokenPanelAutoShown || ghToken || !tokenPanel) return;
  tokenPanelAutoShown = true;
  tokenPanel.style.display = "";
}
tokenHelpBtn?.addEventListener("click", () => {
  if (!tokenPanel) return;
  const opening = tokenPanel.style.display === "none";
  tokenPanel.style.display = opening ? "" : "none";
  if (opening) ghTokenInput?.focus();
});
document.addEventListener("pointerdown", (e) => {
  if (!tokenPanel || tokenPanel.style.display === "none") return;
  const t = e.target as Node;
  if (tokenPanel.contains(t) || t === tokenHelpBtn || t === ghTokenInput) return;
  tokenPanel.style.display = "none";
});
ghTokenInput?.addEventListener("change", () => {
  ghToken = ghTokenInput.value.trim();
  try {
    if (ghToken) localStorage.setItem(GH_TOKEN_KEY, ghToken);
    else localStorage.removeItem(GH_TOKEN_KEY);
  } catch { /* private mode */ }
  if (tokenPanel) tokenPanel.style.display = "none";
  tokenHelpBtn?.setAttribute("aria-pressed", String(!!ghToken));
  // fresh source: rate-limited windows were marked attempted and would
  // otherwise never refetch; the new one also gets the deeper page chain
  installGitSource(gitRepos);
});
// the tree and git-history views share the one status span — remember the tree's
// text so switching datasets restores it instead of leaking the other's
let treeStatText = "↵ load any GitHub repo";
function setTreeStat(s: string) {
  treeStatText = s;
  if (current === "tree") repoStat.textContent = s;
}
function updateGitStat() {
  if (current !== "git") return;
  repoStat.textContent =
    `${gitRepos.join(" ")} · ${gitSource.eventCount().toLocaleString()} commits`;
}
const axisBtn = document.querySelector<HTMLButtonElement>("#axis");
const foldBtn = document.querySelector<HTMLButtonElement>("#fold");

// ── preferences panel: persisted, applied on load ───────────────────────────
// Behavioral toggles live here instead of hidden defaults. Auto zoom-out on
// empty scroll is OFF by default (taku: it fought users more than blank
// stretches did) and opt-in; animation/heat default on.
const PREFS_KEY = "lane-prefs";
type LanePrefs = {
  autoZoomOut: boolean;
  glide: boolean;
  heat: boolean;
  treeLive: boolean;
  treeLazy: boolean;
};
const prefs: LanePrefs = {
  autoZoomOut: false,
  glide: true,
  heat: true,
  treeLive: false,
  treeLazy: false,
};
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"));
} catch { /* corrupted prefs → defaults */ }

// ── tree demo: synthetic fs-watch mutator (deterministic, seeded) ──────────
// Exercises the dynamic-space path: a `live/` dir at the root gains, grows
// and loses generated files; shares re-deal within `live` only and glide.
let liveTimer = 0;
let liveN = 0;
let liveMade = false;
let liveRng = 0x2f6e2b1;
const liveRnd = () => (liveRng = (liveRng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function setTreeLive(on: boolean) {
  if (on && !liveTimer) {
    if (!liveMade) {
      treeSource.applyFsEvent("live", { name: "live", children: [] });
      liveMade = true;
    }
    liveTimer = window.setInterval(() => {
      const r = liveRnd();
      if (r < 0.45 || liveN < 3) {
        liveN++;
        treeSource.applyFsEvent(`live/gen-${liveN}.ts`, {
          name: `gen-${liveN}.ts`,
          size: 500 + Math.floor(liveRnd() * 8000),
        });
      } else if (r < 0.8) {
        const i = 1 + Math.floor(liveRnd() * liveN);
        treeSource.applyFsEvent(`live/gen-${i}.ts`, {
          name: `gen-${i}.ts`,
          size: 500 + Math.floor(liveRnd() * 90000),
        });
      } else {
        const i = 1 + Math.floor(liveRnd() * liveN);
        treeSource.applyFsEvent(`live/gen-${i}.ts`, null);
      }
    }, 900);
  } else if (!on && liveTimer) {
    clearInterval(liveTimer);
    liveTimer = 0;
  }
}

function applyPrefs() {
  lane.setAutoZoomOut(prefs.autoZoomOut);
  for (const tl of Object.values(timelines)) {
    tl.setGlide(prefs.glide);
    tl.setHeatCells(prefs.heat);
  }
  setTreeLive(prefs.treeLive);
  // lazy demo swaps which source backs the "tree" slot (GitHub-loaded trees
  // installed via the repo box override this until the pref is re-toggled)
  const wantTree = prefs.treeLazy ? lazyTreeSource : treeSource;
  if (sources.tree !== wantTree) {
    sources.tree = wantTree;
    if (current === "tree") lane.setSource(wantTree);
  }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}
const prefsBtn = document.querySelector<HTMLButtonElement>("#prefs");
const prefsPanel = document.querySelector<HTMLDivElement>("#prefsPanel");
prefsBtn?.addEventListener("click", () => {
  if (!prefsPanel) return;
  prefsPanel.style.display = prefsPanel.style.display === "none" ? "" : "none";
});
function bindPref(id: string, key: keyof LanePrefs) {
  const el = document.querySelector<HTMLInputElement>(id);
  if (!el) return;
  el.checked = prefs[key];
  el.addEventListener("change", () => {
    prefs[key] = el.checked;
    applyPrefs();
    lane.invalidate();
  });
}
bindPref("#prefAutoZoomOut", "autoZoomOut");
bindPref("#prefGlide", "glide");
bindPref("#prefHeat", "heat");
bindPref("#prefTreeLive", "treeLive");
bindPref("#prefTreeLazy", "treeLazy");
function refreshChrome() {
  const tl = activeTimeline();
  if (tl && chipsFor !== tl) buildFilterChips(tl);
  if (logBtn) {
    logBtn.style.display = current === "series" ? "" : "none";
    logBtn.setAttribute("aria-pressed", String(seriesLog));
  }
  if (axisBtn) {
    // the log/linear axis only applies to the continuous (unfolded) view
    axisBtn.style.display = tl && tl.getFold() === "none" ? "" : "none";
    const log = tl?.isLogAxis() ?? true;
    axisBtn.textContent = log ? "log axis" : "linear axis";
    axisBtn.setAttribute("aria-pressed", String(log));
  }
  if (foldBtn) {
    foldBtn.style.display = tl ? "" : "none";
    const on = tl?.isTrackFold() ?? false;
    foldBtn.textContent = on ? "fold: auto" : "fold: off";
    foldBtn.setAttribute("aria-pressed", String(on));
  }
  filters.style.display = tl ? "flex" : "none";
  searchWrap.style.display = tl ? "" : "none";
  // the repo box serves both repo-backed views: tree (files) + git history (commits)
  const repoable = current === "tree" || current === "git";
  const repoWrap = document.querySelector<HTMLDivElement>("#repowrap");
  if (repoWrap) repoWrap.style.display = repoable ? "" : "none";
  repoStat.style.display = repoable ? "" : "none";
  // the token input lives INSIDE the tutorial panel; the toolbar carries
  // only the "?" button, lit when a token is active
  if (tokenHelpBtn) {
    tokenHelpBtn.style.display = repoable ? "" : "none";
    tokenHelpBtn.setAttribute("aria-pressed", String(!!ghToken));
  }
  // one box, two views: remember each view's text and swap on dataset switch
  if (repoable && repoInput.dataset.view !== current && document.activeElement !== repoInput) {
    if (repoInput.dataset.view) repoInput.dataset[`text_${repoInput.dataset.view}`] = repoInput.value;
    repoInput.value =
      repoInput.dataset[`text_${current}`] ??
      (current === "git" ? gitRepos.join(" ") : repoInput.value);
    repoInput.dataset.view = current;
  }
  if (current === "git") updateGitStat();
  else if (current === "tree") repoStat.textContent = treeStatText;
  for (const b of seg.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.src === current));
  }
}
axisBtn?.addEventListener("click", () => {
  const tl = activeTimeline();
  if (!tl) return;
  tl.setLogAxis(!tl.isLogAxis());
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
  // per-track folding on/off (on by default — folds whenever space allows)
  const tl = activeTimeline();
  if (!tl) return;
  tl.setTrackFold(!tl.isTrackFold());
  refreshChrome();
});

// auto-fold watcher: acts only once the view SETTLES (a few unchanged
// frames) — firing mid zoom-gesture or mid focus-animation would re-anchor
// on a transient center and land the fold somewhere the user wasn't going
// The GLOBAL fold ladder is retired: per-track folding (timeline.ts
// trackFoldPos) folds each track independently whenever ITS space allows —
// the rg rule applied per element, with no global mode switch at all. The
// global fold machinery (applyFold/foldLevelFor/setFold) stays for the
// manual API and tests but no watcher drives it.
void applyFold; // referenced: kept for manual/global fold paths
void foldLevelFor;
seg.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-src]");
  if (!btn) return;
  const key = btn.dataset.src!;
  const src = sources[key];
  if (!src) return;
  current = key;
  // each dataset is its own path — switching is a real navigation entry
  history.pushState(null, "", lanePath(key));
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
  const tl = activeTimeline();
  hits = tl && q.trim() ? tl.find(q, 7) : [];
  activeIdx = hits.length ? 0 : -1;
  renderSuggest();
}
function focusHit(h: Hit) {
  lane.focus({ center: h.center, zoom: lane.view.height / h.scale });
  activeTimeline()?.setPulse(h);
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
// NOTE: the initial applyPrefs() runs at the END of this module — its
// setHeatCells → onUpdate → translateNew chain touches `let translator`,
// which is declared further down and still in its TDZ at this point.

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
function parseRepo(
  s: string,
): { owner: string; repo: string; branch?: string } | null {
  const t = s.trim();
  const m =
    t.match(/github\.com[/:]([^/]+)\/([^/#?\s]+)(?:\/tree\/([^#?\s]+))?/) ??
    t.match(/^([^/\s]+)\/([^/\s]+)(?:\/tree\/([^\s]+))?$/);
  return m
    ? { owner: m[1]!, repo: m[2]!.replace(/\.git$/, ""), branch: m[3] }
    : null;
}
const repoSpecOf = (p: { owner: string; repo: string; branch?: string }) =>
  `${p.owner}/${p.repo}` + (p.branch ? `/tree/${p.branch}` : "");

// swap in a fresh git-history timeline for a new repo set (same pattern as the
// tree demo: sources are cheap, replacing one beats teaching it to reset)
function installGitSource(repos: string[]) {
  gitRepos = repos;
  if (repoInput.value.trim() !== repos.join(" ")) repoInput.value = repos.join(" ");
  gitSource = createGitHistorySource({ repos, pageCap: ghToken ? 12 : 4, graphql: !!ghToken });
  sources.git = gitSource;
  timelines.git = gitSource;
  wireGit(gitSource);
  gitSource.setGlide(prefs.glide);
  gitSource.setHeatCells(prefs.heat);
  Object.assign(window as object, { gitSource });
  if (current === "git") {
    lane.setSource(gitSource);
    lane.fit();
  }
  refreshChrome(); // rebuilds the track chips for the new source
  updateGitStat();
}

let repoToken = 0; // guards against out-of-order loads
async function loadRepo(owner: string, repo: string, branchArg?: string) {
  const my = ++repoToken;
  setTreeStat("loading…");
  try {
    // an explicit /tree/branch spec skips the default-branch lookup
    let branch = branchArg;
    if (!branch) {
      const info = await fetch(`https://api.github.com/repos/${owner}/${repo}`).then(
        (r) => (r.ok ? r.json() : null),
      );
      branch = info?.default_branch ?? "HEAD";
    }
    const tree = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    ).then((r) => (r.ok ? r.json() : null));
    if (my !== repoToken) return; // superseded
    if (!tree?.tree) {
      setTreeStat("repo not found");
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
    setTreeStat(
      `${(tree.tree as GhEntry[]).length.toLocaleString()} entries` +
        (tree.truncated ? " (truncated)" : ""),
    );
  } catch {
    if (my === repoToken) setTreeStat("load failed");
  }
}
// commit the box's content for the current view
function loadRepoBox() {
  if (current === "git") {
    // commit-history view: accept one or many specs (space/comma separated);
    // empty input restores the default
    const raw = repoInput.value.trim();
    const parsed = (raw ? raw.split(/[\s,]+/) : DEFAULT_GIT_REPOS).map(parseRepo);
    if (parsed.length && parsed.every(Boolean)) {
      const specs = parsed.map((p) => repoSpecOf(p!));
      specs.forEach(pushRepoHistory);
      installGitSource(specs);
    } else {
      repoStat.textContent = "bad repo";
    }
    return;
  }
  const parsed = parseRepo(repoInput.value);
  if (parsed) {
    pushRepoHistory(repoSpecOf(parsed));
    void loadRepo(parsed.owner, parsed.repo, parsed.branch);
  } else repoStat.textContent = "bad repo";
}

// ── repo omnibox: dropdown suggestions ────────────────────────────────────
// Sources by shape of the LAST space-separated segment (the git view holds
// several specs in one box): recents always; "owner/…" lists that owner's
// repos; "owner/repo/…" lists branches; anything else falls back to GitHub
// repo search (its own rate-limit pool). Enter uses the typed text unless a
// suggestion is highlighted with the arrow keys.
const repoSuggestEl = document.querySelector<HTMLDivElement>("#repoSuggest");
type RepoHit = { value: string; det?: string };
let repoHits: RepoHit[] = [];
let repoIdx = -1;
const REPO_HISTORY_KEY = "lane-repo-history";
let repoHistory: string[] = [];
try {
  const h = JSON.parse(localStorage.getItem(REPO_HISTORY_KEY) ?? "[]");
  if (Array.isArray(h)) repoHistory = h.filter((s) => typeof s === "string");
} catch { /* corrupted history → empty */ }
function pushRepoHistory(spec: string) {
  repoHistory = [spec, ...repoHistory.filter((s) => s !== spec)].slice(0, 12);
  try { localStorage.setItem(REPO_HISTORY_KEY, JSON.stringify(repoHistory)); } catch { /* private mode */ }
}
const ownerRepoCache = new Map<string, { name: string; stars: number }[]>();
const branchListCache = new Map<string, string[]>();
let suggestGen = 0;
let suggestTimer = 0;
function repoSegment(): { start: number; text: string } {
  const v = repoInput.value;
  const start = v.lastIndexOf(" ") + 1;
  return { start, text: v.slice(start) };
}
function renderRepoSuggest() {
  if (!repoSuggestEl) return;
  repoSuggestEl.innerHTML = repoHits
    .map(
      (h, i) =>
        `<div class="hit${i === repoIdx ? " active" : ""}" data-i="${i}">` +
        `<span>${esc(h.value)}</span>` +
        (h.det ? `<span class="det">${esc(h.det)}</span>` : "") +
        `</div>`,
    )
    .join("");
}
function closeRepoSuggest() {
  repoHits = [];
  repoIdx = -1;
  renderRepoSuggest();
}
async function ghJson(url: string): Promise<unknown> {
  try {
    const r = await fetch(url);
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}
async function computeRepoSuggest() {
  const gen = ++suggestGen;
  const q = repoSegment().text.trim();
  const hits: RepoHit[] = [];
  const have = new Set<string>();
  const push = (h: RepoHit) => {
    if (!have.has(h.value) && hits.length < 8) {
      have.add(h.value);
      hits.push(h);
    }
  };
  for (const s of repoHistory)
    if (!q || s.toLowerCase().includes(q.toLowerCase())) push({ value: s, det: "recent" });
  const mBranch = /^([^/\s]+\/[^/\s]+)\/(?:tree\/?)?([^/\s]*)$/.exec(q);
  const mOwner = /^([^/\s]+)\/([^/\s]*)$/.exec(q);
  if (mBranch) {
    const path = mBranch[1]!;
    let branches = branchListCache.get(path);
    if (!branches) {
      const data = await ghJson(`https://api.github.com/repos/${path}/branches?per_page=100`);
      if (gen !== suggestGen) return;
      branches = Array.isArray(data)
        ? (data as { name: string }[]).map((b) => b.name)
        : [];
      branchListCache.set(path, branches);
    }
    for (const b of branches)
      if (b.toLowerCase().startsWith(mBranch[2]!.toLowerCase()))
        push({ value: `${path}/tree/${b}`, det: "branch" });
  } else if (mOwner) {
    const owner = mOwner[1]!;
    let list = ownerRepoCache.get(owner);
    if (!list) {
      const data = await ghJson(
        `https://api.github.com/users/${owner}/repos?sort=updated&per_page=100`,
      );
      if (gen !== suggestGen) return;
      list = Array.isArray(data)
        ? (data as { full_name: string; stargazers_count: number }[]).map((r) => ({
            name: r.full_name,
            stars: r.stargazers_count,
          }))
        : [];
      ownerRepoCache.set(owner, list);
    }
    for (const r of list)
      if (r.name.toLowerCase().startsWith(q.toLowerCase()))
        push({ value: r.name, det: `⭐ ${r.stars}` });
  } else if (q.length >= 2) {
    const data = await ghJson(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=8`,
    );
    if (gen !== suggestGen) return;
    const items =
      (data as { items?: { full_name: string; stargazers_count: number }[] })?.items ?? [];
    for (const r of items) push({ value: r.full_name, det: `⭐ ${r.stargazers_count}` });
  }
  if (gen !== suggestGen) return;
  repoHits = hits;
  repoIdx = -1; // typed text wins on Enter until the user arrows down
  renderRepoSuggest();
}
function applyRepoHit(h: RepoHit) {
  const { start } = repoSegment();
  repoInput.value = repoInput.value.slice(0, start) + h.value;
  closeRepoSuggest();
  loadRepoBox();
}
repoInput.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  suggestTimer = window.setTimeout(() => void computeRepoSuggest(), 250);
});
repoInput.addEventListener("focus", () => void computeRepoSuggest());
repoInput.addEventListener("blur", () => setTimeout(closeRepoSuggest, 140));
repoSuggestEl?.addEventListener("mousedown", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".hit");
  if (!el) return;
  e.preventDefault(); // keep focus so blur doesn't wipe the list mid-click
  applyRepoHit(repoHits[+el.dataset.i!]!);
});
repoInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" && repoHits.length) {
    repoIdx = Math.min(repoHits.length - 1, repoIdx + 1);
    renderRepoSuggest();
    e.preventDefault();
    return;
  }
  if (e.key === "ArrowUp" && repoHits.length) {
    repoIdx = Math.max(-1, repoIdx - 1);
    renderRepoSuggest();
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    closeRepoSuggest();
    return;
  }
  if (e.key !== "Enter") return;
  if (repoIdx >= 0 && repoHits[repoIdx]) {
    applyRepoHit(repoHits[repoIdx]!);
    return;
  }
  closeRepoSuggest();
  loadRepoBox();
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
  const gen = langGen; // language switches mid-flight invalidate this pass
  const tr = translator;
  if (!tr || translating) return;
  const todo = timeSource.strings().filter((s) => !trCache.has(s));
  if (!todo.length) return;
  translating = true;
  try {
    for (const s of todo) {
      let out = s; // keep English on failure
      try {
        out = await tr.translate(s);
      } catch { /* Translator hiccup — English stays */ }
      if (gen !== langGen) return; // stale language: drop, don't pollute cache
      trCache.set(s, out);
    }
    if (gen === langGen) {
      timeSource.setTranslate((s) => trCache.get(s) ?? s); // redraw with new text
    }
  } finally {
    translating = false;
    // re-kick when a switch happened mid-pass OR new strings arrived while
    // this pass ran (they were filtered out of `todo` at entry); failures
    // cache as identity, so this converges instead of spinning
    if (
      translator &&
      (gen !== langGen || timeSource.strings().some((s) => !trCache.has(s)))
    ) {
      void translateNew();
    }
  }
}
// language switcher: "auto" follows the browser; anything else is explicit.
// Switching tears the old translator down, reverts to English immediately,
// then swaps translations in as the new model delivers them.
const LANG_KEY = "lane-lang";
let langGen = 0;
async function setLang(choice: string) {
  const gen = ++langGen;
  translator = null;
  trCache.clear();
  timeSource.setTranslate((s) => s); // English right away; translations follow
  const target = choice === "auto" ? (navigator.language || "en").split("-")[0]! : choice;
  if (target === "en") return;
  const T = (globalThis as unknown as { Translator?: any }).Translator;
  if (!T?.create) return;
  try {
    const avail = await T.availability?.({ sourceLanguage: "en", targetLanguage: target });
    if (avail === "unavailable") return;
    const tr = await T.create({ sourceLanguage: "en", targetLanguage: target });
    if (gen !== langGen) return; // user switched again while the model loaded
    translator = tr;
    await translateNew();
  } catch {
    /* Translator API unavailable — stay English */
  }
}
const langSel = document.querySelector<HTMLSelectElement>("#lang");
const savedLang = localStorage.getItem(LANG_KEY) ?? "auto";
if (langSel) {
  langSel.value = savedLang;
  langSel.addEventListener("change", () => {
    try { localStorage.setItem(LANG_KEY, langSel.value); } catch { /* private mode */ }
    void setLang(langSel.value);
  });
}
void setLang(savedLang);

// initial preference application — after ALL module state (incl. the i18n
// `translator` binding) exists, so no callback lands in a TDZ
applyPrefs();

// expose for host debugging / e2e
Object.assign(window as object, { lane, timeSource, gitSource, treeSource, lazyTreeSource });
