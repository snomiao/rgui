# @snomiao/rgui/gantt — feeding your own tasks (e.g. syform's roadmap)

```ts
import { GanttChart, GanttController, bindInput, toBars, LABELS_JA } from "@snomiao/rgui/gantt"; // or the release's gantt.js
import { roadmap, type RoadmapItem } from "./roadmap/data";
const STATUSES = { done: { color: "#2e7d32", label: "完了", closed: true }, partial: { color: "#f9a825", label: "一部" },
  not_started: { color: "#9e9e9e", label: "未着手" }, blocked: { color: "#c62828", label: "ブロック" }, unchecked: { color: "#6a1b9a", label: "未確認" } };
const bars = toBars(roadmap, (r: RoadmapItem) => ({ id: `/${r.category}/${r.id}`, name: r.title, group: r.category, start: r.start, end: r.end, status: r.status, detail: r.detail, deps: r.deps?.map((d) => `/${roadmap.find((x) => x.id === d)?.category}/${d}`) }), { statuses: STATUSES });
// A) the default look: rows + canvas, folds, pan, pinch/ctrl+wheel zoom, log axis, focus crosshair
new GanttChart(el, { labels: LABELS_JA, statuses: STATUSES, onOpen: (b) => showDetail(b.id), onFocus: (b) => {} }).setBars(bars);
// B) your own rendering: the controller keeps state + operations, bindInput adds the shared gestures, you draw frame()
const ctl = new GanttController({ statuses: STATUSES }); bindInput(box, ctl, { mode: "virtual" }); ctl.setViewport(w, h); ctl.setBars(bars);
ctl.on("view", draw); ctl.on("change", draw); function draw() { const f = ctl.frame(1); /* f.rows[i].y, .line (bar, depth, folded), .parts[{x,w,color}], f.ticks, f.nowX, f.crosshairY */ }
// undated items: a row, no bar. milestone: true → a diamond at end. ctl.toggle(lane, id) folds, ctl.open(bar) / ctl.setFocus(bar). See example-dom.ts (60 lines).
```
