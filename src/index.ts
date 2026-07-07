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
export { createRgui, type Rgui, type RguiOptions } from "./rgui";

// core — rg math & models (pure, framework-agnostic)
export {
  readableStep,
  gridLevels,
  finerStep,
  gridRange,
  snap,
  worldToScreen,
  screenToWorld,
  type ViewTransform,
  type GridLevel,
} from "./core/grid";
export { DEFAULT_RULE, resolveRule, type RgRule } from "./core/rule";
export {
  nodeHeight,
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
} from "./core/graph";
export {
  buildRenderGraph,
  pseudoRect,
  pseudoPortPos,
  endpointPos,
  type RenderGraph,
  type PseudoNode,
  type RenderEdge,
  type EndpointRef,
} from "./core/lod";

// renderers (Canvas 2D first impl)
export {
  createCanvas2DRenderer,
  createGridDotsLayer,
  gridDotsLayer,
  type DrawLayer,
  type GridRenderer,
} from "./render/canvas2d";
export { drawGraph, KIND_COLOR } from "./render/graphLayer";

import { createRgui } from "./rgui";
export default createRgui;
