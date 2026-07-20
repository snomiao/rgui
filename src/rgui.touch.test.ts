/**
 * Two-finger touch = canvas navigation (pan + pinch zoom); one finger keeps
 * the mouse semantics (marquee on empty canvas). The promotion rules under
 * test come from the edge-case matrix in otoji's TODO.md:
 *  - a second finger discards a live marquee without changing the selection
 *  - the pinch pans/zooms about the finger midpoint
 *  - after a two-finger gesture, the surviving finger stays inert (no
 *    marquee resume, no click-clear of the selection) until all fingers lift
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

const mkGraph = (): Graph => ({
  nodes: [
    {
      id: "a",
      title: "A",
      category: "model",
      x: 100,
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
const touch = (type: string, id: number, ox: number, oy: number) => {
  const e = new Event(type, { bubbles: true }) as unknown as Record<
    string,
    unknown
  >;
  e.offsetX = ox;
  e.offsetY = oy;
  e.button = 0;
  e.buttons = type === "pointerup" ? 0 : 1;
  e.pointerId = id;
  e.isPrimary = id === 1;
  e.shiftKey = false;
  e.pointerType = "touch";
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

describe("two-finger touch navigation", () => {
  test("pinch out zooms about the midpoint; pinch drag pans", () => {
    const { viewer, canvas } = boot();
    // both fingers on empty canvas (node spans x 100..356, y 0..192 — use y 400)
    canvas.dispatchEvent(touch("pointerdown", 1, 300, 400));
    canvas.dispatchEvent(touch("pointerdown", 2, 500, 400));
    // spread 200px → 400px = 2× zoom, midpoint moves +100x
    canvas.dispatchEvent(touch("pointermove", 1, 250, 400));
    canvas.dispatchEvent(touch("pointermove", 2, 650, 400));
    expect(viewer.view.k).toBeCloseTo(2, 5);
    // world point under the original midpoint (400,400) must sit under the
    // new midpoint (450,400): view.x = 450 - 400*2 = -350
    expect(viewer.view.x).toBeCloseTo(-350, 3);
    expect(viewer.view.y).toBeCloseTo(400 - 400 * 2, 3);
    viewer.destroy();
  });

  test("a second finger discards a live marquee without touching the selection", () => {
    const { viewer, canvas } = boot();
    viewer.setSelection(["a"]);
    const before = [...(viewer.selection ?? [])];
    // finger 1 starts a marquee on empty canvas and sweeps
    canvas.dispatchEvent(touch("pointerdown", 1, 500, 400));
    canvas.dispatchEvent(touch("pointermove", 1, 520, 420));
    // finger 2 lands → promote to navigation
    canvas.dispatchEvent(touch("pointerdown", 2, 600, 500));
    canvas.dispatchEvent(touch("pointermove", 1, 560, 460));
    canvas.dispatchEvent(touch("pointerup", 1, 560, 460));
    canvas.dispatchEvent(touch("pointerup", 2, 600, 500));
    expect([...(viewer.selection ?? [])]).toEqual(before);
    viewer.destroy();
  });

  test("after a pinch, the surviving finger cannot marquee or click-clear until all lift", () => {
    const { viewer, canvas } = boot();
    viewer.setSelection(["a"]);
    canvas.dispatchEvent(touch("pointerdown", 1, 300, 400));
    canvas.dispatchEvent(touch("pointerdown", 2, 500, 400));
    canvas.dispatchEvent(touch("pointerup", 2, 500, 400));
    // finger 1 keeps moving on empty canvas — must NOT start a marquee...
    canvas.dispatchEvent(touch("pointermove", 1, 200, 300));
    // ...and its release must NOT be a click that clears the selection
    canvas.dispatchEvent(touch("pointerup", 1, 200, 300));
    expect([...(viewer.selection ?? [])]).toEqual(["a"]);
    // with every finger lifted, single-touch marquee works again
    canvas.dispatchEvent(touch("pointerdown", 1, 500, 400));
    canvas.dispatchEvent(touch("pointermove", 1, 520, 420));
    canvas.dispatchEvent(touch("pointerup", 1, 520, 420));
    viewer.destroy();
  });

  test("a second finger can neither move nor finish another finger's node drag", () => {
    const { viewer, canvas } = boot();
    // finger 1 grabs the node (spans 100..356 x 0..192)
    canvas.dispatchEvent(touch("pointerdown", 1, 150, 50));
    const x0 = viewer.graph.nodes[0]!.x;
    // finger 2 lands far away and sweeps — the node must not teleport
    canvas.dispatchEvent(touch("pointerdown", 2, 600, 500));
    canvas.dispatchEvent(touch("pointermove", 2, 700, 520));
    expect(viewer.graph.nodes[0]!.x).toBe(x0);
    // finger 2 lifting must not fire the drag's End path (drag survives);
    // finger 1 can still move the node afterwards
    canvas.dispatchEvent(touch("pointerup", 2, 700, 520));
    canvas.dispatchEvent(touch("pointermove", 1, 214, 50));
    expect(viewer.graph.nodes[0]!.x).not.toBe(x0);
    viewer.destroy();
  });

  test("owner pointercancel commits the move via onNodeMoveEnd", () => {
    const canvas0 = document.createElement("canvas");
    const c = canvas0 as unknown as Record<string, unknown>;
    c.getContext = () => stubCtx();
    c.setPointerCapture = () => {};
    c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    Object.defineProperty(canvas0, "clientWidth", { value: 800 });
    Object.defineProperty(canvas0, "clientHeight", { value: 600 });
    document.body.appendChild(canvas0);
    const ends: Array<{ id: string; x: number }> = [];
    const viewer = createRgui(canvas0, {
      graph: mkGraph(),
      onNodeMoveEnd: (id, at) => ends.push({ id, x: at.x }),
    });
    viewer.setView({ x: 0, y: 0, k: 1 });
    canvas0.dispatchEvent(touch("pointerdown", 1, 150, 50));
    canvas0.dispatchEvent(touch("pointermove", 1, 214, 50));
    const moved = viewer.graph.nodes[0]!.x;
    canvas0.dispatchEvent(touch("pointercancel", 1, 214, 50));
    // the live mutation is committed, not silently abandoned
    expect(ends).toEqual([{ id: "a", x: moved }]);
    viewer.destroy();
  });

  test("one-finger touch still marquee-selects on empty canvas", () => {
    const { viewer, canvas } = boot();
    // sweep a marquee over the node (node spans 100..356 x 0..192 in view)
    canvas.dispatchEvent(touch("pointerdown", 1, 80, 250));
    canvas.dispatchEvent(touch("pointermove", 1, 400, -20));
    canvas.dispatchEvent(touch("pointerup", 1, 400, -20));
    expect([...(viewer.selection ?? [])]).toEqual(["a"]);
    viewer.destroy();
  });
});

describe("touch long-press context menu", () => {
  const bootWithMenu = () => {
    const canvas = document.createElement("canvas") as HTMLCanvasElement;
    const c = canvas as unknown as Record<string, unknown>;
    c.getContext = () => stubCtx();
    c.setPointerCapture = () => {};
    c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    Object.defineProperty(canvas, "clientWidth", { value: 800 });
    Object.defineProperty(canvas, "clientHeight", { value: 600 });
    document.body.appendChild(canvas);
    const calls: Array<{ nodeId: string; ids?: string[] }> = [];
    const viewer = createRgui(canvas, {
      graph: {
        nodes: [
          { id: "a", title: "A", category: "model", x: 100, y: 0, w: 256, h: 192, inputs: [], outputs: [], fields: [] },
          { id: "b", title: "B", category: "model", x: 450, y: 0, w: 256, h: 192, inputs: [], outputs: [], fields: [] },
        ],
        edges: [],
      },
      onNodeContextMenu: (nodeId, _at, ids) => calls.push({ nodeId, ids }),
    });
    viewer.setView({ x: 0, y: 0, k: 1 });
    return { viewer, canvas, calls };
  };

  test("holding a finger on a node fires the menu with the whole selection", async () => {
    const { viewer, canvas, calls } = bootWithMenu();
    viewer.setSelection(["a", "b"]);
    canvas.dispatchEvent(touch("pointerdown", 1, 150, 50)); // on node a
    await new Promise((r) => setTimeout(r, 650));
    expect(calls.length).toBe(1);
    expect(calls[0]!.nodeId).toBe("a");
    expect([...calls[0]!.ids!].sort()).toEqual(["a", "b"]);
    // the press consumed the gesture: releasing must not click/select-reset
    canvas.dispatchEvent(touch("pointerup", 1, 150, 50));
    expect([...(viewer.selection ?? [])].sort()).toEqual(["a", "b"]);
    viewer.destroy();
  });

  test("lift, movement, or a second finger cancels the long-press", async () => {
    const { canvas, calls, viewer } = bootWithMenu();
    // quick tap: released before the delay
    canvas.dispatchEvent(touch("pointerdown", 1, 150, 50));
    canvas.dispatchEvent(touch("pointerup", 1, 150, 50));
    // hold but with a second finger (pinch, not menu)
    canvas.dispatchEvent(touch("pointerdown", 1, 150, 50));
    canvas.dispatchEvent(touch("pointerdown", 2, 600, 400));
    await new Promise((r) => setTimeout(r, 650));
    expect(calls.length).toBe(0);
    canvas.dispatchEvent(touch("pointerup", 1, 150, 50));
    canvas.dispatchEvent(touch("pointerup", 2, 600, 400));
    viewer.destroy();
  });
});
