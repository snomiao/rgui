/**
 * rgui core — themes. Every chrome color the renderers use lives in one
 * RgTheme object, so hosts can pass "dark" | "light" | any custom palette
 * (and swap live via viewer.setTheme). The built-in pair keeps the mascot
 * identity in both modes: field arrows stay purple (⊙ toward the viewer)
 * and gold (⊗ away) — the Royal Gramma crossover — tuned per background.
 *
 * Data colors (per-kind wire colors, node.bg overrides) are host data, not
 * theme chrome, and are unaffected.
 */

export interface RgTheme {
  /** canvas clear color (ignored when the host renders background: false) */
  background: string;
  /** field arrows pointing at the viewer — ⊙, the mascot purple */
  arrowToward: string;
  /** field arrows pointing into the screen — ⊗, the mascot gold */
  arrowAway: string;
  /** outline ink: node borders, port strokes, solder joints, indicators */
  ink: string;
  /** default node body fill (node.bg overrides per node) */
  nodeBg: string;
  /** chip painted behind edge labels so wire text reads over anything */
  labelBg: string;
  /** drop shadow under screen-constant pseudo-nodes */
  shadow: string;
  /** primary text (field values, node titles) */
  text: string;
  /** secondary text (summary lines, panel titles) */
  textDim: string;
  /** muted text (field keys, unpinned glyphs) */
  textMuted: string;
  /** faintest text (hints, empty states) */
  textFaint: string;
  /** highlight: selection box, hover borders, pinned stars */
  accent: string;
  /** invalid state (e.g. incompatible connection target) */
  danger: string;
  /** merged pseudo-node header fill */
  pseudoHeader: string;
  /** panel chrome */
  panelBg: string;
  panelBorder: string;
  panelHeaderBg: string;
}

export const DARK_THEME: RgTheme = {
  background: "#1c2126",
  arrowToward: "#b25ce0",
  arrowAway: "#ffd60a",
  ink: "#14161a",
  nodeBg: "#2b3036",
  labelBg: "rgba(28, 33, 38, 0.85)",
  shadow: "rgba(20, 22, 26, 0.6)",
  text: "#e6e9ec",
  textDim: "#aeb6bf",
  textMuted: "#8b949e",
  textFaint: "#5c6570",
  accent: "#ffd60a",
  danger: "#e5534b",
  pseudoHeader: "#8a72c9",
  panelBg: "rgba(34, 39, 46, 0.94)",
  panelBorder: "#3a4048",
  panelHeaderBg: "rgba(20, 22, 26, 0.9)",
};

/**
 * Light mode: warm paper (suits the gold half of the mascot pair); the
 * purple/gold arrows deepen so they keep contrast on a bright field.
 */
export const LIGHT_THEME: RgTheme = {
  background: "#f3f1ea",
  arrowToward: "#8a2fc8",
  arrowAway: "#c28a0a",
  ink: "#8f8878",
  nodeBg: "#ffffff",
  labelBg: "rgba(255, 255, 255, 0.85)",
  shadow: "rgba(60, 55, 40, 0.25)",
  text: "#22262b",
  textDim: "#4c545c",
  textMuted: "#69737d",
  textFaint: "#98a1aa",
  accent: "#c8860a",
  danger: "#d1372c",
  pseudoHeader: "#7a5fc0",
  panelBg: "rgba(252, 251, 247, 0.94)",
  panelBorder: "#cfc9bc",
  panelHeaderBg: "rgba(240, 237, 229, 0.9)",
};

/**
 * Theme input: a built-in name, or a partial palette over a base
 * ({ base: "light", accent: "#e91e63" } — omitted base = dark).
 */
export type RgThemeInput =
  | "dark"
  | "light"
  | (Partial<RgTheme> & { base?: "dark" | "light" });

/** Resolve input to a fresh mutable RgTheme (safe to Object.assign later). */
export function resolveTheme(input?: RgThemeInput): RgTheme {
  if (input === "light") return { ...LIGHT_THEME };
  if (input === "dark" || input === undefined) return { ...DARK_THEME };
  const { base, ...rest } = input;
  return { ...(base === "light" ? LIGHT_THEME : DARK_THEME), ...rest };
}

/** Parse "#rgb" / "#rrggbb" / "rgb(a)(…)" into [r, g, b] 0–255. */
export function themeRgb(color: string): [number, number, number] {
  const c = color.trim();
  if (c.startsWith("#")) {
    const h = c.slice(1);
    const full =
      h.length === 3 ? h.split("").map((d) => d + d).join("") : h.slice(0, 6);
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return [255, 255, 255];
}

/** color with an explicit alpha, e.g. withAlpha(theme.accent, 0.08) */
export function withAlpha(color: string, alpha: number): string {
  const [r, g, b] = themeRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
