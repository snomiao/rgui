/**
 * rgui lane — pure helpers for folder-tree auto-fold.
 *
 * Design: TODO.md「folder tree の auto-fold — 動的空間の fold 規則」.
 * The fold ladder per directory, fine→coarse, chosen by the rg-merge rule
 * (finest representation whose cells stay ≥ 1rem on screen):
 *
 *   list → grid (rows = index chunks, columns = kind buckets, heat cells)
 *        → strip (too small for even one readable grid row)
 *
 * Everything here is pure geometry/classification — no I/O, no canvas —
 * so tree.ts can consume it from a single layout choke point and tests
 * can cover thresholds directly.
 */

// ── kind buckets (grid columns) ─────────────────────────────────────────

/** always-available column vocabulary — the tree analog of dayparts */
export type KindBucket = "dir" | "code" | "data" | "doc" | "media" | "other";

export const KIND_ORDER: readonly KindBucket[] = [
  "dir", "code", "data", "doc", "media", "other",
];

/** short column captions for the pseudo-x-axis (like SMTWTFS) */
export const KIND_LABEL: Record<KindBucket, string> = {
  dir: "dir",
  code: "code",
  data: "data",
  doc: "doc",
  media: "img",
  other: "·",
};

/** column base hues — identity rides on hue, magnitude on lightness */
export const KIND_COLOR: Record<KindBucket, string> = {
  dir: "#d69e2e",
  code: "#60a5fa",
  data: "#a3be8c",
  doc: "#8b949e",
  media: "#2dd4bf",
  other: "#5c6570",
};

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "pyi", "rb", "go", "rs",
  "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp", "cxx", "hxx", "cs",
  "swift", "sh", "bash", "zsh", "fish", "ps1", "bat", "php", "lua", "sql",
  "vue", "svelte", "astro", "scala", "clj", "ex", "exs", "erl", "hs", "ml",
  "fs", "dart", "r", "pl", "pm", "m", "mm", "asm", "s", "vim", "css",
  "scss", "less", "styl",
]);
const DATA_EXT = new Set([
  "json", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "csv",
  "tsv", "lock", "env", "properties", "xml", "proto", "graphql", "gql",
]);
const DOC_EXT = new Set([
  "md", "markdown", "txt", "rst", "adoc", "tex", "html", "htm", "log",
  "diff", "patch",
]);
const DOC_NAME = new Set([
  "license", "readme", "changelog", "todo", "authors", "makefile",
  "dockerfile",
]);
const MEDIA_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "mp4", "mov",
  "mp3", "wav", "ogg", "woff", "woff2", "ttf", "otf", "eot", "pdf",
]);

/** classify an entry into its grid column */
export function kindOf(name: string, isDir: boolean): KindBucket {
  if (isDir) return "dir";
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  if (DOC_NAME.has(lower) || DOC_NAME.has(lower.split(".")[0]!)) return "doc";
  if (CODE_EXT.has(ext)) return "code";
  if (DATA_EXT.has(ext)) return "data";
  if (DOC_EXT.has(ext)) return "doc";
  if (MEDIA_EXT.has(ext)) return "media";
  return "other";
}

/** per-kind entry counts for one grid row (immediate entries only —
 * subtree aggregates are async decoration, never layout inputs) */
export function kindCounts(
  entries: readonly { name: string; isDir: boolean }[],
): Record<KindBucket, number> {
  const out: Record<KindBucket, number> = {
    dir: 0, code: 0, data: 0, doc: 0, media: 0, other: 0,
  };
  for (const e of entries) out[kindOf(e.name, e.isDir)]++;
  return out;
}

// ── chunk rows (grid rows) ──────────────────────────────────────────────

// Schema folding uses complete directory listings only. Rendering recomputes
// per-cell presence/kind from live children, so this core returns columns only.
export interface SchemaMember {
  name: string;
  complete: boolean;
  children: readonly { name: string; isDir: boolean }[];
}

export interface SchemaColumn {
  name: string;
  support: number;
  votes: number;
}

export interface SchemaColumns {
  columns: readonly SchemaColumn[];
  memberCount: number;
}

export interface SchemaRegistryColumn extends SchemaColumn {
  ghost: boolean;
}

export interface SchemaRegistry {
  columns: readonly SchemaRegistryColumn[];
  memberCount: number;
}

export interface DetectSchemaOptions {
  maxColumns: number;
  minSupport: number;
  minMembers: number;
}

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const name of a) if (b.has(name)) intersection++;
  return intersection / (a.size + b.size - intersection);
};

/** Detect a deterministic Jaccard cluster and its supported child names. */
export function detectSchema(
  members: readonly SchemaMember[],
  options: DetectSchemaOptions,
): SchemaColumns | null {
  const minMembers = Math.max(1, Math.ceil(options.minMembers));
  const maxColumns = Math.max(0, Math.floor(options.maxColumns));
  const minSupport = Math.min(1, Math.max(0, options.minSupport));
  const complete = members
    .map((member, inputIndex) => ({
      member,
      inputIndex,
      names: new Set(member.children.map((child) => child.name)),
    }))
    .filter(({ member }) => member.complete);
  if (complete.length < minMembers || maxColumns === 0) return null;

  const links = complete.map(() => [] as number[]);
  const similarity = complete.map(() => complete.map(() => 0));
  for (let i = 0; i < complete.length; i++) {
    similarity[i]![i] = 1;
    for (let k = i + 1; k < complete.length; k++) {
      const score = jaccard(complete[i]!.names, complete[k]!.names);
      similarity[i]![k] = similarity[k]![i] = score;
      if (score >= minSupport) {
        links[i]!.push(k);
        links[k]!.push(i);
      }
    }
  }

  const seen = new Set<number>();
  const components: number[][] = [];
  for (let start = 0; start < complete.length; start++) {
    if (seen.has(start)) continue;
    const component: number[] = [];
    const pending = [start];
    seen.add(start);
    while (pending.length) {
      const at = pending.pop()!;
      component.push(at);
      for (const next of links[at]!) {
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(next);
      }
    }
    component.sort((a, b) => a - b);
    if (component.length >= minMembers) components.push(component);
  }
  if (!components.length) return null;

  const meanSimilarity = (component: readonly number[]): number => {
    if (component.length < 2) return 1;
    let total = 0;
    let pairs = 0;
    for (let i = 0; i < component.length; i++) {
      for (let k = i + 1; k < component.length; k++) {
        total += similarity[component[i]!]![component[k]!]!;
        pairs++;
      }
    }
    return total / pairs;
  };
  components.sort((a, b) =>
    b.length - a.length ||
    meanSimilarity(b) - meanSimilarity(a) ||
    complete[a[0]!]!.inputIndex - complete[b[0]!]!.inputIndex
  );
  const cluster = components[0]!;

  const stats = new Map<string, { votes: number; first: number }>();
  let ordinal = 0;
  for (const index of cluster) {
    for (const name of complete[index]!.names) {
      const stat = stats.get(name);
      if (stat) stat.votes++;
      else stats.set(name, { votes: 1, first: ordinal++ });
    }
  }
  const required = Math.ceil(minSupport * cluster.length);
  const columns = [...stats]
    .filter(([, stat]) => stat.votes >= required)
    .sort(([aName, a], [bName, b]) =>
      b.votes - a.votes || a.first - b.first || aName.localeCompare(bName)
    )
    .slice(0, maxColumns)
    .map(([name, stat]) => ({
      name,
      votes: stat.votes,
      support: stat.votes / cluster.length,
    }));
  return columns.length ? { columns, memberCount: cluster.length } : null;
}

/** Append-only column ordering for one consumer-owned epoch. */
export function updateSchemaRegistry(
  prev: SchemaRegistry | null,
  detected: SchemaColumns,
): SchemaRegistry {
  const latest = new Map(detected.columns.map((column) => [column.name, column]));
  const columns: SchemaRegistryColumn[] = [];
  const known = new Set<string>();
  for (const old of prev?.columns ?? []) {
    const current = latest.get(old.name);
    columns.push(current
      ? { ...current, ghost: false }
      : { ...old, support: 0, votes: 0, ghost: true });
    known.add(old.name);
  }
  for (const column of detected.columns) {
    if (!known.has(column.name)) columns.push({ ...column, ghost: false });
  }
  return { columns, memberCount: detected.memberCount };
}

/**
 * one grid row covering entries [start, end) — indices into the CHILD
 * ORDER, so every row maps to a contiguous world span (hit-test relies
 * on this; the analog of decimal decade rows).
 */
export interface ChunkRow {
  start: number;
  end: number;
  label: string;
}

/**
 * split `names` (in child order) into ≤ maxRows near-equal contiguous
 * chunks. A single-entry chunk is labeled by its full name; a multi-entry
 * chunk by its first name + "…" — a position hint into the (possibly
 * unsorted) child order, where an "a–c" range would read backwards.
 */
export function chunkRows(names: readonly string[], maxRows: number): ChunkRow[] {
  const n = names.length;
  if (n === 0 || maxRows < 1) return [];
  const rows = Math.min(maxRows, n);
  const out: ChunkRow[] = [];
  for (let r = 0; r < rows; r++) {
    const start = Math.floor((r * n) / rows);
    const end = Math.floor(((r + 1) * n) / rows);
    if (end <= start) continue;
    const label = end - start === 1 ? names[start]! : `${names[start]!}…`;
    out.push({ start, end, label });
  }
  return out;
}

// ── fold mode chooser (the ≥1rem rule) ─────────────────────────────────

export type TreeFoldMode =
  | { mode: "list" }
  | { mode: "grid"; rows: number }
  | { mode: "strip" };

/**
 * pick the finest readable representation for `childCount` entries in a
 * band of `bandPx` × `widthPx`. Each boundary has its own readability
 * unit so callers can apply hysteresis PER BOUNDARY (0.8×rem to stay in
 * the current mode, 1.25×rem to enter a finer one — list↔grid and
 * grid↔strip flap independently otherwise). `minShare` is the smallest
 * child's fraction of the band (defaults to equal shares): list mode
 * requires the SMALLEST child row readable, not the average.
 */
export function chooseTreeFold(
  childCount: number,
  bandPx: number,
  widthPx: number,
  listUnitPx: number,
  minShare = childCount > 0 ? 1 / childCount : 0,
  gridUnitPx = listUnitPx,
  gridBandPx = bandPx,
): TreeFoldMode {
  if (childCount <= 0) return { mode: "strip" };
  if (bandPx * minShare >= listUnitPx) return { mode: "list" };
  // grid rows are budgeted on the band grid mode will ACTUALLY get — the
  // caller subtracts any reserved chrome (caption header) up front, so a
  // later header can never shrink rows below what was approved here
  const rowsAvail = Math.floor(gridBandPx / gridUnitPx);
  if (rowsAvail >= 1 && widthPx >= KIND_ORDER.length * gridUnitPx) {
    return { mode: "grid", rows: Math.min(rowsAvail, childCount) };
  }
  return { mode: "strip" };
}

// ── interval shares (dynamic-space groundwork) ─────────────────────────

/**
 * quantized structural weight from a byte size — log2 KB buckets so tiny
 * size fluctuations never move layout (a bucket jump is a real change).
 * Unknown size → 1 (equal share), the no-false-precision default.
 */
export function bucketWeight(bytes: number | undefined): number {
  if (bytes == null || !(bytes > 0)) return 1;
  return 1 + Math.max(0, Math.round(Math.log2(bytes / 1024)));
}

/** normalize weights into interval shares summing to exactly 1 */
export function shareIntervals(weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  let total = 0;
  for (const w of weights) total += Math.max(0, w) || 0;
  if (total <= 0) return weights.map(() => 1 / weights.length);
  return weights.map((w) => (Math.max(0, w) || 0) / total);
}

// ── progressive content disclosure (indent / heading levels) ───────────

/**
 * structural level per line, for zoom-progressive disclosure: level-0 lines
 * surface first, deeper levels as space grows. Markdown uses its native
 * heading ladder (# → 0, ## → 1, …; body text never surfaces early).
 * Everything else uses indentation — the cheap universal proxy for
 * structure — with the indent unit inferred from the file itself.
 * Blank lines and non-heading md lines get NO_LEVEL.
 */
export const NO_LEVEL = 99;

const leadingWidth = (line: string): number => {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w += 1;
    else if (ch === "\t") w += 4;
    else break;
  }
  return w;
};

export function contentLevels(lines: readonly string[], isMarkdown: boolean): number[] {
  if (isMarkdown) {
    return lines.map((l) => {
      const m = /^(#{1,6})\s/.exec(l);
      return m ? m[1]!.length - 1 : NO_LEVEL;
    });
  }
  // infer the indent unit: smallest positive leading width, clamped sane
  let unit = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const w = leadingWidth(l);
    if (w > 0 && w < unit) unit = w;
  }
  if (!Number.isFinite(unit)) unit = 2;
  unit = Math.min(8, Math.max(2, unit));
  return lines.map((l) => {
    if (!l.trim()) return NO_LEVEL;
    return Math.min(NO_LEVEL - 1, Math.floor(leadingWidth(l) / unit));
  });
}

/**
 * deepest structural level whose lines still fit the label budget — the
 * ≥1rem rule turned inward: reveal level L+1 only once every line of
 * level ≤ L+1 in the window can afford a readable label.
 */
export function discloseLevel(
  levels: readonly number[],
  i0: number,
  i1: number,
  budget: number,
): number {
  const cum: number[] = [];
  for (let i = Math.max(0, i0); i <= Math.min(levels.length - 1, i1); i++) {
    const lv = levels[i]!;
    if (lv >= NO_LEVEL) continue;
    cum[lv] = (cum[lv] ?? 0) + 1;
  }
  let total = 0;
  let chosen = -1;
  for (let l = 0; l < cum.length; l++) {
    const c = cum[l] ?? 0;
    if (c === 0) continue;
    // a deeper level only unlocks if it still fits; the FIRST populated
    // level always shows (overlap declutter thins it when over budget)
    if (chosen >= 0 && total + c > budget) break;
    total += c;
    chosen = l;
    if (total > budget) break;
  }
  return chosen;
}

// ── OKLCH heat ramp (shared with the timeline ramp's shape) ────────────

const oklchCache = new Map<string, { L: number; C: number; H: number }>();

/** hand-rolled sRGB hex → OKLCH (cached; same math as timeline.ts) */
export function srgbToOklch(hex: string): { L: number; C: number; H: number } {
  let v = oklchCache.get(hex);
  if (v) return v;
  const n = parseInt(hex.slice(1), 16);
  const lin = (u: number) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
  const r = lin(((n >> 16) & 255) / 255);
  const g = lin(((n >> 8) & 255) / 255);
  const b = lin((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  v = { L, C: Math.hypot(a, bb), H: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
  oklchCache.set(hex, v);
  return v;
}

/**
 * heat-cell fill: base hue carries identity, an OKLCH lightness ramp on a
 * fixed log2 ladder (1,2,4,8,16+) carries magnitude — scrolling never
 * re-normalizes, and magnitude never rides on hue (CVD-safe).
 */
export function heatRampColor(baseHex: string, count: number, dark: boolean): string {
  const { C, H } = srgbToOklch(baseHex);
  const step = Math.min(4, Math.log2(1 + count));
  const L = dark ? 0.3 + 0.115 * step : 0.93 - 0.1 * step;
  const c = Math.min(0.11, C) * (0.55 + 0.11 * step);
  return `oklch(${L.toFixed(3)} ${c.toFixed(3)} ${H.toFixed(1)})`;
}
