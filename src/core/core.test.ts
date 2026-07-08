import { describe, expect, test } from "bun:test";
import {
  finerStep,
  gridLevels,
  readableStep,
  snap,
  sizeLayerStep,
  snapSizeRadix,
} from "./grid";
import {
  childrenOf,
  containmentOf,
  demoGraph,
  descendantsOf,
  nodeHeight,
  nodeScale,
  orgChartGraph,
  type GraphNode,
} from "./graph";
import { kindColor, categoryColor, KIND_COLOR } from "../render/graphLayer";
import {
  panelCoverage,
  panelSnap,
  PANEL,
  type Panel,
  type PanelRect,
} from "../render/panelLayer";
import { buildRenderGraph, pseudoRect } from "./lod";
import { clampSize, flushSegments, resolveOverlap } from "./pack";
import { layoutGraph } from "./layout";
import { DEFAULT_RULE } from "./rule";
import {
  aggregate,
  fieldSummarize,
  ordered,
  quantile,
  topK,
} from "./aggregate";

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

describe("readable grid math (radix layers)", () => {
  test("readableStep picks the finest radix-power step >= minPx", () => {
    expect(readableStep(1, 48, 8)).toBe(64); // 8^2
    expect(readableStep(0.5, 48, 8)).toBe(512); // raw 96 → 8^3? no: 8^ceil(log8 96)=512? log8(96)=2.19→512
    expect(readableStep(8, 48, 8)).toBe(8); // raw 6 → 8^1
  });

  test("major level always renders >= minPx on screen", () => {
    for (const k of [1e-4, 0.03, 0.31, 1, 2.7, 42, 1e4]) {
      const [major] = gridLevels(k, 48);
      expect(major!.px).toBeGreaterThanOrEqual(48 - 1e-9);
    }
  });

  test("finerStep is one radix layer down", () => {
    expect(finerStep(64, 8)).toBe(8);
    expect(finerStep(8, 8)).toBe(1);
  });

  test("sizeLayerStep: the layer a size lives on", () => {
    expect(sizeLayerStep(200, 8)).toBe(64); // 4 grids @64
    expect(sizeLayerStep(8, 8)).toBe(1); // 8 grids @1
    expect(sizeLayerStep(513, 8)).toBe(512);
  });

  test("nodeScale: per-axis layers; w and h may differ", () => {
    // tall-narrow: w=64 lives on layer 8 (8 grids), h=512 on layer 64
    const tall = { ...mkNode("t", 0, 0, 64, 1), h: 512 };
    expect(nodeScale(tall, 8)).toEqual({ x: 8, y: 64 });
  });

  test("node-size law: 1..radix grids, promote past the limit", () => {
    // 9 grids at layer 1 (radix 8) → 2 grids at the next layer
    expect(snapSizeRadix(9, 8, 1)).toBe(16);
    expect(snapSizeRadix(8, 8, 1)).toBe(8); // exactly the limit stays
    expect(snapSizeRadix(3.2, 8, 1)).toBe(4);
    expect(snapSizeRadix(200, 8, 1)).toBe(256); // 25 grids@8 → 4 grids@64
    expect(snapSizeRadix(512, 8, 1)).toBe(512); // 8 grids@64 ok
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
  test("a stack RGs together: one member's threshold collapses ALL", () => {
    const short = mkNode("short", 0, 0, 200, 1); // h = 68
    const tall = mkNode("tall", 0, nodeHeight(mkNode("short", 0, 0, 200, 1)), 200, 6); // h = 178
    const g = { nodes: [short, tall], edges: [] };
    // k=1: short 68px < collapseSnappedPx 84 → whole stack collapses,
    // even though tall (178px) is comfortably readable
    const rg = buildRenderGraph(g, 1);
    expect(rg.nodes.length).toBe(0);
    expect(rg.pseudo.length).toBe(1);
    expect(rg.pseudo[0]!.members.length).toBe(2);
  });

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

describe("RG monotonicity (zoom-out hysteresis)", () => {
  test("carried memberships keep a block together at a coarser scale", () => {
    // two eligible nodes too far apart to merge naturally
    const a = mkNode("a", 0, 0, 200, 1);
    const b = mkNode("b", 5000, 0, 200, 1);
    const g = { nodes: [a, b], edges: [] };
    const k = 0.5; // both unreadable (68px*0.5=34 < 56), gap 4800*0.5 huge
    const free = buildRenderGraph(g, k);
    expect(free.pseudo.length).toBe(2); // separate blocks normally
    const carried = buildRenderGraph(g, k, undefined, undefined, [["a", "b"]]);
    expect(carried.pseudo.length).toBe(1); // carry keeps them one block
    expect(carried.pseudo[0]!.members.length).toBe(2);
  });
});

describe("flow order", () => {
  test("pseudo members sort by data flow, not insertion order", () => {
    // insert REVERSED: sink first, source last
    const a = mkNode("a", 0, 0, 200, 1);
    const b = mkNode("b", 0, nodeHeight(mkNode("a", 0, 0, 200, 1)), 200, 1);
    for (const n of [a, b]) {
      n.outputs = [{ id: "o", label: "o", kind: "text" as const }];
      n.inputs = [{ id: "i", label: "i", kind: "text" as const }];
    }
    const g = {
      nodes: [b, a], // insertion order: b, a
      edges: [{ from: { node: "a", port: "o" }, to: { node: "b", port: "i" } }],
    };
    const rg = buildRenderGraph(g, 0.5); // flush stack collapses
    expect(rg.pseudo.length).toBe(1);
    // flow order: a (source) before b (sink) despite insertion order
    expect(rg.pseudo[0]!.members.map((m) => m.id)).toEqual(["a", "b"]);
    expect(rg.pseudo[0]!.title).toBe("a +1");
  });
});

describe("chain contraction", () => {
  test("middles contract into one link; endpoints stay", () => {
    // A → B → C → D → E, spread FAR apart (proximity would never merge);
    // middles are short, endpoints tall
    const A = mkNode("A", 0, 0, 200, 6); // tall, readable
    const B = mkNode("B", 900, 0, 200, 1); // short middles
    const C = mkNode("C", 1800, 0, 200, 1);
    const D = mkNode("D", 2700, 0, 200, 1);
    const E = mkNode("E", 3600, 0, 200, 6); // tall, readable
    for (const n of [A, B, C, D, E]) {
      n.outputs = [{ id: "o", label: "o", kind: "text" as const }];
      n.inputs = [{ id: "i", label: "i", kind: "text" as const }];
    }
    const g = {
      nodes: [A, B, C, D, E],
      edges: [
        { from: { node: "A", port: "o" }, to: { node: "B", port: "i" } },
        { from: { node: "B", port: "o" }, to: { node: "C", port: "i" } },
        { from: { node: "C", port: "o" }, to: { node: "D", port: "i" } },
        { from: { node: "D", port: "o" }, to: { node: "E", port: "i" } },
      ],
    };
    // k=0.7: middles (h=68 → 47.6px) unreadable; endpoints (178 → 125px) fine
    const rg = buildRenderGraph(g, 0.7);
    expect(rg.nodes.map((n) => n.id).sort()).toEqual(["A", "E"]);
    expect(rg.pseudo.length).toBe(1);
    expect(rg.pseudo[0]!.members.length).toBe(3);
    expect(rg.pseudo[0]!.title).toBe("⋯ ×3");
    // wiring: A → link → E
    const kinds = rg.edges.map((e) => `${e.from.at}->${e.to.at}`).sort();
    expect(kinds).toEqual(["node->pseudo", "pseudo->node"]);
  });
});

describe("pseudo size law", () => {
  test("merged blocks snap their size to their scale's grid", () => {
    const g = demoGraph();
    const rg = buildRenderGraph(g, 0.05); // one big block
    const p = rg.pseudo[0]!;
    const r = pseudoRect(p, 0.05);
    const stepW = sizeLayerStep(r.w, 8);
    const stepH = sizeLayerStep(r.h, 8);
    expect(Math.abs(r.w % stepW)).toBeCloseTo(0, 6);
    expect(Math.abs(r.h % stepH)).toBeCloseTo(0, 6);
    // integer 1..8 grids at its own layer
    expect(r.w / stepW).toBeGreaterThanOrEqual(1);
    expect(r.w / stepW).toBeLessThanOrEqual(8);
  });
});

describe("cascading RG", () => {
  test("a block overlapping a readable node absorbs it", () => {
    // two short nodes merge into an enclosure block; a readable tall node
    // sits INSIDE that enclosure → it must RG into the block too
    const a = mkNode("a", 0, 0, 200, 1); // short → collapses at k=0.7
    const b = mkNode("b", 0, 600, 200, 1); // short, far below (same cluster? no—too far)
    const c = mkNode("c", 40, 200, 200, 6); // tall (readable), between them
    // force a+b into one cluster via connection at close gap: instead place
    // them near each other vertically around c so the enclosure covers c
    a.y = 100; b.y = 420; // gap 252wu*0.7=176px > budgets... use flush chain:
    // simplest: snap a and b to c? Instead: make a and b flush-stacked pair
    // whose enclosure box (min size at k) overlaps c.
    b.x = 0; b.y = 100 + nodeHeight(a); // flush under a
    c.x = 40; c.y = 120; c.w = 200; // sits on top of the pair's enclosure
    const g = { nodes: [a, b, c], edges: [] };
    const rg = buildRenderGraph(g, 0.7);
    // c must be absorbed: no expanded nodes left, one block with all three
    expect(rg.nodes.length).toBe(0);
    expect(rg.pseudo.length).toBe(1);
    expect(rg.pseudo[0]!.members.length).toBe(3);
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

describe("data merge rules", () => {
  test("numeric reducers", () => {
    expect(aggregate(["0.5", "0.8", "0.3"], "max")).toBe("0.8");
    expect(aggregate(["0.5", "0.8", "0.3"], "min")).toBe("0.3");
    expect(aggregate(["1", "2", "3"], "sum")).toBe("6");
    expect(aggregate(["1", "2"], "mean")).toBe("1.5");
    expect(aggregate(["3", "1", "9"], "range")).toBe("1–9");
  });
  test("众数 mode works for text and numbers", () => {
    expect(aggregate(["ja", "en", "ja"], "mode")).toBe("ja ×2");
    expect(aggregate(["a", "b"], "mode")).toBe("a");
  });
  test("集合 set joins distinct values", () => {
    expect(aggregate(["mic-1", "mic-2", "mic-1"], "set")).toBe("mic-1, mic-2");
  });
  test("same / custom", () => {
    expect(aggregate(["x", "x"], "same")).toBe("x");
    expect(aggregate(["x", "y", "z"], "same")).toBe("mixed (3)");
    expect(aggregate(["a", "b"], (v) => v.join("|"))).toBe("a|b");
  });

  test("booleans are a lattice: OR ≡ max, AND ≡ min", () => {
    // max/min work directly on booleans, keeping the input vocabulary
    expect(aggregate(["on", "off"], "max")).toBe("on");
    expect(aggregate(["on", "off"], "min")).toBe("off");
    expect(aggregate(["true", "false"], "max")).toBe("true");
    expect(aggregate(["yes", "yes"], "min")).toBe("yes");
    // any/all are aliases
    expect(aggregate(["on", "off"], "any")).toBe("on");
    expect(aggregate(["on", "off"], "all")).toBe("off");
  });
  test("node-declared fieldRules win over host map and fallback", () => {
    const a = {
      ...mkNode("a", 0, 0),
      fields: [["score", "0.5"], ["vad", "off"]] as [string, string][],
      fieldRules: { score: "max" as const, vad: "any" as const },
    };
    const b = {
      ...mkNode("b", 0, 0),
      fields: [["score", "0.8"], ["vad", "on"]] as [string, string][],
    };
    // no host config at all — the node's own rules apply
    const out = fieldSummarize()([a, b], {
      collapsed: true,
      level: "pseudo",
      screen: { w: 200, h: 100 },
    });
    expect(out).toEqual({
      kind: "kv",
      rows: [["score", "0.8"], ["vad", "on"]],
    });
  });

  test("fieldSummarize merges member fields into kv rows", () => {
    const a = {
      ...mkNode("a", 0, 0),
      fields: [["lang", "ja"], ["score", "0.5"]] as [string, string][],
    };
    const b = {
      ...mkNode("b", 0, 0),
      fields: [["lang", "ja"], ["score", "0.8"]] as [string, string][],
    };
    const f = fieldSummarize({ score: "max" });
    const out = f([a, b], { collapsed: true, level: "pseudo", screen: { w: 200, h: 100 } });
    expect(out).toEqual({ kind: "kv", rows: [["lang", "ja ×2"], ["score", "0.8"]] });
  });
});

describe("merge combinators extend the simple rules", () => {
  test("ordered: severity 'worst' and time 'latest' are just max", () => {
    const worst = ordered(["ok", "warn", "error"]);
    expect(aggregate(["ok", "error", "warn"], worst)).toBe("error");
    const latest = ordered((v) => Date.parse(v), "max");
    expect(
      aggregate(["2026-01-01", "2026-07-08", "2025-12-31"], latest),
    ).toBe("2026-07-08");
  });
  test("median: plain rule, robust middle", () => {
    expect(aggregate(["1", "9", "5"], "median")).toBe("5");
    expect(aggregate(["1", "9"], "median")).toBe("5");
  });
  test("quantile: advanced combinator for the rare p95 case", () => {
    expect(
      parseFloat(aggregate(["1", "2", "3", "4", "100"], quantile(0.95))),
    ).toBeCloseTo(80.8, 6);
    expect(aggregate(["1", "9", "5"], quantile(0.5))).toBe("5");
  });
  test("topK: histogram generalizes mode", () => {
    const vals = ["en", "ja", "en", "de", "ja", "en"];
    expect(aggregate(vals, topK(2))).toBe("en ×3, ja ×2");
    expect(aggregate(vals, topK(1))).toBe(aggregate(vals, "mode"));
  });
});

describe("rg rule", () => {
  test("defaults are sane", () => {
    expect(DEFAULT_RULE.radix).toBe(8);
    expect(DEFAULT_RULE.clusterGapConnectedPx).toBeGreaterThan(
      DEFAULT_RULE.clusterGapPx,
    );
  });
});

describe("containment", () => {
  test("childrenOf / descendantsOf / containmentOf walk the hierarchy", () => {
    const g = orgChartGraph();
    expect(childrenOf(g, "team-eng").map((n) => n.id)).toEqual([
      "lead-eng",
      "eng-a",
      "eng-b",
    ]);
    // descendants of the company include people two levels down
    const all = descendantsOf(g, "company").map((n) => n.id);
    expect(all).toContain("team-eng");
    expect(all).toContain("eng-b");
    const { inside, related } = containmentOf(g.nodes);
    expect(inside("eng-a", "company")).toBe(true); // transitive
    expect(inside("company", "eng-a")).toBe(false); // directional
    expect(related("company", "eng-a")).toBe(true);
    expect(related("eng-a", "des-a")).toBe(false); // cousins are unrelated
  });

  test("org-chart demo obeys the node-size law", () => {
    for (const n of orgChartGraph().nodes) {
      expect(snapSizeRadix(n.w, 8)).toBe(n.w);
      expect(snapSizeRadix(nodeHeight(n), 8)).toBe(nodeHeight(n));
    }
  });

  test("teams absorb their people; the company frame stays expanded", () => {
    const g = orgChartGraph();
    // people (h=128) unreadable at k=0.4 (51px < 56); team frames (h=512)
    // still very readable (205px) — each team becomes ONE block named by
    // the team, and the company keeps rendering as a frame
    const rg = buildRenderGraph(g, 0.4);
    const titles = rg.pseudo.map((p) => p.title).sort();
    expect(titles).toContain("Engineering");
    expect(titles).toContain("Design");
    expect(rg.nodes.map((n) => n.id)).toContain("company");
    // the Engineering block holds the container AND its people
    const eng = rg.pseudo.find((p) => p.title === "Engineering")!;
    expect(eng.members.map((m) => m.id).sort()).toEqual(
      ["eng-a", "eng-b", "lead-eng", "team-eng"].sort(),
    );
  });

  test("zoomed far out, the company absorbs everything into one block", () => {
    const g = orgChartGraph();
    // team frames (h=512) unreadable at k=0.05 (26px < 56)
    const rg = buildRenderGraph(g, 0.05);
    expect(rg.pseudo.length).toBe(1);
    expect(rg.pseudo[0]!.title).toBe("Acme Inc.");
    expect(rg.nodes.length).toBe(0);
  });

  test("containment is a merge barrier: cousins never merge across teams", () => {
    // a and b sit 8 world units apart (4px at k=0.5) but belong to
    // DIFFERENT containers; each container also holds a big readable
    // sibling so neither container absorbs. Without the barrier the pair
    // would proximity-merge instantly.
    const nodes: GraphNode[] = [
      { ...mkNode("c1", 0, 0, 512, 0), h: 512 },
      { ...mkNode("c2", 5000, 0, 512, 0), h: 512 },
      { ...mkNode("a2", 64, 64, 128, 0), h: 256, parent: "c1" },
      { ...mkNode("b2", 5064, 64, 128, 0), h: 256, parent: "c2" },
      { ...mkNode("a", 2000, 600, 128, 1), parent: "c1" },
      { ...mkNode("b", 2136, 600, 128, 1), parent: "c2" },
    ];
    const rg = buildRenderGraph({ nodes, edges: [] }, 0.5);
    for (const p of rg.pseudo)
      expect(p.members.map((m) => m.id).sort()).not.toEqual(["a", "b"]);
    // control: strip the containment and the same geometry merges
    const flat = nodes.map((n) => ({ ...n, parent: undefined }));
    const free = buildRenderGraph({ nodes: flat, edges: [] }, 0.5);
    expect(
      free.pseudo.some((p) =>
        ["a", "b"].every((id) => p.members.some((m) => m.id === id)),
      ),
    ).toBe(true);
  });
});

describe("open kinds & categories", () => {
  test("built-ins keep their palette; unknown names get stable colors", () => {
    expect(kindColor("audio")).toBe(KIND_COLOR.audio!);
    const c = kindColor("report");
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(kindColor("report")).toBe(c); // deterministic
    expect(categoryColor("team")).toMatch(/^#[0-9a-f]{6}$/);
    expect(categoryColor("team")).not.toBe(categoryColor("member"));
  });
});

describe("panels: drag snap + boundary dissolution", () => {
  const rect = (id: string, x: number, y: number, w = 180, h = 100): PanelRect => ({
    panel: { id, title: id, items: [] } as Panel,
    x,
    y,
    w,
    h,
    itemsY: y + PANEL.headerH + PANEL.pad,
  });

  test("panelSnap: viewport margin, edge alignment and flush contact", () => {
    const size = { width: 800, height: 600 };
    // near the left margin → snaps onto it
    expect(panelSnap(9, 300, 180, 100, [], size).x).toBe(PANEL.margin);
    // beyond the threshold → untouched
    expect(panelSnap(40, 300, 180, 100, [], size)).toEqual({ x: 40, y: 300 });
    const o = rect("o", 200, 200);
    // dropping just below another panel → flush below + left edges align
    const snapped = panelSnap(195, 296, 180, 100, [o], size);
    expect(snapped).toEqual({ x: 200, y: 300 });
    // flush against the right side
    expect(panelSnap(385, 210, 180, 100, [o], size).x).toBe(380);
    // far away on the orthogonal axis → panel candidates don't apply
    expect(panelSnap(195, 500, 180, 100, [o], size).x).toBe(195);
  });

  test("panelCoverage: flush panels dissolve their shared border", () => {
    const a = rect("a", 100, 100, 180, 100);
    const b = rect("b", 100, 200, 180, 80); // flush below a
    const cov = panelCoverage([a, b]);
    expect(cov.get("a")!.bottom).toEqual([{ from: 100, to: 280 }]);
    expect(cov.get("b")!.top).toEqual([{ from: 100, to: 280 }]);
    // separated panels share nothing
    expect(panelCoverage([a, rect("c", 100, 320)]).size).toBe(0);
  });
});
