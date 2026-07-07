/** Demo app — dogfoods the library exactly as a consumer would. */
import rgui, { demoGraph } from "./index";

const canvas = document.querySelector<HTMLCanvasElement>("#viewer")!;
const debug = document.querySelector<HTMLDivElement>("#debug")!;

const graph = demoGraph();

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
  onNodeContextMenu: (id, at) => console.log("[rgui] context", id, at),
});
