/**
 * Double-tap (touch) / double-click (mouse) on a node = maximize: the
 * viewport glides to fit the node (or its snapped stack); doubling again on
 * the same target restores the pre-fit viewport. Two-finger tap stays
 * reserved (context menu) and must not trigger the fit.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, describe, expect, test } from "bun:test";
import { createRgui } from "./rgui.js";
import type { Graph } from "./core/graph.js";

afterAll(() => GlobalRegistrator.unregister());

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

const ptr = (type: string, id: number, ox: number, oy: number, pointerType = "touch") => {
  const e = new Event(type, { bubbles: true }) as unknown as Record<string, unknown>;
  e.offsetX = ox;
  e.offsetY = oy;
  e.button = 0;
  e.buttons = type === "pointerup" ? 0 : 1;
  e.pointerId = id;
  e.isPrimary = id === 1;
  e.shiftKey = false;
  e.pointerType = pointerType;
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
  viewer.setView({ x: 0, y: 0, k: 1 });
  return { viewer, canvas };
}

const tapNode = (canvas: HTMLCanvasElement) => {
  canvas.dispatchEvent(ptr("pointerdown", 1, 150, 50));
  canvas.dispatchEvent(ptr("pointerup", 1, 150, 50));
};

/** the flyTo glide runs on rAF; happy-dom has none pumping, so poll the view */
const settle = async (viewer: { view: { k: number } }, doneWhen: (k: number) => boolean) => {
  for (let i = 0; i < 400 && !doneWhen(viewer.view.k); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("double-tap maximize", () => {
  test("touch double-tap fits the node; doubling again restores", async () => {
    const { viewer, canvas } = boot();
    tapNode(canvas);
    expect(viewer.view.k).toBe(1); // single tap only selects
    tapNode(canvas);
    // node 256x192(+title) in 800x600 with 48px padding — fit zooms IN;
    // wait for the glide to LAND (restore only arms once at the target)
    await settle(viewer, (k) => k > 2.5);
    await new Promise((r) => setTimeout(r, 200));
    expect(viewer.view.k).toBeGreaterThan(2.5);
    // double-tap again while fitted → restore the original viewport
    tapNode(canvas);
    tapNode(canvas);
    await settle(viewer, (k) => Math.abs(k - 1) < 0.01);
    expect(viewer.view.k).toBeCloseTo(1, 1);
    viewer.destroy();
  });

  test("mouse double-click fits and selects the node", async () => {
    const { viewer, canvas } = boot();
    const e = new Event("dblclick", { bubbles: true }) as unknown as Record<string, unknown>;
    e.offsetX = 150;
    e.offsetY = 50;
    canvas.dispatchEvent(e as unknown as Event);
    await settle(viewer, (k) => k > 1.5);
    expect(viewer.view.k).toBeGreaterThan(1.5);
    expect([...(viewer.selection ?? [])]).toEqual(["a"]);
    viewer.destroy();
  });
});
