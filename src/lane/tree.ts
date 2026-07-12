/**
 * rgui lane source — folder tree (semantic-zoom outline).
 *
 * The tree is laid out as a **screen-space icicle**: the root fills the band
 * the {@link LaneView} maps for it, and every expanded folder steals a fixed
 * readable header then deals the rest to its children by cheap-local weight
 * shares (stick-breaking intervals). Zoom controls only how tall that band
 * is, so:
 *
 *   • zoom out → a folder's band drops below `collapsePx` → it renders as ONE
 *     summary row ("📁 name — 128 files · 4.2 MB"); its children never draw.
 *   • zoom in  → the band grows past `collapsePx` → a header appears and the
 *     children get room, each recursing the same way — files eventually get
 *     tall enough to show size, kind, then a faux preview.
 *
 * Rows are always full-width (depth = x-indent), so width never changes with
 * zoom — the RG flow runs down the single axis. Nested layout is computed in
 * screen space, so an expanded header is always readable, never sub-pixel.
 */
import type { RgTheme } from "../core/theme.js";
import { withAlpha } from "../core/theme.js";
import type { LaneEnv, LaneSource } from "./lane.js";
import {
  KIND_COLOR,
  KIND_LABEL,
  KIND_ORDER,
  bucketWeight,
  chooseTreeFold,
  chunkRows,
  contentLevels,
  discloseLevel,
  heatRampColor,
  kindOf,
  srgbToOklch,
  type TreeFoldMode,
} from "./treefold.js";
import { screenToWorldY, worldToScreenY, type LaneView } from "./view.js";

/** host-supplied file/folder node. Folders have `children`; files have `size`. */
export interface FileNode {
  name: string;
  /** bytes; folders derive their total from children */
  size?: number;
  children?: FileNode[];
  /** file text; when present, zooming into the file reveals it line by line */
  content?: string;
  /** repo-relative path — lets a host lazily fetch content on zoom */
  path?: string;
}

/** optional hooks for lazy content loading (e.g. from a GitHub repo) */
export interface TreeOptions {
  /** fetch a file's text by its `path`; null/throw → leave it unloaded */
  fetchContent?: (path: string) => Promise<string | null>;
  /** called after lazily-loaded content arrives (host wires it to invalidate) */
  onUpdate?: () => void;
  /**
   * directory layout weight policy. "flat" (default) weighs every dir 1 —
   * navigation-first: siblings stay near-equal and overview stays a list.
   * "child-count" weighs a dir 1 + its immediate child count — density-
   * first: big dirs dominate and heterogeneous overviews fold into the
   * child×kind heat table. Only valid on complete listings (a lazy
   * provider must keep unlisted dirs at 1 or pagination churns shares).
   */
  dirWeight?: "flat" | "child-count";
}

/** cap on lazily-loaded content lines kept per file */
const MAX_FILE_UNITS = 120;
const BYTES_PER_LINE = 45; // size → estimated line count (drives zoom depth)

interface TNode {
  name: string;
  ext: string;
  isDir: boolean;
  children: TNode[];
  /**
   * CHEAP-LOCAL layout weight (see localWeight): file = own-size log2-KB
   * bucket, dir = 1 (or 1 + immediate child count under the opt-in
   * "child-count" policy). Never a subtree aggregate — deep content can't
   * move ancestors, and lazy loading never reshuffles layout.
   */
  weight: number;
  depth: number;
  fileCount: number; // descendant files
  totalSize: number; // descendant bytes
  lines: string[]; // file content split into lines (empty until loaded)
  path: string; // repo-relative path (for lazy content fetch)
  tried: boolean; // content load attempted?
  loading: boolean; // fetch in flight?
  /**
   * fraction of the PARENT's interval this node owns (stick-breaking
   * coordinates — TODO.md「区間分割座標」). Derived from sibling weights,
   * but only ever renormalized WITHIN one parent, so a mutation deep in
   * the tree never shifts anything outside its parent's interval.
   */
  share: number;
  shareFrom: number; // glide origin when the share was last re-dealt
  shareT0: number; // glide start timestamp (0 = settled)
}

const PAD_X = 10;
const INDENT = 15;
const MAX_INDENT_DEPTH = 12; // clamp indent so deep trees keep row width
const HEADER_PX = 22; // fixed readable folder header when expanded
const CULL = 24; // off-screen margin (px)
const REM_PX = 16; // readability unit for the fold grid (≥1rem rule)
const GRID_HEADER_PX = 12; // kind-column caption strip (like SMTWTFS)
const GRID_GUTTER_PX = 42; // left gutter for chunk row labels
const GLIDE_MS = 280; // share re-deal animation (matches timeline glide)

const EXT_COLOR: Record<string, string> = {
  ts: "#60a5fa",
  tsx: "#60a5fa",
  js: "#f7df1e",
  json: "#a3be8c",
  md: "#8b949e",
  html: "#e06c4b",
  css: "#c678dd",
  png: "#2dd4bf",
  gif: "#2dd4bf",
  jpg: "#2dd4bf",
  svg: "#2dd4bf",
  lock: "#5c6570",
  toml: "#d19a66",
};

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** deal sibling shares from weights — the ONLY place shares are (re)set.
 * `now` animates each sibling from its currently displayed share. */
function assignShares(children: TNode[], now = 0) {
  let total = 0;
  for (const c of children) total += c.weight;
  for (const c of children) {
    const next = total > 0 ? c.weight / total : 1 / children.length;
    if (now > 0 && Math.abs(next - c.share) > 1e-9) {
      c.shareFrom = dispShare(c, now);
      c.shareT0 = now;
    }
    c.share = next;
  }
}

/** share currently on screen — eases toward the target over GLIDE_MS */
function dispShare(t: TNode, now: number): number {
  if (!t.shareT0) return t.share;
  const p = (now - t.shareT0) / GLIDE_MS;
  if (p >= 1) {
    t.shareT0 = 0;
    return t.share;
  }
  const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
  return t.shareFrom + (t.share - t.shareFrom) * e;
}

/**
 * layout weight from CHEAP-LOCAL inputs only (the TODO.md contract): a
 * file weighs its own size's log2-KB bucket, a directory weighs 1 (flat,
 * default) or 1 + immediate child count (the opt-in "child-count" policy —
 * see TreeOptions.dirWeight). Subtree aggregates (fileCount/totalSize)
 * are display decoration and never feed layout.
 */
const localWeight = (
  isDir: boolean,
  childCount: number,
  ownSize: number,
  dirCount: boolean,
): number => (isDir ? (dirCount ? 1 + childCount : 1) : bucketWeight(ownSize));

function build(node: FileNode, depth: number, dirCount: boolean): TNode {
  if (node.children) {
    const children = node.children.map((c) => build(c, depth + 1, dirCount));
    let fileCount = 0;
    let totalSize = 0;
    for (const c of children) {
      fileCount += c.fileCount;
      totalSize += c.totalSize;
    }
    assignShares(children);
    return {
      name: node.name,
      ext: "",
      isDir: true,
      children,
      weight: localWeight(true, children.length, 0, dirCount),
      depth,
      fileCount,
      totalSize,
      lines: [],
      path: node.path ?? "",
      tried: true,
      loading: false,
      share: 1,
      shareFrom: 1,
      shareT0: 0,
    };
  }
  const lines = node.content ? node.content.split("\n") : [];
  const size = node.size ?? node.content?.length ?? 0;
  return {
    name: node.name,
    ext: extOf(node.name),
    isDir: false,
    children: [],
    weight: localWeight(false, 0, size, dirCount),
    depth,
    fileCount: 1,
    totalSize: size,
    lines,
    path: node.path ?? "",
    tried: !!node.content, // already have content → nothing to fetch
    loading: false,
    share: 1,
    shareFrom: 1,
    shareT0: 0,
  };
}

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtCount(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

/** truncate text to fit `maxW` px, appending … when clipped. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return "";
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : text.slice(0, lo) + "…";
}

const indentX = (depth: number) =>
  PAD_X + Math.min(depth, MAX_INDENT_DEPTH) * INDENT;

/** tree source with an optional lazy content loader (host wires setOnUpdate) */
export interface TreeSource extends LaneSource {
  setOnUpdate(fn: () => void): void;
  /**
   * fs-watch-style mutation: upsert (`node`) or delete (`null`) the entry at
   * `path` (slash-separated, root name excluded). Re-deals shares within the
   * parent only (with a glide) — nothing outside its interval moves.
   */
  applyFsEvent(path: string, node: FileNode | null): boolean;
}

const TEXT_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "json5", "md", "markdown",
  "txt", "rst", "adoc", "tex", "css", "scss", "less", "styl", "html", "htm",
  "xml", "svg", "vue", "svelte", "astro", "yml", "yaml", "toml", "ini", "cfg",
  "conf", "properties", "env", "c", "h", "cc", "cpp", "hpp", "cxx", "hxx", "m",
  "mm", "cs", "go", "rs", "java", "kt", "kts", "scala", "clj", "py", "pyi",
  "rb", "php", "lua", "sh", "bash", "zsh", "fish", "ps1", "bat", "sql", "r",
  "pl", "pm", "swift", "dart", "ex", "exs", "erl", "hs", "ml", "fs", "vim",
  "asm", "s", "S", "dts", "dtsi", "cmake", "mk", "in", "ac", "am", "gradle",
  "proto", "graphql", "gql", "diff", "patch", "csv", "tsv", "log", "gitignore",
  "gitattributes", "editorconfig", "lock", "makefile", "dockerfile", "readme",
  "license", "authors", "changelog", "todo", "kbuild", "kconfig", "defconfig",
]);
const isText = (t: TNode) =>
  t.ext === "" || TEXT_EXT.has(t.ext) || TEXT_EXT.has(t.name.toLowerCase());

export function createTreeSource(
  root: FileNode,
  opts: TreeOptions = {},
): TreeSource {
  const dirCount = opts.dirWeight === "child-count";
  const tree = build(root, 0, dirCount);
  const fetchContent = opts.fetchContent;
  let onUpdate: () => void = opts.onUpdate ?? (() => {});

  // Fetch a file's text on demand, capped so only a few load at once — combined
  // with viewport culling + a min-height gate, we only ever fetch the handful
  // of files actually being viewed at a readable scale.
  const MAX_CONCURRENT = 5;
  let inflight = 0;
  function loadContent(t: TNode) {
    if (t.tried || t.loading || !fetchContent || !t.path) return;
    if (inflight >= MAX_CONCURRENT) return; // wait for a slot (retried next frame)
    t.loading = true;
    inflight++;
    Promise.resolve(fetchContent(t.path))
      .then((text) => {
        t.tried = true;
        if (text != null) {
          t.lines = text.split("\n").slice(0, MAX_FILE_UNITS * 2);
          zoomDirty = true; // real line count may be finer than the estimate
        }
      })
      .catch(() => {
        t.tried = true;
      })
      .finally(() => {
        t.loading = false;
        inflight--;
        onUpdate();
      });
  }

  // ── shared layout (the treeFoldPos choke point) ───────────────────────
  // Screen bands, fold-run grouping, and grid-vs-strip decisions all live
  // here, consumed identically by draw() and hitTest() — never compute a
  // position in one coordinate frame and consume it in another.
  let frameNow = 0; // stamped once per draw; hitTest reuses the last stamp
  let gliding = false; // any share still easing this frame → keep redrawing

  function shareNow(c: TNode): number {
    const s = dispShare(c, frameNow);
    if (c.shareT0) gliding = true;
    return s;
  }

  /** screen bands for an expanded dir's children: [child, a, b] */
  function layoutChildren(t: TNode, top: number, inner: number): Array<[TNode, number, number]> {
    let total = 0;
    for (const c of t.children) total += shareNow(c);
    const bounds: Array<[TNode, number, number]> = [];
    let y = top;
    for (const c of t.children) {
      const b = y + (inner * shareNow(c)) / (total || 1);
      bounds.push([c, y, b]);
      y = b;
    }
    return bounds;
  }

  // ── per-directory fold mode: the design's division ladder, hysteretic ──
  // list (every child row readable) → grid (kind columns readable) → strip.
  // chooseTreeFold gets a readability unit scaled by the previous mode
  // (0.8 to stay list, 1.25 to re-enter it) so zoom jitter can't flap the
  // mode at a boundary. Decisions use TARGET shares — the settled layout —
  // never mid-glide display shares.
  type DirMode = TreeFoldMode["mode"];
  const modeCache = new WeakMap<TNode, DirMode>();

  interface DirLayout {
    mode: DirMode;
    headerB: number; // header bottom = children top
    bounds: Array<[TNode, number, number]>; // list mode child bands
    gridRows: number; // grid mode row budget (from the hysteretic chooser)
  }

  function treeFoldLayout(t: TNode, sy0: number, sy1: number, width: number): DirLayout {
    const bandH = sy1 - sy0;
    const headerB = sy0 + Math.min(HEADER_PX, bandH);
    const contentH = sy1 - headerB;
    const n = t.children.length;
    if (!n) return { mode: "strip", headerB, bounds: [], gridRows: 0 };
    let total = 0;
    let min = Infinity;
    for (const c of t.children) {
      total += c.share;
      if (c.share < min) min = c.share;
    }
    const minShare = total > 0 ? min / total : 1 / n;
    // first sight starts from the COARSEST mode so entering list/grid pays
    // the full 1.25×rem re-entry price — defaulting to "list" would let a
    // dir skip the entry hysteresis and then squat down to 0.8×rem
    const prev = modeCache.get(t) ?? "strip";
    // per-boundary hysteresis: each transition needs its own asymmetric
    // unit, or grid↔strip would share one threshold and flap
    const listUnit = REM_PX * (prev === "list" ? 0.8 : 1.25);
    const gridUnit = REM_PX * (prev === "strip" ? 1.25 : 0.8);
    const gridW = width - PAD_X - indentX(t.depth + 1) - GRID_GUTTER_PX;
    // the caption header is part of the grid-mode contract: reserve it
    // BEFORE budgeting rows, so it can't shrink an approved row below unit
    const gridContentH = Math.max(0, contentH - GRID_HEADER_PX);
    const m = chooseTreeFold(n, contentH, gridW, listUnit, minShare, gridUnit, gridContentH);
    modeCache.set(t, m.mode);
    return {
      mode: m.mode,
      headerB,
      bounds: m.mode === "list" ? layoutChildren(t, headerB, contentH) : [],
      gridRows: m.mode === "grid" ? m.rows : 0,
    };
  }

  function draw(ctx: CanvasRenderingContext2D, view: LaneView, env: LaneEnv) {
    const H = view.height;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;

    frameNow = performance.now();
    gliding = false;
    const sy0 = worldToScreenY(view, 0);
    const sy1 = worldToScreenY(view, 1);
    drawNode(ctx, tree, sy0, sy1, view, env, H);
    // shares still easing → schedule another frame through the host
    if (gliding) requestAnimationFrame(() => onUpdate());
  }

  function drawNode(
    ctx: CanvasRenderingContext2D,
    t: TNode,
    sy0: number,
    sy1: number,
    view: LaneView,
    env: LaneEnv,
    H: number,
  ) {
    if (sy1 < -CULL || sy0 > H + CULL) return;
    const bandH = sy1 - sy0;

    if (!t.isDir) {
      drawFileRow(ctx, t, sy0, sy1, env);
      return;
    }
    if (bandH < env.rule.collapsePx) {
      drawFolderSummary(ctx, t, sy0, sy1, env, false);
      return;
    }

    // expanded: fixed readable header, children fill the remainder in the
    // directory's fold mode (list / grid / strip — one decision per dir)
    const L = treeFoldLayout(t, sy0, sy1, env.size.width);
    drawFolderSummary(ctx, t, sy0, L.headerB, env, true);
    if (!t.children.length) return;

    if (L.mode === "list") {
      for (const [c, a, b] of L.bounds) {
        if (b < -CULL) continue;
        if (a > H + CULL) break;
        drawNode(ctx, c, a, b, view, env, H);
      }
    } else if (L.mode === "grid") {
      drawFoldGrid(ctx, t.children, L.headerB, sy1, t.depth + 1, env, L.gridRows);
    } else {
      drawAggStrip(ctx, L.headerB, sy1, t.depth + 1, t.children.length, t.fileCount, t.totalSize, env);
    }
  }

  // ── row painters ──────────────────────────────────────────────────────
  function rowClip(a: number, b: number, H: number): [number, number] {
    return [Math.max(a, -2), Math.min(b, H + 2)];
  }

  function drawFileRow(
    ctx: CanvasRenderingContext2D,
    t: TNode,
    sy0: number,
    sy1: number,
    env: LaneEnv,
  ) {
    const { theme } = env;
    const x = indentX(t.depth);
    const right = env.size.width - PAD_X;
    const h = sy1 - sy0;
    const [ca, cb] = rowClip(sy0, sy1, env.size.height);
    const color = EXT_COLOR[t.ext] ?? theme.textMuted;

    ctx.fillStyle = withAlpha(theme.nodeBg, h > 40 ? 0.5 : 0.28);
    ctx.fillRect(x, ca, right - x, cb - ca);
    ctx.fillStyle = color;
    ctx.fillRect(x, ca, 2, cb - ca); // ext spine

    if (h < 11) return; // too short for text

    // header strip: name + size, always at the band top
    const headerH = Math.min(h, HEADER_PX);
    const mid = sy0 + headerH / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 10, mid, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = theme.textMuted;
    const sizeTxt = t.totalSize ? fmtBytes(t.totalSize) : "";
    if (sizeTxt) ctx.fillText(sizeTxt, right - 6, mid);
    const sizeW = sizeTxt ? ctx.measureText(sizeTxt).width + 12 : 0;
    ctx.font = "12px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = theme.text;
    ctx.fillText(fit(ctx, t.name, right - (x + 18) - sizeW), x + 18, mid);

    // content region below the header
    const top = sy0 + headerH;
    if (sy1 - top < 8) return;
    // lazily pull the file's real text once its row is tall enough to read it
    // (only visible files reach here, and only readable-scale ones fetch)
    if (!t.lines.length && !t.tried && h >= 60 && isText(t)) loadContent(t);
    if (t.lines.length) drawContent(ctx, t, top, sy1, x, right, color, env);
    else if (t.loading) {
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.fillStyle = theme.textFaint;
      ctx.fillText("loading…", x + 18, top + 10);
    } else if (h >= 90) {
      drawPreview(ctx, x + 18, top + 6, right - 6, sy1 - 8, color, theme);
    }
  }

  /**
   * Render the file's text: lines map uniformly onto the content region, one
   * per world unit, so line height ≈ zoomY. Readable lines get real text (with
   * a line-number gutter and comment tinting); sub-readable lines fall back to
   * a code-minimap of length-proportional bars. Only visible lines are drawn.
   */
  function drawContent(
    ctx: CanvasRenderingContext2D,
    t: TNode,
    top: number,
    bottom: number,
    x: number,
    right: number,
    color: string,
    env: LaneEnv,
  ) {
    const { theme } = env;
    const H = env.size.height;
    const lines = t.lines;
    const lineH = (bottom - top) / lines.length;
    if (lineH < 0.5) {
      ctx.fillStyle = withAlpha(theme.textFaint, 0.4);
      const a = Math.max(top, -2);
      ctx.fillRect(x + 6, a, right - x - 12, Math.min(bottom, H + 2) - a);
      return;
    }
    // visible line window
    const i0 = Math.max(0, Math.floor((-2 - top) / lineH));
    const i1 = Math.min(lines.length - 1, Math.ceil((H + 2 - top) / lineH));
    // full text only once every line is genuinely readable (≥ font height);
    // the 0.8–13px band belongs to the minimap + progressive disclosure
    const textMode = lineH >= 13;
    const gx = x + 8;
    const gutterW = textMode ? 30 : 0;
    const tx = gx + gutterW;
    const font = lineH >= 15 ? 12 : 11;

    if (textMode) ctx.font = `${font}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    for (let i = i0; i <= i1; i++) {
      const ly = top + i * lineH;
      const line = lines[i]!;
      if (!textMode) {
        // minimap: bar length ∝ line length, indent ∝ leading spaces
        const trimmed = line.trimStart();
        if (!trimmed) continue;
        const indent = line.length - trimmed.length;
        const charW = Math.max(1, lineH * 0.55);
        const isComment = /^(\/\/|#|\*|<!--)/.test(trimmed);
        ctx.fillStyle = isComment
          ? withAlpha(theme.textFaint, 0.5)
          : withAlpha(color, 0.45);
        ctx.fillRect(
          tx + indent * charW,
          ly + lineH * 0.2,
          Math.min(right - tx - 4, trimmed.length * charW),
          Math.max(1, lineH * 0.6),
        );
        continue;
      }
      const cy = ly + lineH / 2;
      // line number gutter
      ctx.fillStyle = withAlpha(theme.textFaint, 0.7);
      ctx.textAlign = "right";
      ctx.fillText(String(i + 1), tx - 8, cy);
      ctx.textAlign = "left";
      // code text (dim comments)
      const isComment = /^\s*(\/\/|#|\*|<!--)/.test(line);
      ctx.fillStyle = isComment ? theme.textMuted : theme.textDim;
      ctx.fillText(fit(ctx, line || " ", right - tx - 6), tx, cy);
    }

    // progressive disclosure over the minimap: structural anchor lines
    // (indent level / md heading ladder) surface readable text as space
    // grows — level 0 first, deeper levels once their lines fit the budget
    if (!textMode && lineH >= 0.8) {
      const levels = levelsOf(t);
      const budget = Math.max(1, Math.floor((Math.min(bottom, H) - Math.max(top, 0)) / 12));
      const L = discloseLevel(levels, i0, i1, budget);
      if (L >= 0) {
        ctx.font = "10px ui-monospace, Menlo, monospace";
        ctx.textAlign = "left";
        let lastBottom = -Infinity;
        for (let i = i0; i <= i1; i++) {
          if (levels[i]! > L) continue;
          const ly = top + i * lineH;
          if (ly < lastBottom) continue; // declutter: keep top-most
          const ix = tx + levels[i]! * 12; // indent mirrors the structure
          const text = fit(ctx, lines[i]!.trim(), right - ix - 6);
          if (!text) continue;
          const w = ctx.measureText(text).width;
          // wash behind the label so it reads over the bars
          ctx.fillStyle = withAlpha(theme.background as string, 0.72);
          ctx.fillRect(ix - 2, ly - 5, w + 6, 12);
          ctx.fillStyle = theme.textDim;
          ctx.fillText(text, ix, ly + 1);
          lastBottom = ly + 12;
        }
      }
    }
  }

  // structural levels per line, cached on the node (invalidated with lines)
  const levelCache = new WeakMap<TNode, { key: number; levels: number[] }>();
  function levelsOf(t: TNode): number[] {
    const hit = levelCache.get(t);
    if (hit && hit.key === t.lines.length) return hit.levels;
    const levels = contentLevels(t.lines, t.ext === "md" || t.ext === "markdown");
    levelCache.set(t, { key: t.lines.length, levels });
    return levels;
  }

  function drawPreview(
    ctx: CanvasRenderingContext2D,
    x: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    theme: RgTheme,
  ) {
    if (y1 - y0 < 12) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y0, x1 - x, y1 - y0);
    ctx.clip();
    // pseudo code/content lines seeded by name width — cheap, deterministic
    ctx.fillStyle = withAlpha(theme.textFaint, 0.55);
    let seed = Math.round(x1 - x) * 2654435761;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let y = y0 + 2, k = 0; y < y1 - 3; y += 7, k++) {
      const w = (x1 - x) * (0.25 + rnd() * 0.6);
      const ind = (k % 4) * 10;
      ctx.fillStyle = k % 6 === 0 ? withAlpha(color, 0.5) : withAlpha(theme.textFaint, 0.5);
      ctx.fillRect(x + ind, y, w, 2.5);
    }
    ctx.restore();
  }

  function drawFolderSummary(
    ctx: CanvasRenderingContext2D,
    t: TNode,
    sy0: number,
    sy1: number,
    env: LaneEnv,
    expanded: boolean,
  ) {
    const { theme } = env;
    const x = indentX(t.depth);
    const right = env.size.width - PAD_X;
    const [ca, cb] = rowClip(sy0, sy1, env.size.height);
    const h = cb - ca;

    ctx.fillStyle = withAlpha(theme.accent, expanded ? 0.14 : 0.07);
    ctx.fillRect(x, ca, right - x, h);
    if (expanded) {
      ctx.strokeStyle = withAlpha(theme.accent, 0.35);
      ctx.beginPath();
      ctx.moveTo(x, cb - 0.5);
      ctx.lineTo(right, cb - 0.5);
      ctx.stroke();
    }
    if (h < 10) return;
    const mid = (ca + cb) / 2;
    // disclosure triangle
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    if (expanded) {
      ctx.moveTo(x + 4, mid - 3);
      ctx.lineTo(x + 12, mid - 3);
      ctx.lineTo(x + 8, mid + 3);
    } else {
      ctx.moveTo(x + 5, mid - 4);
      ctx.lineTo(x + 11, mid);
      ctx.lineTo(x + 5, mid + 4);
    }
    ctx.closePath();
    ctx.fill();
    // aggregate right-aligned
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = theme.textDim;
    const agg = `${fmtCount(t.fileCount)} · ${fmtBytes(t.totalSize)}`;
    ctx.fillText(agg, right - 6, mid);
    const aggW = ctx.measureText(agg).width + 12;
    // name
    ctx.font = "12px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = theme.text;
    ctx.fillText(fit(ctx, t.name, right - (x + 18) - aggW), x + 18, mid);
  }

  /**
   * Fold a run of sub-readable siblings into a grid: rows = contiguous
   * index chunks of the run (each row therefore covers a contiguous world
   * span, keeping the world↔screen mapping monotone for hit-tests), columns
   * = the fixed kind buckets, cells = OKLCH heat by count. Empty cells stay
   * as ghost placeholders so columns align across rows — the tree analog of
   * the 28-day month's blank grid cells.
   *
   * NOTE v1: focusAt/hudLine still use the pure-world mapping, which the
   * Row geometry comes from gridLayout — the same function hitTest uses,
   * so a hover/double-click lands on exactly the drawn row.
   */
  function gridLayout(run: TNode[], sy0: number, sy1: number, rowsHint = 0) {
    // grid-mode contract: the caption header is ALWAYS reserved — the
    // chooser already budgeted rows on the band minus this header, so its
    // appearance can never re-flow or shrink an approved row
    const top = sy0 + GRID_HEADER_PX;
    const gridH = Math.max(0, sy1 - top);
    // the hysteretic chooser's row budget is the single source when given;
    // recomputing here with a different unit would fork the contract
    const rows = chunkRows(
      run.map((n) => n.name),
      rowsHint > 0 ? rowsHint : Math.max(1, Math.floor(gridH / REM_PX)),
    );
    return { top, rows, rowH: rows.length ? gridH / rows.length : 0 };
  }

  function drawFoldGrid(
    ctx: CanvasRenderingContext2D,
    run: TNode[],
    sy0: number,
    sy1: number,
    depth: number,
    env: LaneEnv,
    rowsHint = 0,
  ) {
    const { theme } = env;
    const H = env.size.height;
    const x = indentX(depth);
    const right = env.size.width - PAD_X;
    const [ca, cb] = rowClip(sy0, sy1, H);
    if (cb - ca <= 0) return;
    const dark = srgbToOklch(theme.background as string).L < 0.5;

    ctx.fillStyle = withAlpha(theme.nodeBg, 0.2);
    ctx.fillRect(x, ca, right - x, cb - ca);

    // header strip: kind captions over their columns
    const gx = x + GRID_GUTTER_PX;
    const cols = KIND_ORDER.length;
    const colW = (right - gx) / cols;
    // rows come from the run's TRUE span (gridSpan), not the clipped one —
    // otherwise rows re-flow as the viewport edge slides across the run
    const { top, rows, rowH } = gridLayout(run, sy0, sy1, rowsHint);
    if (!rows.length) return;
    if (top > -2) {
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = theme.textMuted;
      for (let c = 0; c < cols; c++) {
        ctx.fillText(KIND_LABEL[KIND_ORDER[c]!], gx + (c + 0.5) * colW, sy0 + GRID_HEADER_PX / 2);
      }
    }

    ctx.textBaseline = "middle";
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      const ry = top + r * rowH;
      if (ry + rowH < -2) continue;
      if (ry > H + 2) break;
      // per-kind counts = each row member's CONTENTS projection: a file
      // counts itself, a complete dir counts its immediate children (one
      // readdir deep), a complete-EMPTY dir contributes nothing — all-ghost
      // row, never a fabricated count. (Unknown/partial dirs get an
      // unknown-presence tint once a lazy TreeProvider exists.)
      const counts: Record<string, number> = {};
      for (let k = row.start; k < row.end; k++) {
        const n = run[k]!;
        if (n.isDir) {
          for (const c of n.children) {
            const kb = kindOf(c.name, c.isDir);
            counts[kb] = (counts[kb] ?? 0) + 1;
          }
        } else {
          const kb = kindOf(n.name, n.isDir);
          counts[kb] = (counts[kb] ?? 0) + 1;
        }
      }
      for (let c = 0; c < cols; c++) {
        const kb = KIND_ORDER[c]!;
        const cnt = counts[kb] ?? 0;
        const cx = gx + c * colW;
        if (cnt > 0) {
          ctx.fillStyle = heatRampColor(KIND_COLOR[kb], cnt, dark);
          ctx.fillRect(cx, ry, colW, rowH);
          if (cnt > 1 && colW >= 24 && rowH >= 12) {
            ctx.font = "9px ui-monospace, Menlo, monospace";
            ctx.textAlign = "center";
            ctx.fillStyle = dark ? theme.text : theme.textDim;
            ctx.fillText(String(cnt), cx + colW / 2, ry + rowH / 2);
          }
        } else {
          // ghost placeholder keeps the column aligned
          ctx.fillStyle = withAlpha(theme.textFaint, 0.05);
          ctx.fillRect(cx, ry, colW, rowH);
        }
      }
      // chunk label in the left gutter
      if (rowH >= 10) {
        ctx.font = "9px ui-monospace, Menlo, monospace";
        ctx.textAlign = "left";
        ctx.fillStyle = theme.textMuted;
        ctx.fillText(fit(ctx, row.label, GRID_GUTTER_PX - 8), x + 2, ry + rowH / 2);
      }
      // 1px row separator
      ctx.fillStyle = withAlpha(theme.textFaint, 0.25);
      ctx.fillRect(gx, ry, right - gx, 1);
    }
    // 1px column separators (drawn last so they sit above cell fills)
    const sepTop = Math.max(top, -2);
    ctx.fillStyle = withAlpha(theme.textFaint, 0.25);
    for (let c = 0; c <= cols; c++) {
      ctx.fillRect(gx + c * colW, sepTop, 1, Math.max(0, cb - sepTop));
    }
    ctx.textAlign = "left";
  }

  function drawAggStrip(
    ctx: CanvasRenderingContext2D,
    sy0: number,
    sy1: number,
    depth: number,
    count: number,
    files: number,
    size: number,
    env: LaneEnv,
  ) {
    const { theme } = env;
    const x = indentX(depth);
    const right = env.size.width - PAD_X;
    const [ca, cb] = rowClip(sy0, sy1, env.size.height);
    const h = cb - ca;
    ctx.fillStyle = withAlpha(theme.textFaint, 0.1);
    ctx.fillRect(x, ca, right - x, h);
    if (h < 12) return;
    const mid = (ca + cb) / 2;
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = theme.textMuted;
    ctx.fillText(
      `⋯ ${count} more · ${fmtCount(files)} · ${fmtBytes(size)}`,
      x + 6,
      mid,
    );
    ctx.textAlign = "left";
  }

  // ── hit-test: replay the SAME screen-space recursion draw() runs ────────
  // Returns the deepest visible thing under screenY plus its world interval
  // [wa, wb) (target shares — the settled state, so a focus zoom lands where
  // the layout is heading, not mid-glide).
  interface Hit {
    trail: string[];
    wa: number;
    wb: number;
  }
  function hitTest(
    t: TNode,
    sy0: number,
    sy1: number,
    wa: number,
    wb: number,
    screenY: number,
    view: LaneView,
    width: number,
    collapsePx: number,
    trail: string[],
  ): Hit {
    trail.push(t.name);
    const bandH = sy1 - sy0;
    if (!t.isDir || bandH < collapsePx || !t.children.length) return { trail, wa, wb };
    const L = treeFoldLayout(t, sy0, sy1, width);
    if (screenY < L.headerB) return { trail, wa, wb };

    // world offsets from TARGET shares, matching the settled layout
    const prefix: number[] = [0];
    for (const c of t.children) prefix.push(prefix[prefix.length - 1]! + c.share);
    const norm = prefix[prefix.length - 1]! || 1;
    const worldAt = (i0: number, i1: number): [number, number] => [
      wa + ((wb - wa) * prefix[i0]!) / norm,
      wa + ((wb - wa) * prefix[i1]!) / norm,
    ];
    if (L.mode === "list") {
      for (let i = 0; i < L.bounds.length; i++) {
        const [c, a, b] = L.bounds[i]!;
        if (screenY >= b) continue;
        const [cwa, cwb] = worldAt(i, i + 1);
        return hitTest(c, a, b, cwa, cwb, screenY, view, width, collapsePx, trail);
      }
      return { trail, wa, wb };
    }
    if (L.mode === "grid") {
      // land on the chunk row under the cursor; the caption header above
      // the rows hits the whole directory, not a fake first row
      const { top: gTop, rows, rowH } = gridLayout(t.children, L.headerB, sy1, L.gridRows);
      if (screenY >= gTop && rows.length) {
        const r = Math.min(rows.length - 1, Math.max(0, Math.floor((screenY - gTop) / (rowH || 1))));
        const row = rows[r];
        if (row) {
          const [cwa, cwb] = worldAt(row.start, row.end);
          trail.push(row.label);
          return { trail, wa: cwa, wb: cwb };
        }
      }
    }
    return { trail, wa, wb }; // strip / grid header: the directory itself
  }

  function hitAt(screenY: number, view: LaneView): Hit {
    frameNow = performance.now();
    return hitTest(
      tree,
      worldToScreenY(view, 0),
      worldToScreenY(view, 1),
      0,
      1,
      screenY,
      view,
      lastWidth,
      lastCollapsePx,
      [],
    );
  }
  // segment()/layoutChildren need the env draw() saw — remember the last one
  let lastWidth = 800;
  let lastCollapsePx = 26;

  // ── adaptive zoom-in limit: finest content line reaches ~1rem ──────────
  // Same rule as the timeline's precision clamp: stop zooming where the
  // finest thing the data can show (a file's line) is readable. Lazily
  // recomputed after mutations; unknown subtrees deepen it when they list.
  let zoomDirty = true;
  let cachedMaxZoom = 240;
  function maxZoomOf(): number {
    if (!zoomDirty) return cachedMaxZoom;
    zoomDirty = false;
    let minLine = Infinity; // world height of the finest line
    const walk = (t: TNode, len: number) => {
      if (len <= 0) return;
      if (!t.isDir) {
        // weight is a layout bucket, not a line count — zoom depth targets
        // real loaded lines when present (loaded data REPLACES the byte
        // estimate: an inflated estimate must not keep the clamp deep),
        // else the estimate capped at what the loader would ever retain
        const estLines = Math.min(
          Math.round(t.totalSize / BYTES_PER_LINE),
          MAX_FILE_UNITS * 2,
        );
        const lineCount = t.lines.length ? t.lines.length : Math.max(1, estLines);
        minLine = Math.min(minLine, len / lineCount);
        return;
      }
      for (const c of t.children) walk(c, len * c.share);
    };
    walk(tree, 1);
    cachedMaxZoom =
      minLine === Infinity ? 240 : Math.min(1e12, (REM_PX / Math.max(minLine, 1e-15)) * 4);
    return cachedMaxZoom;
  }

  // ── mutations: fs-watch semantics, locality by construction ────────────
  // Upsert (node) or delete (null) the entry at `path` (slash-separated,
  // relative to the root, root name excluded). Shares are re-dealt within
  // the parent only, with a glide from the currently displayed layout;
  // ancestor aggregates (counts/sizes/weights) update as decoration without
  // re-dealing their shares — nothing outside the parent's interval moves.
  function applyFsEvent(path: string, node: FileNode | null): boolean {
    const segs = path.split("/").filter(Boolean);
    if (!segs.length) return false;
    const chain: TNode[] = [tree];
    let parent = tree;
    for (let i = 0; i < segs.length - 1; i++) {
      const nx = parent.children.find((c) => c.name === segs[i]);
      if (!nx || !nx.isDir) return false;
      parent = nx;
      chain.push(nx);
    }
    const name = segs[segs.length - 1]!;
    const idx = parent.children.findIndex((c) => c.name === name);
    const now = performance.now();
    if (node == null) {
      if (idx < 0) return false;
      parent.children.splice(idx, 1);
    } else {
      const built = build(node, parent.depth + 1, dirCount);
      if (idx < 0) {
        built.share = 0; // grows in from nothing
        built.shareFrom = 0;
        parent.children.push(built);
      } else {
        const old = parent.children[idx]!;
        built.share = old.share;
        built.shareFrom = dispShare(old, now);
        built.lines = built.lines.length ? built.lines : old.lines;
        built.tried = built.tried || old.tried;
        parent.children[idx] = built;
      }
    }
    assignShares(parent.children, now);
    // ancestor refresh: weights stay LOCAL (1 + own child count — only the
    // direct parent's can change); counts/sizes are display decoration
    for (let i = chain.length - 1; i >= 0; i--) {
      const d = chain[i]!;
      d.weight = localWeight(true, d.children.length, 0, dirCount);
      d.fileCount = 0;
      d.totalSize = 0;
      for (const c of d.children) {
        d.fileCount += c.fileCount;
        d.totalSize += c.totalSize;
      }
    }
    zoomDirty = true;
    onUpdate();
    return true;
  }

  return {
    title: "folder tree",
    extent: () => ({ min: 0, max: 1 }),
    get maxZoom() {
      return maxZoomOf();
    },
    draw: (ctx: CanvasRenderingContext2D, view: LaneView, env: LaneEnv) => {
      lastWidth = env.size.width;
      lastCollapsePx = env.rule.collapsePx;
      draw(ctx, view, env);
    },
    // double-click → center the clicked thing and zoom so it fills the view
    focusAt: (screenY, view) => {
      const { wa, wb } = hitAt(screenY, view);
      const len = Math.max(wb - wa, 1e-12);
      return { center: (wa + wb) / 2, zoom: (view.height / len) * 0.9 };
    },
    hudLine: (view, pointerY) => {
      const { trail } = hitAt(pointerY ?? view.height / 2, view);
      return trail.join("/") || null;
    },
    setOnUpdate(fn) {
      onUpdate = fn;
    },
    applyFsEvent,
  };
}
