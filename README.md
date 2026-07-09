# @snomiao/rgui

<img src="assets/rgui-icon-64-wander.gif" width="64" height="64" align="right" alt="rgui mascot — a wandering Royal Gramma as a 4-color dithered field">

**rgui** = the **R**enormalization **G**roup **U**ser **I**nterface — that is the name's
original purpose. (That the same letters also read as *readable grid* and *Royal Gramma*,
our mascot, is a happy accident we keep for fun.)

In physics, the renormalization group describes how a system looks at different scales:
zoom out, and microscopic detail is *coarse-grained* away — only the couplings that matter
at that scale survive. rgui applies exactly this to user interfaces. **Zoom is an RG flow**:
every element snaps to a screen-adaptive grid and stays legible at any zoom level, and whatever
cannot be drawn readably is not dropped but *replaced by a readable abstraction* via
semantic-zoom level-of-detail (LOD). Ships a Canvas 2D renderer today, with a WebGPU renderer
behind the same interface next. The only runtime dependencies are `d3-zoom` and `d3-selection`.

---

## What is rgui?

rgui is a framework-agnostic library that carries one principle through the whole UI:
the **readable grid**. The principle reduces to two rules.

1. **Every element snaps to a screen-adaptive, radix-layered grid.** Grid scales are powers
   of a configurable radix (default 8): one higher-order cell spans radix sub-steps per axis.
   The major spacing is continuously re-chosen so it always keeps a readable pixel width, and
   **sizes obey the node-size law**: a node spans an integer 1..radix grids at *some* layer —
   needing more promotes it to the next layer, snapped up (9 grids at layer *s* → 2 grids at
   layer *s+1*). Positions snap to the finer of the visible grid and the node's own layer.
2. **The view is readable at every zoom — because zoom is a renormalization-group flow.**
   The moment an element can no longer be drawn readably at the current scale, it does not
   vanish; it is replaced by a readable abstraction. This is semantic-zoom LOD: just before
   detail would smear, nodes collapse into pseudo-nodes, and nearby elements coarse-grain into
   a single cluster based on position. Nothing unreadable is ever left on screen — only the
   relevant couplings survive at each scale.

Rendering is currently Canvas 2D, but the renderer is swappable behind a single interface,
with a WebGPU implementation planned next. It mounts on any `<canvas>` and exposes the same
API to React, Vue, Svelte, or plain DOM.

## Install

```bash
bun add @snomiao/rgui
# or
npm install @snomiao/rgui
```

`d3-zoom` / `d3-selection` are pulled in automatically as dependencies. The package is pure
ESM; use it from a bundler (Vite, webpack, esbuild, …) or Node.js ESM.

## Quick start

```ts
import rgui, { demoGraph, type Graph } from "@snomiao/rgui";

const canvas = document.querySelector<HTMLCanvasElement>("#viewer")!;

// Build a dataflow graph in world coordinates, or use demoGraph() to start.
const graph: Graph = {
  nodes: [
    {
      id: "src",
      title: "Camera",
      category: "source",
      x: -256, y: -64, w: 256, h: 128, // on the radix-8 lattice (64 wu at k=1)
      inputs: [],
      outputs: [{ id: "image", label: "image", kind: "image" }],
      fields: [["device", "Default camera"]],
      fieldRules: { device: "set" }, // how this field MERGES when renormalized
    },
    {
      id: "sink",
      title: "Vision model",
      category: "model",
      x: 64, y: -64, w: 256, h: 128,
      inputs: [{ id: "image", label: "image", kind: "image" }],
      outputs: [{ id: "labels", label: "labels", kind: "text" }],
      fields: [["model", "YOLOS-tiny"]],
    },
  ],
  edges: [
    { from: { node: "src", port: "image" }, to: { node: "sink", port: "image" } },
  ],
};

// Mount a readable-grid viewer on the canvas.
const viewer = rgui(canvas, {
  graph,                        // or demoGraph() for a ready-made pipeline
  rule: { collapsePx: 48 },     // tune the readability thresholds (see below)
});

// Pan/zoom (d3-zoom), grid-snapped node dragging, and semantic-zoom LOD
// are all wired up automatically. Clean up when done:
viewer.destroy();
```

The `Rgui` object returned by `rgui(canvas, options)` carries the current view transform
`view`, the resolved rule set `rule`, read/write access to `graph`, a redraw request
`invalidate()`, and `destroy()`. `demoGraph()` returns a ready-made pipeline for smoke
testing — pass it first to see the behavior.

## Keyboard navigation

Enabled by default (`keyboard: false` to opt out). The pan/zoom feel is the
[CapsLockX](https://github.com/snomiao/CapsLockX) time-based acceleration model — a tap
nudges, a hold ramps up — ported from its Rust source of truth (`core/accModel.ts`).
Keys act only while the pointer is over the canvas, and never while typing in a field.

| Keys | Action |
| --- | --- |
| `W` `A` `S` `D` | Pan (hold to accelerate) |
| `R` / `F` | Zoom in / out (about viewport center) |
| `N` / `P` — or `Tab` / `⇧Tab` | Focus next / previous node (selects + pans it to center) |
| `Space` + drag | Pan |
| `?` | Toggle the shortcuts panel |

Tune the acceleration with `keyboardSpeed: { pan?, zoom? }` (units per first-second of
hold; defaults 1600 / 1600, matching CapsLockX).

## RgRule — customizing the readability thresholds

Every readability decision in rgui is concentrated in a single `RgRule` object. Tune these
numbers per use case (dense DAW-style patching, sparse mind maps, dashboards, …). Pass a
partial object as `options.rule`; unspecified fields fall back to the defaults.

| Property | Default | Meaning |
| --- | --- | --- |
| `minGridPx` | `48` | Minimum on-screen spacing of major grid points (px). The basis of the readable grid. |
| `radix` | `8` | Grid layers are radixⁿ; one higher-order cell spans radix sub-steps per axis. 4/5/8/10/16… |
| `collapsePx` | `56` | A node collapses into a pseudo-node when its screen height falls below this (px). |
| `collapseSnappedPx` | `84` | Members of a flush-snapped stack collapse earlier (snap beats location) — and the whole stack RGs together. |
| `fieldMinPx` | `9` | Hide a node's field text when the row height falls below this (px). |
| `portLabelMinPx` | `6` | Hide port labels when the row height falls below this (px). |
| `clusterGapPx` | `24` | Screen-space gap budget for position-based cluster merging (px). |
| `clusterGapConnectedPx` | `40` | Connected nodes merge across a larger gap (px). |
| `pseudo` | `{ w: 200, headerH: 26, rowH: 18, pad: 8 }` | Pseudo-node screen dimensions in px (constant size on screen). |
| `declutterMarginPx` | `10` | Minimum gap kept between pseudo-nodes after decluttering (px). |
| `alignSnapPx` | `40` | Snap-align magnet: flush-snapping nodes align at the readable start point (tops / reading edge). |
| `direction` | `"ltr"` | Reading direction — decides the vertical-snap alignment edge. |
| `portShape` | `"chevron"` | Ports read the data flow (inputs point in, outputs out); `"dot"` restores circles. |

`DEFAULT_RULE` and `resolveRule(partial)` are exported so you can inspect the defaults or
resolve partial rules independently.

## The rules of the canvas

Everything above zoom is governed by a small set of composable laws:

- **One cell, one thing (一格一物)** — rendered overlap is never allowed: a dragged (or
  projected) node that would cover another pushes out to flush contact instead.
- **Boundary dissolution (辺界消融)** — flush-contact edges fuse: the shared border, the
  internal ports, and the wire between touching nodes dissolve; the connection condenses
  into a flow chevron on the seam. Snapped nodes stay independent — drag one away to split.
- **Snap-connect (吸附成线)** — contact IS the connection. Each node declares the direction
  data runs through it (`flow`: `"ltr"` default, `"rtl"`, `"ttb"`, `"btt"`), which decides
  the edge its inputs sit on and the edge its outputs sit on. Push two nodes flush so that an
  output edge faces a compatible input edge — matching `SignalKind`, port rows aligned within
  half a pitch — and a wire appears, marked `temp: true`. Drag them apart and it is gone: no
  state is kept, the wires are a pure function of geometry (`snapConnections()`), so *cutting*
  a connection costs one drag rather than a click on a 2-px curve. Direction always comes from
  the ports, never from the geometry: an `rtl` pipeline snapped left-to-right still flows
  right-to-left. Authored edges win — a temp wire never steals an input the host already fed.
  Opt out with `snapConnect: false`; mirror the derived set via `onSnapConnectChange`.
- **Snap beats location; stacks RG together** — a fused stack collapses earlier than loose
  neighbors, and as one unit: when any member crosses the threshold, the whole stack becomes
  one block, sized as its members' enclosure (and itself an integer-grid citizen).
- **Chain contraction** — interior nodes of a linear chain (in/out degree 1) contract into a
  compact `⋯ ×N` link while the endpoints stay, regardless of distance.
- **Cascading RG** — if a merged block ends up overlapping anything, they merge too; the
  build runs to a fixed point. Overlap cannot survive a frame.
- **Data merges with structure** — field values aggregate under per-field rules (`max`,
  `min`, `sum`, `mean`, `median`, `range`, `mode` 众数, `set` 集合, `same`, `any`/`all`,
  `first`/`last`/`count`, or custom), declared on the node via `fieldRules`, on the host via
  `fieldSummarize()`, or defaulting to mode. Booleans are ordered — OR ≡ max, AND ≡ min.
  Advanced combinators: `ordered()` (severity/latest), `topK()` (histogram), `quantile()`.
- **Containment scopes the emergence** — `GraphNode.parent` declares that a node lives
  INSIDE another (a structural relation like an edge, never a style tag). The container
  renders as an open frame around its children — the sanctioned exception to one-cell-one-
  thing: a child occupies its container's cell at a finer grid layer. Emergent merging works
  only *within* a scope (a team's members merge into the team, never into the neighboring
  team), and once every child falls below readability the container **absorbs** them into
  one block named by the container. Levels absorb one at a time — teams collapse into team
  blocks long before the company collapses into one company block — so an org chart's
  leader/members/team/company hierarchy IS its RG-level ladder. Dragging a frame carries
  its contents; `orgChartGraph()` demos the whole ladder.
- **Any domain renders** — `SignalKind` and `NodeCategory` are open string types: built-ins
  keep their hand-picked palette, any other name (`"report"`, `"team"`, …) gets a stable
  derived color via `kindColor()`/`categoryColor()` — or assign into `KIND_COLOR`/
  `CATEGORY_COLOR` to pick exact colors. Media pipelines, org charts, dependency graphs —
  no registration required.
- **Selection is RG-level aware** — blocks containing selected members render selected;
  zooming out and back restores the exact original multi-selection; modifying selection at
  a higher level acts on the whole block. Double-click selects a snapped stack.
- **3-D billboard position space** — `viewer.setRotation3({yaw, pitch, roll})` rotates node
  *positions* in 3-D (plus `GraphNode.z` depth) while every node renders as an upright 2-D
  card; the view stays strictly 2-D and all the laws above keep holding. The background
  field arrows lean with the rotation (180° shows the field pointing away: gold crosses).
- **A wire says what it carries** — a port declares whether its signal *adds*
  (`measure: "extensive" | "intensive"`) and whether it may be *duplicated*
  (`fanout: "copy" | "split" | "route"`). Those are independent: an STT transcript is
  additive yet broadcasts (a fact), a coin transfer is additive yet must not be copied
  (a resource). rgui refuses `sum` on a state, and draws the three fan-outs as three
  different wires — full, thinned-and-badged `1/n`, dotted. See
  [docs/signal.md](docs/signal.md) and `signalGraph()`.

## The signal algebra

|  | `fanout: "copy"` | `fanout: "split"` / `"route"` |
|---|---|---|
| **extensive** (`sum`/`concat` legal) | STT transcript segments, audio chunks, shard counters | token budget, money, work items |
| **intensive** (`sum` forbidden) | coordinates, image frames, vision label sets | an exclusive lease, a GPU slot |

The tempting model is one axis — *change vs state* — but a cumulative counter is
additive across shards yet must be **copied** on fan-out, and a coin transfer is
additive yet must **never** be copied. Additivity and conservation are orthogonal
(physics agrees: entropy is extensive and not conserved). So rgui declares them
separately, and `sum` is refused exactly where it is undefined — adding two
positions — while `mean` stays legal, because a centroid is an affine combination.

Full rationale, the `SIGNALS` presets, the diagnostics, and the mapping onto
[sflow](https://github.com/snomiao/sflow)'s `tees` / `distributeBys` / `merges` /
`toLatests`: **[docs/signal.md](docs/signal.md)**.

## API overview

The default export is `createRgui` (alias `rgui`). Named exports additionally expose the rg
math, model, and rendering pieces for standalone use without building the full UI. Everything
is framework-agnostic pure functions and plain data.

- **High level**: `createRgui` — interaction callbacks (`onNodeMove(End)`, `onConnect` +
  `isValidConnection`, `onSnapConnectChange`, `onNodeClick`/`onNodeContextMenu`,
  `onEdgeClick`/`onEdgeContextMenu`,
  `onConnectEnd`, `onSelectionChange`, `onPinChange`, `onNodeResize(End)`,
  `onCanvasContextMenu`), viewer methods (`setGraph`, `snapGraph`, `autoLayout`, `fitView`,
  `setView`, `setRotation3`, `setSelection`, `setPanels`, `setNodeOverlay`, `resizeNode`,
  `setTheme`, e2e accessors `portScreenPos`/`edgeMidScreen`), options (`rule`, `summarize`,
  `panels`, `snapConnect`, `input: "figma" | "classic"`, `keyboard`, `keyboardSpeed`,
  `renderer: "auto" | "canvas2d" | "webgpu"`, `maxDpr`, `background`, `theme`)
- **Grid math** (`core/grid`): `readableStep`, `gridLevels`, `finerStep`, `gridRange`,
  `snap`, `snapSizeRadix`, `sizeLayerStep`, `worldToScreen`, `screenToWorld`
- **Rules** (`core/rule`): `DEFAULT_RULE`, `resolveRule`, type `RgRule`
- **Graph model** (`core/graph`): `demoGraph`, `orgChartGraph`, `nodeHeight`, `bodyRect`,
  flow helpers (`inSide`, `outSide`, `flowAxis`, `portPos`, `sidePortPos`), containment
  helpers (`childrenOf`, `descendantsOf`, `containerIds`,
  `containmentOf`), types `Graph`, `GraphNode` (incl. `z`, `pinned`, `parent`, `flow`,
  `fieldRules`, `body`, `draw`, `overlay`), `Edge` (incl. `temp`), `Flow`, `Side`
- **Semantic-zoom LOD** (`core/lod`): `buildRenderGraph`, `pseudoRect`, `pseudoPortPos`
- **Packing** (`core/pack`): `resolveOverlap`, `flushSegments`, `flushComponents`,
  `computePortLayout`, `clampSize`, `snapConnections`
- **Data merge** (`core/aggregate`): `aggregate`, `fieldSummarize`, `defaultSummarize`,
  `ordered`, `topK`, `quantile`, type `MergeRule`
- **Signal algebra** (`core/signal`): `SIGNALS` presets, `checkSignals`, `forkValue`,
  `resolveSignal`, `portMerge`, `splitQuantity`, `splitAtoms`, `routeIndex`, types
  `Measure`, `Fanout`, `Grain`, `SignalSpec`, `Atomizer` — what a wire carries and what
  happens when it forks or converges. See [docs/signal.md](docs/signal.md)
- **Layout** (`core/layout`): `layoutGraph`
- **Renderers** (`render`): Canvas 2D layers, `createWebGPUGridRenderer` (grid underlay),
  panels (`panelLayout`/`drawPanels`), HTML overlays (`createOverlayManager`),
  `KIND_COLOR`/`CATEGORY_COLOR` + `kindColor`/`categoryColor`

TypeScript type definitions are bundled. To read the source directly, the raw TypeScript is
available from the `@snomiao/rgui/src` subpath.

## Roadmap

- **WebGPU** — the grid/field underlay already renders on WebGPU (`renderer: "auto"`, with a
  quiet canvas2d fallback); wires and node blocks move behind the same seam next.
- Scaling the LOD pipeline to much larger graphs (spatial indexing).
- i18n for docs (English-first for now).

## Mascot — Royal Gramma

<img src="assets/rgui-icon-128.png" width="128" height="128" align="right" alt="rgui icon — Royal Gramma crossover field, one eye at the head">

The face of the project is the Royal Gramma (*Gramma loreto*), a small Caribbean reef fish whose
body shifts from violet to gold across a single seamless crossover — and whose initials happen to
spell **R**oyal **G**ramma = **RG**, the same letters as the renormalization group (a pun, not the
name's origin — see the top of this README). Look closely at a real one and the transition zone is
literally gold speckles over purple: the fish dithers itself, organically. One continuous flow,
readable at every scale.

The icon is implemented as a **function of position**, not a bitmap: it is generated natively at
any resolution from 8² to 4K, never resampled, always exactly 4 colors. The gradient direction is
the projection of the fish's 3-D swim direction — when the head points at the viewer, eyes appear.
The animated version advances exactly one scale octave per loop — a literal renormalization-group
flow — so frame N is pixel-for-pixel identical to frame 0. PNG sizes and loop GIFs (steady +
wandering) live in `assets/`, together with the generator (`assets/icon-lab.html`).

## License

MIT © snomiao
