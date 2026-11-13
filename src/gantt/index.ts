/**
 * @snomiao/rgui/gantt — the HEADLESS gantt core: data model, time scale (linear / log, zoom, pan, fit, today,
 * day / week presets), row layout (tree, folds, groups, stable slots, blank rows), the visible-window query,
 * hit-testing and drag-to-propose, and GanttController emitting frames. No DOM, no styling, zero runtime deps:
 * bring your own renderer. The default DOM + canvas renderer is `@snomiao/rgui/gantt/canvas`.
 */
export * from "./model";
export * from "./scale";
export * from "./core";
export * from "./layout";
export * from "./interact";
export * from "./source";
