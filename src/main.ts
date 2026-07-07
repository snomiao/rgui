/** Demo app — dogfoods the library exactly as a consumer would. */
import rgui, { demoGraph } from "./index";

const canvas = document.querySelector<HTMLCanvasElement>("#viewer")!;
const debug = document.querySelector<HTMLDivElement>("#debug")!;

const graph = demoGraph();

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
  onNodeContextMenu: (id, at) => console.log("[rgui] context", id, at),
});
