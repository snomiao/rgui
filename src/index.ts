/**
 * @snomiao/rgui — framework-agnostic readable-grid UI library.
 *
 * Everything snaps to a screen-adaptive readable grid; whatever the zoom,
 * elements are either drawn readable or replaced by a readable abstraction
 * (semantic-zoom LOD). Canvas 2D today, WebGPU behind the same interface later.
 *
 *   import rgui from "@snomiao/rgui";
 *   const viewer = rgui(canvas, { graph, rule: { collapsePx: 48 } });
 */
export { createRgui, type Rgui, type RguiOptions } from "./rgui.js";

// core — rg math & models (pure, framework-agnostic)
export {
  readableStep,
  gridLevels,
  finerStep,
  gridRange,
  snap,
  snapSizeRadix,
  sizeLayerStep,
  worldToScreen,
  screenToWorld,
  type ViewTransform,
  type GridLevel,
} from "./core/grid.js";
export { DEFAULT_RULE, resolveRule, type RgRule } from "./core/rule.js";
export {
  DARK_THEME,
  LIGHT_THEME,
  resolveTheme,
  themeRgb,
  withAlpha,
  type RgTheme,
  type RgThemeInput,
} from "./core/theme.js";
export { layoutGraph, type LayoutOptions } from "./core/layout.js";
export type {
  SummarizeFn,
  SummaryContent,
  SummaryInfo,
} from "./core/summary.js";
export {
  aggregate,
  fieldSummarize,
  defaultSummarize,
  ordered,
  quantile,
  topK,
  type MergeRule,
} from "./core/aggregate.js";
export {
  nodeHeight,
  bodyRect,
  inputPortPos,
  outputPortPos,
  demoGraph,
  NODE_HEADER_H,
  NODE_ROW_H,
  NODE_PAD,
  PORT_R,
  type Graph,
  type GraphNode,
  type Edge,
  type Port,
  type SignalKind,
  type NodeCategory,
} from "./core/graph.js";
export {
  buildRenderGraph,
  pseudoRect,
  pseudoPortPos,
  endpointPos,
  type RenderGraph,
  type PseudoNode,
  type RenderEdge,
  type EndpointRef,
} from "./core/lod.js";
export {
  resolveOverlap,
  flushSegments,
  flushPairKeys,
  flushComponents,
  sideCoverage,
  subtractIntervals,
  computePortLayout,
  portRowY,
  type FlushSegment,
  type Interval,
  type Side,
  type SideCoverage,
  type PortPlacement,
} from "./core/pack.js";

// renderers (Canvas 2D first impl)
export {
  createCanvas2DRenderer,
  createGridDotsLayer,
  gridDotsLayer,
  type DrawLayer,
  type FieldSource,
  type GridRenderer,
} from "./render/canvas2d.js";
export {
  drawGraph,
  drawOffscreenIndicators,
  offscreenIndicators,
  pinPos,
  KIND_COLOR,
  type OffscreenIndicator,
} from "./render/graphLayer.js";
export {
  createWebGPUGridRenderer,
  type WebGPUGridRenderer,
} from "./render/webgpu.js";
export {
  createOverlayManager,
  type NodeHtmlOverlay,
  type OverlayManager,
} from "./render/overlayLayer.js";
export {
  panelLayout,
  drawPanels,
  panelHitAt,
  PANEL,
  type Panel,
  type PanelItem,
  type PanelRect,
  type PanelHit,
} from "./render/panelLayer.js";

import { createRgui } from "./rgui.js";
export default createRgui;
