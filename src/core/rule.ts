/**
 * rgui core — the rg-rule: every readability threshold in one customizable
 * object. Different use cases (dense DAW-style patching, sparse mind-maps,
 * dashboards…) tune these numbers; all rgui math takes a resolved RgRule.
 */

export interface RgRule {
  /** readable grid: minimum on-screen spacing of major grid points (px) */
  minGridPx: number;
  /** grid step ladder within a decade (must be ascending divisors of 10) */
  ladder: number[];
  /** a node collapses into a pseudo-node below this screen height (px) */
  collapsePx: number;
  /** hide node field text below this row height (px) */
  fieldMinPx: number;
  /** hide port labels below this row height (px) */
  portLabelMinPx: number;
  /** location-based cluster merge: screen-space gap budget (px) */
  clusterGapPx: number;
  /** wired nodes merge across a larger gap — their edge can be simplified */
  clusterGapConnectedPx: number;
  /** pseudo-node metrics in screen px (constant size on screen) */
  pseudo: { w: number; headerH: number; rowH: number; pad: number };
  /** min gap kept between decluttered pseudo-nodes (px) */
  declutterMarginPx: number;
  /**
   * snap-align magnet (px): when nodes snap flush, the cross axis aligns to
   * the readable start point (horizontal snap → tops; vertical snap → left
   * for LTR, right for RTL) if within this screen distance
   */
  alignSnapPx: number;
  /** reading direction — decides the vertical-snap alignment edge */
  direction: "ltr" | "rtl";
}

export const DEFAULT_RULE: RgRule = {
  minGridPx: 48,
  ladder: [1, 2, 5],
  collapsePx: 56,
  fieldMinPx: 9,
  portLabelMinPx: 6,
  clusterGapPx: 24,
  clusterGapConnectedPx: 40,
  pseudo: { w: 200, headerH: 26, rowH: 18, pad: 8 },
  declutterMarginPx: 10,
  alignSnapPx: 40,
  direction: "ltr",
};

/** Merge a partial rule over the defaults. */
export function resolveRule(rule?: Partial<RgRule>): RgRule {
  return {
    ...DEFAULT_RULE,
    ...rule,
    pseudo: { ...DEFAULT_RULE.pseudo, ...rule?.pseudo },
  };
}
