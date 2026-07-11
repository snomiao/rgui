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
  snapNodeSize,
  sizeStepFor,
  sizeStepsFor,
  sizeLawDepth,
  type SizeLaw,
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
  ADDITIVE_RULES,
  DEFAULT_SIGNAL,
  SIGNALS,
  allowedMerges,
  checkSignals,
  defaultMerge,
  fanoutGroup,
  fanoutKey,
  forkValue,
  groupFanout,
  groupWeights,
  isAliasable,
  isConserved,
  isCostlyToCopy,
  isDuplicable,
  isFanoutLegal,
  isMergeLegal,
  lineAtomizer,
  normalizeWeights,
  port,
  portMerge,
  resolveSignal,
  routeIndex,
  signalConnectionGuard,
  splitAtoms,
  splitLines,
  splitQuantity,
  type Atomizer,
  type Fanout,
  type Grain,
  type Measure,
  type Ownership,
  type SignalDiagnostic,
  type SignalSeverity,
  type SignalSpec,
} from "./core/signal.js";
export {
  nodeHeight,
  nodeMinHeight,
  nodeMinWidth,
  nodeMetrics,
  nodeRowY,
  nodeRows,
  nodeScale,
  annotationNode,
  contentScale,
  bodyRect,
  inputPortPos,
  outputPortPos,
  childrenOf,
  descendantsOf,
  containerIds,
  containmentOf,
  demoGraph,
  orgChartGraph,
  signalGraph,
  NODE_HEADER_H,
  NODE_ROW_H,
  NODE_PAD,
  NODE_COL_W,
  NODE_MIN_W,
  PORT_R,
  flowAxis,
  inSide,
  outSide,
  oppositeSide,
  isHorizontalSide,
  portPos,
  sidePortPos,
  type Graph,
  type GraphNode,
  type Edge,
  type Flow,
  type Port,
  type Side,
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
  snapConnections,
  type ConnectGate,
  type FlushSegment,
  type Interval,
  type SnapConnectOptions,
  type SideCoverage,
  type PortPlacement,
} from "./core/pack.js";
export {
  gripBase,
  gripRescale,
  gripResize,
  MIN_SCALE,
  MAX_SCALE,
  type GripBase,
  type GripSize,
} from "./core/grip.js";
export {
  FEDERATED_GRAPH_KIND,
  FEDERATED_GRAPH_SCHEMA,
  FEDERATED_DEMO_CHAIN_IDS,
  clampFederatedGraph,
  federatedDemoChain,
  federatedDemoChainGraph,
  federatedGraphToRgui,
  federatedEmbedUrl,
  federatedNodeId,
  federatedOriginOf,
  federatedTerminalPreview,
  isFederatedGraphEnvelope,
  type FederatedEdge,
  type FederatedGraphEnvelope,
  type FederatedNode,
  type FederatedPort,
  type FederatedProducer,
  type FederationClampOptions,
} from "./core/federation.js";
export {
  terminalPreviewDraw,
  TERMINAL_STATUS_COLOR,
  type TerminalPreview,
} from "./render/terminalPreview.js";
export {
  newGraphCrdt,
  crdtAddNode,
  crdtSetFields,
  crdtRemoveNode,
  crdtAddEdge,
  crdtRemoveEdge,
  crdtEdgeId,
  mergeGraphCrdt,
  crdtToGraph,
  type Clock,
  type CrdtEdgeEnd,
  type CrdtGraph,
  type CrdtRegister,
  type CrdtValue,
  type Dot,
  type GraphCrdtState,
  type JoinRule,
} from "./core/crdt.js";

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
  CATEGORY_COLOR,
  kindColor,
  categoryColor,
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
  panelSnap,
  panelCoverage,
  PANEL,
  type Panel,
  type PanelItem,
  type PanelRect,
  type PanelHit,
} from "./render/panelLayer.js";

import { createRgui } from "./rgui.js";
export default createRgui;
