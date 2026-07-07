/**
 * rgui core — summarize rule types.
 *
 * The host knows what a node MEANS, so it can summarize better than rgui:
 * when a node is too small to show its fields (level "small"), or when
 * nodes merge into a pseudo-node (level "pseudo"), rgui asks the host's
 * summarize rule for compact content and renders it screen-constant.
 */
import type { GraphNode } from "./graph.js";

export type SummaryContent =
  | { kind: "text"; lines: string[] }
  | { kind: "kv"; rows: [string, string][] }
  | {
      kind: "canvas";
      /** screen-space, clipped; origin at the summary region's top-left */
      draw: (
        ctx: CanvasRenderingContext2D,
        rect: { width: number; height: number },
      ) => void;
      /** region height in px (default 36) */
      height?: number;
    };

export interface SummaryInfo {
  /** true when summarizing a collapsed pseudo-node's members */
  collapsed: boolean;
  /** "small": single node below field readability; "pseudo": merged group */
  level: "small" | "pseudo";
  /** available screen size of the target region (px) */
  screen: { w: number; h: number };
}

/** return null/undefined to fall back to rgui's default rendering */
export type SummarizeFn = (
  nodes: GraphNode[],
  info: SummaryInfo,
) => SummaryContent | null | undefined;

export const SUMMARY_LINE_H = 14;

/** height (px) a summary renders at — pure, canvas-free */
export function summaryContentHeight(c: SummaryContent): number {
  if (c.kind === "text") return Math.min(c.lines.length, 4) * SUMMARY_LINE_H;
  if (c.kind === "kv") return Math.min(c.rows.length, 4) * SUMMARY_LINE_H;
  return c.height ?? 36;
}
