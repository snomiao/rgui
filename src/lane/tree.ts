/**
 * rgui lane source — folder tree (semantic-zoom outline).
 *
 * The tree is laid out as a **screen-space icicle**: the root fills the band
 * the {@link LaneView} maps for it, and every expanded folder steals a fixed
 * readable header then subdivides the rest among its children in proportion to
 * subtree weight (node count). Zoom controls only how tall that band is, so:
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
}

/** a content file spans this many world units at most (keeps layout balanced) */
const MAX_FILE_UNITS = 120;
const BYTES_PER_LINE = 45; // size → estimated line count (fixes weight up-front)

interface TNode {
  name: string;
  ext: string;
  isDir: boolean;
  children: TNode[];
  /**
   * self-row + descendants, in world units. Folders/plain files = 1 unit;
   * a file with content (or a known byte size) spans ~one unit per line, so
   * zooming in spreads its lines out until each is readable. Weight is fixed
   * from the byte size up-front so lazy content loading never reshuffles it.
   */
  weight: number;
  depth: number;
  fileCount: number; // descendant files
  totalSize: number; // descendant bytes
  lines: string[]; // file content split into lines (empty until loaded)
  path: string; // repo-relative path (for lazy content fetch)
  tried: boolean; // content load attempted?
  loading: boolean; // fetch in flight?
}

const PAD_X = 10;
const INDENT = 15;
const MAX_INDENT_DEPTH = 12; // clamp indent so deep trees keep row width
const HEADER_PX = 22; // fixed readable folder header when expanded
const MIN_ROW = 6; // runs of thinner siblings fold into an aggregate strip
const CULL = 24; // off-screen margin (px)

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

function build(node: FileNode, depth: number): TNode {
  if (node.children) {
    const children = node.children.map((c) => build(c, depth + 1));
    let weight = 1;
    let fileCount = 0;
    let totalSize = 0;
    for (const c of children) {
      weight += c.weight;
      fileCount += c.fileCount;
      totalSize += c.totalSize;
    }
    return {
      name: node.name,
      ext: "",
      isDir: true,
      children,
      weight,
      depth,
      fileCount,
      totalSize,
      lines: [],
      path: node.path ?? "",
      tried: true,
      loading: false,
    };
  }
  const lines = node.content ? node.content.split("\n") : [];
  // estimate line count from bytes when content isn't loaded yet, so the file's
  // world-height (and thus zoomability) is fixed before any lazy fetch
  const estLines = lines.length || Math.round((node.size ?? 0) / BYTES_PER_LINE);
  return {
    name: node.name,
    ext: extOf(node.name),
    isDir: false,
    children: [],
    weight: estLines ? Math.min(estLines + 1, MAX_FILE_UNITS) : 1,
    depth,
    fileCount: 1,
    totalSize: node.size ?? 0,
    lines,
    path: node.path ?? "",
    tried: !!node.content, // already have content → nothing to fetch
    loading: false,
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
  const tree = build(root, 0);
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
        if (text != null) t.lines = text.split("\n").slice(0, MAX_FILE_UNITS * 2);
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

  function draw(ctx: CanvasRenderingContext2D, view: LaneView, env: LaneEnv) {
    const H = view.height;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;

    const sy0 = worldToScreenY(view, 0);
    const sy1 = worldToScreenY(view, tree.weight);
    drawNode(ctx, tree, sy0, sy1, view, env, H);
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

    // expanded: fixed readable header, children subdivide the remainder
    const headerH = Math.min(HEADER_PX, bandH);
    drawFolderSummary(ctx, t, sy0, sy0 + headerH, env, true);

    const childrenW = t.weight - 1;
    if (childrenW <= 0) return;
    const top = sy0 + headerH;
    const inner = sy1 - top;

    // screen bands for each child: [child, a, b]
    const bounds: Array<[TNode, number, number]> = [];
    let y = top;
    for (const c of t.children) {
      const b = y + (inner * c.weight) / childrenW;
      bounds.push([c, y, b]);
      y = b;
    }

    let i = 0;
    while (i < bounds.length) {
      const [c, a, b] = bounds[i]!;
      if (b < -CULL) {
        i++;
        continue; // above viewport
      }
      if (a > H + CULL) break; // below viewport; rest are lower still
      if (b - a >= MIN_ROW) {
        drawNode(ctx, c, a, b, view, env, H);
        i++;
      } else {
        // fold a contiguous run of thin siblings into one aggregate strip
        let files = 0;
        let size = 0;
        let cnt = 0;
        const rStart = a;
        let end = b;
        let j = i;
        while (j < bounds.length && bounds[j]![2] - bounds[j]![1] < MIN_ROW) {
          files += bounds[j]![0].fileCount;
          size += bounds[j]![0].totalSize;
          cnt++;
          end = bounds[j]![2];
          j++;
        }
        drawAggStrip(ctx, rStart, end, t.depth + 1, cnt, files, size, env);
        i = j;
      }
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
    const textMode = lineH >= 8;
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

  // deepest node whose band contains world-y `wy`
  function nodeAt(t: TNode, wy: number, base: number): { y0: number; weight: number } {
    if (t.isDir) {
      let cy = base + 1;
      for (const c of t.children) {
        if (wy >= cy && wy < cy + c.weight) return nodeAt(c, wy, cy);
        cy += c.weight;
      }
    }
    return { y0: base, weight: t.weight };
  }

  return {
    title: "folder tree",
    extent: () => ({ min: 0, max: tree.weight }),
    draw,
    // double-click → center the clicked node and zoom so it fills the viewport
    focusAt: (screenY, view) => {
      const wy = screenToWorldY(view, screenY);
      if (wy < 0 || wy >= tree.weight) return null;
      const n = nodeAt(tree, wy, 0);
      return {
        center: n.y0 + n.weight / 2,
        zoom: (view.height / Math.max(1, n.weight)) * 0.9,
      };
    },
    hudLine: (view) => {
      // report the node whose self-row is under the viewport center
      const wy = screenToWorldY(view, view.height / 2);
      const path = locate(tree, wy);
      return path || null;
    },
    setOnUpdate(fn) {
      onUpdate = fn;
    },
  };

  // find the deepest node band containing world-y `wy`, as a path string
  function locate(t: TNode, wy: number, base = 0): string {
    if (wy < base || wy >= base + t.weight) return "";
    if (!t.isDir) return t.name;
    let cy = base + 1;
    for (const c of t.children) {
      if (wy < cy + c.weight) {
        const sub = locate(c, wy, cy);
        return sub ? `${t.name}/${sub}` : t.name;
      }
      cy += c.weight;
    }
    return t.name;
  }
}
