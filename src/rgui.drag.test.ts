/**
 * A live drag must survive a concurrent setGraph. Both assertions compare a
 * drag interrupted by a re-map against the SAME drag without one: whatever
 * the gesture would have done, a re-map that preserved the geometry must not
 * change it. Using a control instead of a literal keeps the tests honest —
 * a first pointermove legitimately snaps an off-lattice node to the lattice,
 * and that is not the bug.
 *
 * The node sits at x=100, deliberately OFF the main lattice (step 64 at k=1).
 * Host-supplied positions are not snapped — only drags snap them — so this is
 * the ordinary case, and it is the one that catches a mis-measured grab
 * offset. On-lattice fixtures pass even when the offset is wrong.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, describe, expect, test } from "bun:test";
import { createRgui } from "./rgui.js";
import type { Graph } from "./core/graph.js";

afterAll(() => GlobalRegistrator.unregister());

/** happy-dom has no canvas backend: every 2-D call is a no-op */
const stubCtx = () =>
  new Proxy({} as CanvasRenderingContext2D, {
    get(_t, p) {
      if (p === "measureText") return () => ({ width: 10 });
      if (p === "createLinearGradient" || p === "createPattern")
        return () => ({ addColorStop() {} });
      if (typeof p === "string" && /^[a-z]/.test(p)) return () => {};
      return undefined;
    },
    set: () => true,
  });

const OFF_LATTICE_X = 100; // main grid step is 64 at k=1

const mkGraph = (): Graph => ({
  nodes: [
    {
      id: "a",
      title: "A",
      category: "model",
      x: OFF_LATTICE_X,
      y: 0,
      w: 256,
      h: 192,
      inputs: [],
      outputs: [],
      fields: [],
    },
  ],
  edges: [],
});

/** happy-dom's MouseEvent does not derive offsetX, so build the event by hand */
const ptr = (type: string, ox: number, oy: number) => {
  const e = new Event(type, { bubbles: true }) as unknown as Record<
    string,
    unknown
  >;
  e.offsetX = ox;
  e.offsetY = oy;
  e.button = 0;
  e.buttons = type === "pointerup" ? 0 : 1;
  e.pointerId = 1;
  e.isPrimary = true;
  e.shiftKey = false;
  return e as unknown as Event;
};

function boot() {
  const canvas = document.createElement("canvas");
  const c = canvas as unknown as Record<string, unknown>;
  c.getContext = () => stubCtx();
  c.setPointerCapture = () => {};
  c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  Object.defineProperty(canvas, "clientWidth", { value: 800 });
  Object.defineProperty(canvas, "clientHeight", { value: 600 });
  document.body.appendChild(canvas);
  const viewer = createRgui(canvas, { graph: mkGraph() });
  viewer.setView({ x: 0, y: 0, k: 1 }); // screen coords == world coords
  return { viewer, canvas };
}

/** drag from (150,50); optionally re-map the graph mid-gesture */
function dragTo(toX: number, remap: boolean): number {
  const { viewer, canvas } = boot();
  canvas.dispatchEvent(ptr("pointerdown", 150, 50));
  if (remap) viewer.setGraph(mkGraph()); // fresh objects, identical geometry
  canvas.dispatchEvent(ptr("pointermove", toX, 50));
  const x = viewer.graph.nodes[0]!.x;
  viewer.destroy();
  return x;
}

describe("a live drag survives setGraph", () => {
  // a re-map landing BEFORE the first pointermove: `pointer` must already
  // hold the press position, or the drag re-anchors against (0, 0)
  test("re-map before the first move does not teleport the node", () => {
    expect(dragTo(150, true)).toBe(dragTo(150, false));
  });

  // the grab offset must be re-measured against the display rect the press
  // read, not a re-derivation of it: the no-rotation/no-overlap path returns
  // the base graph UNSNAPPED, so a hand-rolled snap() disagrees with it
  test("re-map preserves the grab offset across a later move", () => {
    expect(dragTo(190, true)).toBe(dragTo(190, false));
  });
});
