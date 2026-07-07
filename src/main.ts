/** Demo app — dogfoods the library exactly as a consumer would. */
import rgui, { demoGraph } from "./index";
import "./gizmo"; // corner cube = viewport rotation handle

const canvas = document.querySelector<HTMLCanvasElement>("#viewer")!;
const debug = document.querySelector<HTMLDivElement>("#debug")!;

const graph = demoGraph();

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

// expose for host debugging / e2e
(window as unknown as { viewer: typeof viewer }).viewer = viewer;
