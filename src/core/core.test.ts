import { describe, expect, test } from "bun:test";
import { finerStep, gridLevels, readableStep, snap } from "./grid";
import { demoGraph, nodeHeight, type GraphNode } from "./graph";
import { buildRenderGraph } from "./lod";
import { clampSize, flushSegments, resolveOverlap } from "./pack";
import { layoutGraph } from "./layout";
import { DEFAULT_RULE } from "./rule";

const mkNode = (
  id: string,
  x: number,
  y: number,
  w = 200,
  fields = 2,
): GraphNode => ({
  id,
  title: id,
  category: "source",
  x,
  y,
  w,
  inputs: [],
  outputs: [],
  fields: Array.from({ length: fields }, (_, i) => [`f${i}`, "v"]),
});

describe("readable grid math", () => {
  test("readableStep picks the finest 1-2-5 step >= minPx", () => {
    expect(readableStep(1, 48)).toBe(50);
    expect(readableStep(0.5, 48)).toBe(100);
    // raw = 24wu: smallest ladder step >= 24 is 50 (25 is not on 1-2-5)
    expect(readableStep(2, 48)).toBe(50);
  });

  test("major level always renders >= minPx on screen", () => {
    for (const k of [1e-4, 0.03, 0.31, 1, 2.7, 42, 1e4]) {
      const [major] = gridLevels(k, 48);
      expect(major!.px).toBeGreaterThanOrEqual(48 - 1e-9);
    }
  });

  test("finerStep descends the ladder", () => {
    expect(finerStep(50)).toBe(20);
    expect(finerStep(20)).toBe(10);
    expect(finerStep(10)).toBe(5);
  });

  test("snap", () => {
    expect(snap(33, 20)).toBe(40);
    expect(snap(-33, 20)).toBe(-40);
  });
});

describe("一格一物 pack", () => {
  test("overlap pushes to flush contact", () => {
    const a = mkNode("a", 100, 100);
    const b = mkNode("b", 0, 0);
    // drop b overlapping a's bottom → flush at a's bottom edge
    const r = resolveOverlap(b, 118, 160, [a, b], {
      alignSnap: 40,
      direction: "ltr",
    });
    expect(r.y).toBe(100 + nodeHeight(a));
    expect(r.x).toBe(100); // left-aligned (readable start)
  });

  test("horizontal snap aligns tops", () => {
    const a = mkNode("a", 100, 100);
    const b = mkNode("b", 0, 0);
    const r = resolveOverlap(b, 260, 125, [a, b], {
      alignSnap: 40,
      direction: "ltr",
    });
    expect(r.x).toBe(300);
    expect(r.y).toBe(100);
  });

  test("flushSegments finds the shared edge", () => {
    const a = mkNode("a", 0, 0);
    const b = mkNode("b", 0, nodeHeight(mkNode("a", 0, 0)));
    const segs = flushSegments([a, b]);
    expect(segs.length).toBe(1);
    expect(segs[0]!.axis).toBe("h");
  });

  test("clampSize stops growth at a neighbor", () => {
    const a = mkNode("a", 0, 0);
    const right = mkNode("r", 300, 0);
    const { w } = clampSize(a, 400, nodeHeight(a), [a, right]);
    expect(w).toBe(300);
  });
});

describe("semantic-zoom LOD", () => {
  test("full detail at k=1, single pseudo far out", () => {
    const g = demoGraph();
    expect(buildRenderGraph(g, 1).pseudo.length).toBe(0);
    const far = buildRenderGraph(g, 0.01);
    expect(far.nodes.length).toBe(0);
    expect(far.pseudo.length).toBe(1);
  });

  test("pseudo exposes only open ports", () => {
    const g = demoGraph();
    const far = buildRenderGraph(g, 0.01);
    const p = far.pseudo[0]!;
    // all internal wires dissolved; only unconnected ports remain
    const labels = [...p.inputs, ...p.outputs].map((x) => x.label).sort();
    expect(labels).toEqual(["image", "json.txt"]);
  });
});

describe("snap beats location (merge priority)", () => {
  test("a flush stack collapses earlier than loose nodes", () => {
    const a = mkNode("a", 0, 0);
    const b = mkNode("b", 0, nodeHeight(mkNode("a", 0, 0))); // flush under a
    const far = mkNode("far", 900, 0); // isolated
    const g = { nodes: [a, b, far], edges: [] };
    // between collapsePx/h (~0.62) and collapseSnappedPx/h (~0.93):
    const rg = buildRenderGraph(g, 0.8);
    const pseudoIds = rg.pseudo.map((p) => p.id).join(",");
    expect(pseudoIds).toContain("a");
    expect(pseudoIds).toContain("b");
    expect(rg.nodes.map((n) => n.id)).toEqual(["far"]); // loose node stays
    expect(rg.pseudo.length).toBe(1); // one merged stack
  });
});

describe("auto-layout", () => {
  test("layers follow connections; pinned stays put", () => {
    const g = demoGraph();
    const cam = g.nodes.find((n) => n.id === "cam")!;
    cam.pinned = true;
    const before = { x: cam.x, y: cam.y };
    const pos = layoutGraph(g);
    expect(pos.has("cam")).toBe(false); // pinned excluded
    expect(cam.x).toBe(before.x);
    // vision consumes cam? cam is pinned/excluded — stt is downstream of mic
    const mic = pos.get("mic")!;
    const stt = pos.get("stt")!;
    const voice = pos.get("voice")!;
    expect(stt.x).toBeGreaterThan(mic.x);
    expect(voice.x).toBeGreaterThan(stt.x);
    // grid snapped
    for (const p of pos.values()) {
      expect(Math.abs(p.x % 20)).toBe(0);
      expect(Math.abs(p.y % 20)).toBe(0);
    }
  });
});

describe("rg rule", () => {
  test("defaults are sane", () => {
    expect(DEFAULT_RULE.ladder).toEqual([1, 2, 5]);
    expect(DEFAULT_RULE.clusterGapConnectedPx).toBeGreaterThan(
      DEFAULT_RULE.clusterGapPx,
    );
  });
});
