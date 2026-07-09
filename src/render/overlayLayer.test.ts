import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_RULE } from "../core/rule.js";
import type { Graph, GraphNode, NodeCategory } from "../core/graph.js";
import { createOverlayManager, type NodeHtmlOverlay } from "./overlayLayer.js";

const VIEW = { k: 1, x: 0, y: 0 };

function mkCanvas(): HTMLCanvasElement {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  host.appendChild(canvas);
  document.body.appendChild(host);
  // happy-dom lays nothing out; the manager reads these to decide off-screen
  Object.defineProperty(canvas, "clientWidth", { value: 800 });
  Object.defineProperty(canvas, "clientHeight", { value: 600 });
  return canvas;
}

function mkNode(overlay: NodeHtmlOverlay): GraphNode {
  return {
    id: "n1",
    title: "stt",
    category: "model" as NodeCategory,
    x: 10,
    y: 20,
    w: 200,
    h: 160,
    inputs: [],
    outputs: [],
    fields: [],
    overlay,
  };
}

/** the host re-maps its graph: a FRESH node + a FRESH overlay object, same el */
const remap = (overlay: NodeHtmlOverlay): Graph => ({
  nodes: [mkNode(overlay)],
  edges: [],
});

const wrapOf = (el: HTMLElement) => el.parentElement as HTMLDivElement;

describe("overlay options survive a graph re-map", () => {
  let canvas: HTMLCanvasElement;
  let el: HTMLElement;

  beforeEach(() => {
    canvas = mkCanvas();
    el = document.createElement("div");
  });

  test("a rebuilt overlay object with the SAME el does not remount", () => {
    const mgr = createOverlayManager(canvas);
    let destroyed = 0;
    const g1 = remap({ el, anchor: "over", destroy: () => destroyed++ });
    mgr.sync(g1, null, VIEW, DEFAULT_RULE);
    const wrap = wrapOf(el);

    // same el, brand-new overlay object — what setGraph hands us every change
    const g2 = remap({ el, anchor: "over", destroy: () => destroyed++ });
    mgr.sync(g2, null, VIEW, DEFAULT_RULE);

    expect(destroyed).toBe(0); // React portal must not be torn down
    expect(wrapOf(el)).toBe(wrap); // same wrapper: never re-parented
  });

  test("changed anchor/offset on a rebuilt overlay TAKE EFFECT", () => {
    const mgr = createOverlayManager(canvas);
    mgr.sync(remap({ el, anchor: "over" }), null, VIEW, DEFAULT_RULE);
    // anchor "over" → node top-left (10, 20)
    expect(wrapOf(el).style.transform).toBe("translate(10px, 20px)");

    // the regression: mount captured the old options and never refreshed them
    mgr.sync(
      remap({ el, anchor: "below", offset: { x: 3, y: 4 } }),
      null,
      VIEW,
      DEFAULT_RULE,
    );
    // anchor "below" → node bottom-left (10, 20+160) plus the offset
    expect(wrapOf(el).style.transform).toBe("translate(13px, 184px)");
  });

  test("clip:'node' styles are cleared when a later object drops the clip", () => {
    const mgr = createOverlayManager(canvas);
    mgr.sync(
      remap({ el, anchor: "over", clip: "node" }),
      null,
      VIEW,
      DEFAULT_RULE,
    );
    expect(wrapOf(el).style.width).toBe("200px");
    expect(wrapOf(el).style.pointerEvents).toBe("auto");

    mgr.sync(
      remap({ el, anchor: "over", clip: "viewport" }),
      null,
      VIEW,
      DEFAULT_RULE,
    );
    expect(wrapOf(el).style.width).toBe("");
    expect(wrapOf(el).style.pointerEvents).toBe("none");
  });

  test("flipping `interactive` on a rebuilt overlay re-wires pointer events", () => {
    const mgr = createOverlayManager(canvas);
    mgr.sync(
      remap({ el, anchor: "over", interactive: false }),
      null,
      VIEW,
      DEFAULT_RULE,
    );
    expect(el.style.pointerEvents).toBe("none");

    const btn = document.createElement("button");
    el.appendChild(btn);
    mgr.sync(
      remap({ el, anchor: "over", interactive: true }),
      null,
      VIEW,
      DEFAULT_RULE,
    );
    // background stays click-through; the control itself becomes hittable
    expect(el.style.pointerEvents).toBe("none");
    expect(btn.style.pointerEvents).toBe("auto");
  });

  test("unmount calls the LATEST destroy, not the one captured at mount", () => {
    const mgr = createOverlayManager(canvas);
    const calls: string[] = [];
    mgr.sync(
      remap({ el, destroy: () => calls.push("stale") }),
      null,
      VIEW,
      DEFAULT_RULE,
    );
    mgr.sync(
      remap({ el, destroy: () => calls.push("fresh") }),
      null,
      VIEW,
      DEFAULT_RULE,
    );

    mgr.sync({ nodes: [], edges: [] }, null, VIEW, DEFAULT_RULE); // node removed
    expect(calls).toEqual(["fresh"]);
  });

  test("a swapped el DOES remount (and destroys the outgoing overlay)", () => {
    const mgr = createOverlayManager(canvas);
    let destroyed = 0;
    mgr.sync(remap({ el, destroy: () => destroyed++ }), null, VIEW, DEFAULT_RULE);

    const el2 = document.createElement("div");
    mgr.sync(remap({ el: el2 }), null, VIEW, DEFAULT_RULE);
    expect(destroyed).toBe(1);
    expect(el2.parentElement).not.toBeNull();
  });
});

describe("clip:'node' background presses forward to the canvas", () => {
  let canvas: HTMLCanvasElement;
  let el: HTMLElement;

  beforeEach(() => {
    canvas = mkCanvas();
    el = document.createElement("div");
  });

  const press = (target: HTMLElement, type = "pointerdown") =>
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true }),
    );

  test("a press on the wrap itself re-dispatches to the canvas", () => {
    const mgr = createOverlayManager(canvas);
    const got: string[] = [];
    canvas.addEventListener("pointerdown", () => got.push("pointerdown"));
    canvas.addEventListener("dblclick", () => got.push("dblclick"));
    mgr.sync(remap({ el, anchor: "over", clip: "node" }), null, VIEW, DEFAULT_RULE);

    press(wrapOf(el)); // full-bleed overlay background = node drag
    press(wrapOf(el), "dblclick");
    expect(got).toEqual(["pointerdown", "dblclick"]);
  });

  test("a press on a control does NOT forward (it owns the gesture)", () => {
    const mgr = createOverlayManager(canvas);
    let forwarded = 0;
    canvas.addEventListener("pointerdown", () => forwarded++);
    const btn = document.createElement("button");
    el.appendChild(btn);
    mgr.sync(remap({ el, anchor: "over", clip: "node" }), null, VIEW, DEFAULT_RULE);

    press(btn); // bubbles through the wrap, but the control is the target
    expect(forwarded).toBe(0);
  });
});
