/** Demo app — dogfoods the library exactly as a consumer would. */
import rgui, {
  demoGraph,
  gripBase,
  gripRescale,
  orgChartGraph,
  snapNodeSize,
  type GraphNode,
  type SizeLaw,
} from "./index";

const canvas = document.querySelector<HTMLCanvasElement>("#viewer")!;
const debug = document.querySelector<HTMLDivElement>("#debug")!;

const graph = demoGraph();

// second domain on the same canvas: an org chart built from CONTAINER
// nodes — teams hold their people, and zooming out makes each team absorb
// its members into one team block (containment IS the RG hierarchy)
const org = orgChartGraph();
for (const n of org.nodes) n.y += 896; // below the media pipeline, on-lattice
graph.nodes.push(...org.nodes);
graph.edges.push(...org.edges);

// edge styling demo: label + custom width on the labels wire
const labelsEdge = graph.edges.find((e) => e.from.port === "labels")!;
labelsEdge.label = "labels.txt";
labelsEdge.style = { width: 2.5 };

// live-body demo: fake waveform on the STT node (dogfoods GraphNode.body)
const stt = graph.nodes.find((n) => n.id === "stt")!;
stt.bodyRows = 2;
let phase = 0;
stt.body = (ctx, rect) => {
  ctx.strokeStyle = "#fb923c";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = 0; x <= rect.width; x += 2) {
    const y =
      rect.height / 2 +
      Math.sin(x / 9 + phase) * Math.sin(x / 37 + phase / 3) * rect.height * 0.4;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
};
setInterval(() => {
  phase += 0.35;
  viewer.invalidate();
}, 50);

const viewer = rgui(canvas, {
  graph,
  debug,
  maxDpr: 1.5, // busy homepage: trade a little sharpness for frame rate
  background: false, // page bg shows through; the RGUI title sits BEHIND nodes
  // host-app hooks (otoji-style integration)
  onNodeMoveEnd: (id, pos) => console.log("[rgui] moveEnd", id, pos),
  isValidConnection: (from, to) => {
    const a = graph.nodes.find((n) => n.id === from.node);
    const b = graph.nodes.find((n) => n.id === to.node);
    const out = a?.outputs.find((p) => p.id === from.port);
    const inp = b?.inputs.find((p) => p.id === to.port);
    return !!out && !!inp && out.kind === inp.kind;
  },
  onConnect: (from, to) => {
    console.log("[rgui] connect", from, to);
    graph.edges.push({
      from: { node: from.node, port: from.port },
      to: { node: to.node, port: to.port },
    });
    viewer.invalidate();
  },
  onNodeClick: (id, at) => console.log("[rgui] click", id, at),
  onSelectionChange: (ids) => console.log("[rgui] selection", ids),
  onEdgeClick: (e, at) => console.log("[rgui] edgeClick", e.from, e.to, at),
  onEdgeContextMenu: (e) => console.log("[rgui] edgeMenu", e.from, e.to),
  onConnectEnd: (from, at) => console.log("[rgui] connectEnd", from, at.world),
  onNodeContextMenu: (id, at) => console.log("[rgui] context", id, at),
  onCanvasContextMenu: (at, world) => console.log("[rgui] canvasMenu", at, world),
  // summarize rule: hosts know what nodes MEAN — compact content for small
  // nodes and merged groups
  summarize: (nodes, info) => {
    if (info.level === "pseudo") {
      return {
        kind: "text",
        lines: [
          nodes.map((n) => n.title).join(" → "),
          `${nodes.length} nodes · rusty-fox`,
        ],
      };
    }
    const n = nodes[0]!;
    if (n.id === "mic") {
      return {
        kind: "canvas",
        height: 22,
        draw: (ctx, rect) => {
          ctx.strokeStyle = "#fb923c";
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let x = 0; x <= rect.width; x += 2) {
            const y = rect.height / 2 + Math.sin(x / 6 + phase) * rect.height * 0.4;
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.stroke();
        },
      };
    }
    const key = n.fields[0];
    return key ? { kind: "kv", rows: [[key[0], key[1]]] } : null;
  },
  onPinChange: (id, pinned) => console.log("[rgui] pin", id, pinned),
  onPanelMove: (panel, anchor) =>
    console.log("[rgui] panelMove", panel.id, anchor),
  panels: [
    {
      id: "palette",
      title: "INPUT NODES",
      anchor: "left",
      items: [
        { id: "mic", label: "Mic + VAD", color: "#fb923c" },
        { id: "cam", label: "Camera", color: "#2dd4bf" },
        { id: "file", label: "Audio file", color: "#fb923c" },
        { id: "text", label: "Text (in)", color: "#60a5fa" },
      ],
      onItemClick: (item, at) => console.log("[rgui] palette click", item.id, at),
      onItemDrop: (item, at) => {
        console.log("[rgui] palette drop", item.id, at.world);
        graph.nodes.push({
          id: `${item.id}-${graph.nodes.length}`,
          title: item.label,
          category: "source",
          x: at.world.x,
          y: at.world.y,
          w: 200,
          inputs: [],
          outputs: [{ id: "out", label: "out", kind: "audio" }],
          fields: [["via", "palette"]],
        });
        viewer.invalidate();
      },
    },
    {
      id: "templates",
      title: "WORKFLOWS",
      anchor: "left",
      items: [
        { id: "live-captions", label: "Live captions" },
        { id: "translate", label: "Live translate" },
      ],
      onItemClick: (item) => console.log("[rgui] template", item.id),
    },
  ],
});

// --- grid radix (进制) picker -----------------------------------------
// Radix sets the grid LAYERS (radix^n), and node sizes must span 1..radix
// grids at some layer. So it also decides which magnifications a shift-drag
// rescale can even land on: radix 8 steps by quarters up to 2x then jumps,
// radix 4 reaches 1x, 2x, 3x, 4x, radix 16 gives sixteenths below 1x.
// The ladder below is PROBED from the real gesture, not a restated formula —
// if gripRescale changes, this display follows.
const probe = (): GraphNode => ({
  id: "probe",
  title: "probe",
  category: "model",
  x: 0,
  y: 0,
  w: 256,
  h: 192,
  inputs: [],
  outputs: [],
  fields: [],
});

function scaleLadder(radix: number): number[] {
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const n = probe();
    // sweep the cursor out along the node's diagonal, collecting what sticks
    const r = gripRescale(n, gripBase(n), 4 + i * 2.1, 3 + i * 1.575, [n], radix);
    seen.add(Number(r.scale.toFixed(4)));
  }
  return [...seen].sort((a, b) => a - b);
}

const radixBox = document.querySelector<HTMLDivElement>("#radix")!;
const ladderEl = document.querySelector<HTMLDivElement>("#radix-ladder")!;

/** the size law only bites on a node whose axes want DIFFERENT layers */
function lawExample(radix: number, law: SizeLaw, wg: number, hg: number): string {
  const step = 64; // one main grid at k=1
  const { w, h } = snapNodeSize(wg * step, hg * step, radix, law);
  return `${w / step} × ${h / step}`;
}

function sync(radix: number, law: SizeLaw) {
  viewer.setRule({ radix, sizeLaw: law });
  for (const b of radixBox.querySelectorAll("button")) {
    if (b.dataset.radix)
      b.setAttribute("aria-pressed", String(Number(b.dataset.radix) === radix));
    if (b.dataset.law)
      b.setAttribute("aria-pressed", String(b.dataset.law === law));
  }
  const rungs = scaleLadder(radix)
    .map((s) => (s === 1 ? `<b>1x</b>` : `${s}x`))
    .join(" · ");
  // a squat node is where the law shows: its axes want different layers
  ladderEl.innerHTML =
    `radix ${radix} · rescale lands on<br>${rungs}` +
    `<br>a 2 × 9 node snaps to <b>${lawExample(radix, law, 2, 9)}</b>`;
}

radixBox.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button");
  if (!b) return;
  const radix = b.dataset.radix ? Number(b.dataset.radix) : viewer.rule.radix;
  const law = (b.dataset.law as SizeLaw) ?? viewer.rule.sizeLaw;
  sync(radix, law);
});
sync(viewer.rule.radix, viewer.rule.sizeLaw);

// expose for host debugging / e2e
(window as unknown as { viewer: typeof viewer }).viewer = viewer;
