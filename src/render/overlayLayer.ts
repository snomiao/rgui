/**
 * rgui HTML overlays — real DOM controls glued to nodes.
 *
 * Canvas cannot host interactive form controls, so rgui owns a positioned
 * DOM layer above the canvas and keeps each registered element glued to its
 * node's screen rect every frame (drag included). Size is screen-fixed
 * (overlays do not scale with zoom); only position follows.
 *
 * Visibility reuses the native readability rule: an overlay hides (without
 * being destroyed) whenever its node is collapsed into a pseudo-node,
 * fully off-screen, or too small to read — so collapsed stacks show only
 * boundary ports + the pseudo summary, never per-node config.
 */
import { nodeHeight, NODE_ROW_H, type Graph, type GraphNode } from "../core/graph.js";
import type { ViewTransform } from "../core/grid.js";
import type { RgRule } from "../core/rule.js";

export interface NodeHtmlOverlay {
  el: HTMLElement;
  /** where to glue relative to the node rect (default "right") */
  anchor?: "right" | "below" | "over";
  /** screen-px offset from the anchor point */
  offset?: { x: number; y: number };
  /** pointer-events on the element (default true) */
  interactive?: boolean;
  /** called when the overlay is unmounted (replaced, node gone, destroy) */
  destroy?: () => void;
}

export interface OverlayManager {
  /** glue/refresh all overlays for the current frame */
  sync(
    graph: Graph,
    visibleNodes: GraphNode[] | null,
    view: ViewTransform,
    rule: RgRule,
  ): void;
  destroy(): void;
}

export function createOverlayManager(
  canvas: HTMLCanvasElement,
): OverlayManager {
  let layer: HTMLDivElement | null = null;
  const mounted = new Map<
    string,
    { ov: NodeHtmlOverlay; wrap: HTMLDivElement }
  >();

  function ensureLayer(): HTMLDivElement | null {
    if (layer) return layer;
    const parent = canvas.parentElement;
    if (!parent) return null;
    if (getComputedStyle(parent).position === "static")
      parent.style.position = "relative";
    layer = document.createElement("div");
    layer.className = "rgui-overlay-layer";
    // viewport clip by default; wrapper is a pass-through
    layer.style.cssText =
      "position:absolute;inset:0;overflow:hidden;pointer-events:none;";
    parent.appendChild(layer);
    return layer;
  }

  function unmount(id: string) {
    const m = mounted.get(id);
    if (!m) return;
    m.wrap.remove();
    try {
      m.ov.destroy?.();
    } catch (err) {
      console.error("[rgui] overlay destroy failed:", err);
    }
    mounted.delete(id);
  }

  function sync(
    graph: Graph,
    visibleNodes: GraphNode[] | null,
    view: ViewTransform,
    rule: RgRule,
  ) {
    const want = new Map(
      graph.nodes.filter((n) => n.overlay).map((n) => [n.id, n]),
    );
    // unmount overlays whose node vanished or whose element was replaced
    for (const [id, m] of [...mounted]) {
      const n = want.get(id);
      if (!n || n.overlay!.el !== m.ov.el) unmount(id);
    }
    if (!want.size) return;
    if (!ensureLayer()) return;

    const visible = new Set((visibleNodes ?? graph.nodes).map((n) => n.id));
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    let z = 0;
    for (const [id, n] of want) {
      let m = mounted.get(id);
      if (!m) {
        const ov = n.overlay!;
        const wrap = document.createElement("div");
        wrap.dataset["nodeId"] = id;
        wrap.style.cssText =
          "position:absolute;left:0;top:0;pointer-events:none;will-change:transform;";
        ov.el.style.pointerEvents =
          ov.interactive === false ? "none" : "auto";
        wrap.appendChild(ov.el);
        layer!.appendChild(wrap);
        m = { ov, wrap };
        mounted.set(id, m);
      }
      const k = view.k;
      const h = nodeHeight(n);
      const x0 = n.x * k + view.x;
      const y0 = n.y * k + view.y;
      const x1 = (n.x + n.w) * k + view.x;
      const y1 = (n.y + h) * k + view.y;
      const readable = NODE_ROW_H * k >= rule.fieldMinPx;
      const offscreen = x1 < 0 || y1 < 0 || x0 > W || y0 > H;
      const show = visible.has(id) && readable && !offscreen;
      m.wrap.style.display = show ? "" : "none";
      if (!show) continue;
      const anchor = m.ov.anchor ?? "right";
      const d =
        m.ov.offset ??
        (anchor === "right"
          ? { x: 8, y: 0 }
          : anchor === "below"
            ? { x: 0, y: 8 }
            : { x: 0, y: 0 });
      const tx = anchor === "right" ? x1 + d.x : x0 + d.x;
      const ty = anchor === "below" ? y1 + d.y : y0 + d.y;
      m.wrap.style.transform = `translate(${tx}px, ${ty}px)`;
      m.wrap.style.zIndex = String(z++);
    }
  }

  return {
    sync,
    destroy() {
      for (const id of [...mounted.keys()]) unmount(id);
      layer?.remove();
      layer = null;
    },
  };
}
