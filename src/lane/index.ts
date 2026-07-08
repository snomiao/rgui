/**
 * rgui lane — 1-D "limited-visual-width" semantic-zoom renderer.
 *
 * A sibling to the infinite canvas (src/rgui.ts): here the RG flow runs along
 * a SINGLE axis. The flow axis (vertical) zooms and reveals detail; the width
 * axis is pinned to the viewport. Ideal for inherently 1-D data — folder trees
 * and time series — where zooming in should mean "more detail", not "bigger".
 */
export {
  type LaneView,
  worldToScreenY,
  screenToWorldY,
  visibleSpan,
  zoomAt,
  clampScroll,
  lodStep,
} from "./view.js";
export {
  createLane,
  type Lane,
  type LaneOptions,
  type LaneSource,
  type LaneEnv,
} from "./lane.js";
export { createTreeSource, type FileNode } from "./tree.js";
export { createSeriesSource, type SeriesOptions } from "./timeseries.js";
export { createTimelineSource, type TimelineSource } from "./timeline.js";
