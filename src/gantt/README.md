# @snomiao/rgui/gantt — a headless gantt core

`@snomiao/rgui/gantt` is the gantt's state, layout, time scale and interaction model with **no DOM, no styling and
zero runtime dependencies**. You bring the renderer (plain DOM, canvas, React, Lit, a terminal…). The default
renderer (DOM rows + one canvas, native scroll, sticky names) is on its own subpath, `@snomiao/rgui/gantt/canvas`.

| entry | what |
| --- | --- |
| `@snomiao/rgui/gantt` | headless core: `model`, `scale`, `core` (`GanttController`), `layout`, `interact`, `source` |
| `@snomiao/rgui/gantt/canvas` | `GanttChart` (default renderer), `bindInput` (shared gestures), `plainGantt` (example), and the whole core re-exported |
| `…/gantt/src`, `…/gantt/canvas/src` | the TypeScript sources (git installs without `dist/`) |

Times are epoch **seconds**. `tzOffset` is seconds east of UTC (default 32400 = JST; `localTzOffset()` gives the
runtime's zone).

## API

- **Data model** (`model.ts`, `source.ts`): `GanttBar` (start `a`, promised end `due`, actual end `b`, planned
  ranges `loA`/`lo`, first plan `a0`/`due0`, `wait`, `progress`, estimate `ticks`, `crit`), `stateOf`, `segmentsOf`
  (range / core / late parts), `paceOf`, `treeOrder`, `categorize`, `groupRows`. `toBars(items, map, { statuses })`
  maps any source (optional dates → undated rows, `group`, `status`, `milestone`, `deps`, `progress`). A status is
  `{ color, label, mark?, closed? }`; `mark` is a non-colour sign (✓ ▶ ■ ○) for renderers that must not rely on colour.
- **Time scale** (`model.ts`, `scale.ts`): `GanttView {t0, spp}`, `toX`/`toT`, `zoomAt`, `panBy`, `fitView`,
  `tickStep`/`ticks`/`tickLabel`; calendar presets `presetView("day" | "week", from, colPx)` and
  `columns(view, x0, x1, preset, now)` (day/week columns with `today` and `weekend`), `dayStart`, `weekStart`,
  `parseDay("YYYY-MM-DD")`.
- **Controller** (`core.ts`): `new GanttController(opts)` owns data, rows and view.
  - data: `setBars(rows)`, `setMilestones([{ id, t, name?, status? }])`, `setDesires({ "<lane> <id>": desire })`
  - rows: one tree by id across groups, folds (`toggle(lane, id)`, remembered through `storage`), categories,
    `indexOf(id)`, `arrange` hook (reorder / pad rows after each layout), `{ blank: true }` rows, `dy(i)` per-row
    y offset (animations)
  - view: linear or symmetric log axis (`setLog`), `setViewport(w, h)`, `scrollTo`, `panBy`, `zoomAt(x, k)`, `fit()`,
    `today()`, `setView`, endless axis; `x(t)`/`t(x)` (viewport px), `cx`/`ct` (content px), `timeSpan()`
  - focus / selection: crosshair focus (row under the viewport middle, with snap), `focusAt(y)` (hover),
    `setFocus(bar)`, `setFocusKey(key)`, `open(bar)`
  - hit-testing: `rowAt(y)`, `hitTest(x, y)` → `{ index, line, bar, t, x0, x1, part: "start" | "end" | "body" | "none" }`
  - drawing: `frame(overscan)` → `{ rows: [{ y, line, parts[{x,w,color,state,part,k}], progress, milestoneX, ghost,
    status, desire }], ticks, nowX, crosshairY, focusIndex, milestones }`, all in viewport px; `visibleRows()`,
    `axis()`
  - events: `on("change" | "view" | "open" | "focus", fn)` → unsubscribe
- **Layout** (`layout.ts`): `stableSlots()` (an `arrange` hook: rows that stay keep their slot, leavers leave blanks,
  newcomers fill their own group's blanks, the rest are appended), the in-view filter `timeWindow(view, margin)` /
  `windowStale(win, view)` / `inWindow(bars, win, now, keep)`, `nearestOutside(...)` (infinite scroll),
  `rowTops` + `rowShift` (FLIP offsets for `dy`).
- **Interaction** (`interact.ts`): `hitPart`, drag-to-propose `startDrag(hit, prevDesire)` → `dragTo(drag, dx, ctl)`
  → `toDesire(drag)`; `desireAnswered(desire, bar)` (the task was re-planned); `cursorOf(part)`.

## Bring your own renderer: plain DOM

```ts
import { GanttController, toBars } from "@snomiao/rgui/gantt";

const box = document.getElementById("gantt")!; // position:relative; overflow:hidden
const ctl = new GanttController({ crosshair: false, storage: null });
ctl.setViewport(box.clientWidth, box.clientHeight);
ctl.setBars(toBars(items, (r) => ({ id: r.id, name: r.title, group: r.team, start: r.start, end: r.end })));

const div = (css: string, text = "") =>
  Object.assign(document.createElement("div"), { textContent: text, style: `position:absolute;${css}` });
function draw() {
  const f = ctl.frame(1);
  box.replaceChildren(
    ...f.rows.flatMap((r) => [
      div(
        `top:${r.y}px;left:${(r.line.depth ?? 0) * 12}px`,
        r.line.blank ? "" : (r.line.lane ?? `${r.status?.mark ?? ""} ${r.line.bar!.name}`),
      ),
      ...r.parts.map((p) =>
        div(`top:${r.y + 4}px;left:${p.x}px;width:${p.w}px;height:${f.rowHeight - 8}px;background:${p.color}`),
      ),
    ]),
    div(`left:${f.nowX}px;top:0;bottom:0;width:1px;background:red`),
  );
}
ctl.on("change", draw);
ctl.on("view", draw);
box.onwheel = (e) => {
  e.preventDefault();
  if (e.ctrlKey) ctl.zoomAt(e.offsetX, Math.exp(-e.deltaY / 200));
  else ctl.panBy(e.deltaX, e.deltaY);
};
box.onpointermove = (e) => ctl.focusAt(e.offsetY); // hover focus
draw();
```

`bindInput(box, ctl, { mode: "virtual" })` from `@snomiao/rgui/gantt/canvas` adds the full gesture set (2D touch
pan with momentum, pinch, Safari gestures); `src/gantt/example-dom.ts` is a complete 50-line version.

## Bring your own renderer: canvas

```ts
import { GanttController, dragTo, startDrag, toDesire, type GanttDrag } from "@snomiao/rgui/gantt";

const cv = document.querySelector("canvas")!,
  g = cv.getContext("2d")!;
const ctl = new GanttController();
ctl.setViewport(cv.width, cv.height);
ctl.setBars(bars);
function draw() {
  const f = ctl.frame();
  g.clearRect(0, 0, f.width, f.height);
  for (const r of f.rows) {
    for (const p of r.parts) {
      g.globalAlpha = p.part === "range" ? 0.15 : 0.4;
      g.fillStyle = p.color;
      g.fillRect(p.x, r.y + 3, p.w, f.rowHeight - 6);
    }
    g.globalAlpha = 1;
    if (r.desire) g.strokeRect(r.desire.x, r.y + 3, r.desire.w, f.rowHeight - 6); // a proposed slot
  }
  g.fillStyle = "red";
  g.fillRect(f.nowX, 0, 1, f.height);
  for (const m of f.milestones) g.fillRect(m.x, 0, 1, f.height);
}
ctl.on("change", draw);
ctl.on("view", draw);

// drag-to-propose: dragging a bar proposes a desired slot instead of moving the task
let drag: GanttDrag | undefined,
  x0 = 0;
cv.onpointerdown = (e) => {
  const h = ctl.hitTest(e.offsetX, e.offsetY);
  drag = h?.bar && startDrag(h, ctl.desires[`${h.bar.lane} ${h.bar.id}`]);
  x0 = e.offsetX;
};
cv.onpointermove = (e) => {
  if (drag) (drag = dragTo(drag, e.offsetX - x0, ctl)), draw();
};
cv.onpointerup = () => {
  if (drag?.moved) ctl.setDesires({ ...ctl.desires, [drag.key]: toDesire(drag) }); // and send it to the owner
  drag = undefined;
};
```

## Stable rows for a filtered view

```ts
import { inWindow, stableSlots, timeWindow, windowStale, type GanttWindow } from "@snomiao/rgui/gantt";

const slots = stableSlots(() => filterOn);
ctl.arrange = slots.arrange; // rows keep their slot when the shown set changes; gaps are { blank: true } rows
let win: GanttWindow | null = null;
ctl.on("view", () => {
  if (!windowStale(win, ctl.timeSpan())) return; // a sideways pan inside the window rebuilds nothing
  win = timeWindow(ctl.timeSpan(), 1);
  ctl.setBars(inWindow(all, win, Date.now() / 1000, ctl.focus)); // the focused task always stays
});
```

## The default renderer

```ts
import { GanttChart, LABELS_JA } from "@snomiao/rgui/gantt/canvas";

const chart = new GanttChart(el, { labels: LABELS_JA, statuses, onOpen: (b) => showDetail(b.id) });
chart.setBars(bars);
chart.controller.setMilestones([{ id: "v1", t: releaseAt, name: "v1" }]);
```

## Migrating from 0.3.0-tk.* (the takusym fork)

- `GanttChart`, `bindInput`, `LABELS_*` and `plainGantt` moved from `@snomiao/rgui/gantt` to
  `@snomiao/rgui/gantt/canvas`, which re-exports the core too: change one import line.
- The vendored patches are API now: `controller.arrange` (also an option), `controller.dy`, `{ blank: true }` lines
  (drawn as `.rg-r.rg-blank`). `GanttChart.rows`, `.inner`, `.draw()` and `controller.setFocusKey`, `.cx`, `.ct`,
  `.fitted` are public.
- Folds and focus persist through `storage` (default `localStorage` when present; `null` turns it off).
