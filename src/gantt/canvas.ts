/**
 * @snomiao/rgui/gantt/canvas — the default renderer on the headless core: GanttChart (native scroll, sticky DOM
 * names, one canvas for bars), bindInput (the shared pan / pinch / ctrl+wheel gestures for any element), and
 * plainGantt (a small plain-DOM renderer example). Re-exports the whole core, so `@snomiao/rgui/gantt/canvas` alone
 * is enough for current GanttChart users.
 */
export * from "./index";
export * from "./native";
export * from "./input";
export { plainGantt } from "./example-dom";
