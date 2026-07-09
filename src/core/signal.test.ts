import { describe, expect, test } from "bun:test";
import { aggregate } from "./aggregate.js";
import type { Edge, Graph, GraphNode, Port } from "./graph.js";
import {
  type Atomizer,
  SIGNALS,
  allowedMerges,
  checkSignals,
  defaultMerge,
  forkValue,
  isConserved,
  isMergeLegal,
  normalizeWeights,
  port,
  portMerge,
  resolveSignal,
  routeIndex,
  splitAtoms,
  splitLines,
  splitQuantity,
} from "./signal.js";

const node = (id: string, inputs: Port[], outputs: Port[]): GraphNode => ({
  id,
  title: id,
  category: "model",
  x: 0,
  y: 0,
  w: 128,
  inputs,
  outputs,
  fields: [],
});
const wire = (fn: string, fp: string, tn: string, tp: string): Edge => ({
  from: { node: fn, port: fp },
  to: { node: tn, port: tp },
});

describe("defaults are the safe, backward-compatible choice", () => {
  test("an unmarked port copies and refuses to sum", () => {
    const s = resolveSignal({ id: "a", label: "a", kind: "text" });
    expect(s.fanout).toBe("copy");
    expect(s.measure).toBe("intensive");
    expect(isConserved(s)).toBe(false);
  });
});

describe("merge legality — only sum/concat are gated", () => {
  test("sum and concat are illegal on an intensive port", () => {
    expect(isMergeLegal("sum", "intensive")).toBe(false);
    expect(isMergeLegal("concat", "intensive")).toBe(false);
    expect(isMergeLegal("sum", "extensive")).toBe(true);
    expect(isMergeLegal("concat", "extensive")).toBe(true);
  });

  test("every selection and affine rule is legal on both measures", () => {
    // positions are a torsor: mean/median are affine combinations (coefficients
    // sum to 1) and so remain meaningful; only `+` is undefined.
    for (const r of [
      "mean",
      "median",
      "min",
      "max",
      "mode",
      "set",
      "first",
      "last",
      "same",
      "count",
    ] as const) {
      expect(isMergeLegal(r, "intensive")).toBe(true);
      expect(isMergeLegal(r, "extensive")).toBe(true);
    }
  });

  test("custom reducers opt out of the check", () => {
    expect(isMergeLegal((v) => v.join("|"), "intensive")).toBe(true);
  });

  test("allowedMerges omits exactly the additive rules for intensive", () => {
    const ext = allowedMerges("extensive");
    const int = allowedMerges("intensive");
    expect(ext).toContain("sum");
    expect(ext).toContain("concat");
    expect(int).not.toContain("sum");
    expect(int).not.toContain("concat");
    expect(ext.length - int.length).toBe(2);
  });
});

describe("default fan-in rule follows the carrier", () => {
  test("extensive text/audio concatenate; other extensive carriers sum", () => {
    expect(defaultMerge("text", "extensive")).toBe("concat");
    expect(defaultMerge("audio", "extensive")).toBe("concat");
    expect(defaultMerge("ctl", "extensive")).toBe("sum");
  });
  test("intensive takes the latest value (sflow's toLatests)", () => {
    expect(defaultMerge("text", "intensive")).toBe("last");
    expect(defaultMerge("image", "intensive")).toBe("last");
  });
  test("an explicit merge overrides the default", () => {
    expect(portMerge(port("t", "t", SIGNALS.transcript))).toBe("concat");
    expect(portMerge({ ...port("t", "t", SIGNALS.transcript), merge: "set" })).toBe("set");
  });
});

describe("concat merge rule", () => {
  test("joins successive segments end to end", () => {
    expect(aggregate(["hello ", "world"], "concat")).toBe("hello world");
  });
  test("differs from set, which dedupes and comma-joins", () => {
    expect(aggregate(["a", "a", "b"], "concat")).toBe("aab");
    expect(aggregate(["a", "a", "b"], "set")).toBe("a, b");
  });
});

describe("weights", () => {
  test("absent, mismatched, or degenerate weights fall back to even", () => {
    expect(normalizeWeights(4)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(normalizeWeights(2, [1, 2, 3])).toEqual([0.5, 0.5]);
    expect(normalizeWeights(2, [0, 0])).toEqual([0.5, 0.5]);
  });
  test("normalizes to sum 1", () => {
    const w = normalizeWeights(3, [1, 2, 1]);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(w).toEqual([0.25, 0.5, 0.25]);
  });
  test("n <= 0 yields nothing", () => {
    expect(normalizeWeights(0)).toEqual([]);
  });
});

describe("splitQuantity — conservation is exact", () => {
  test("even split", () => {
    expect(splitQuantity(100, [1, 1, 1, 1])).toEqual([25, 25, 25, 25]);
  });
  test("weighted split", () => {
    expect(splitQuantity(100, [1, 3])).toEqual([25, 75]);
  });
  test("parts sum back to the whole even when the fractions do not close", () => {
    // 1/3 each: the naive `total * w` leaks 1e-14. The last part absorbs it.
    const parts = splitQuantity(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });
  test("conservation holds across a fuzz of totals and weights", () => {
    for (let t = 1; t <= 40; t++) {
      const parts = splitQuantity(t * 7.3, [1, 2, 3, t]);
      expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(t * 7.3, 9);
    }
  });
});

describe("splitAtoms — whole atoms, count conserved", () => {
  const items = [1, 2, 3, 4, 5, 6, 7];

  test("no atom is cut and none is lost or duplicated", () => {
    const parts = splitAtoms(items, [1, 1, 1]);
    expect(parts.flat()).toEqual(items);
    expect(parts.reduce((a, p) => a + p.length, 0)).toBe(items.length);
  });

  test("largest-remainder apportionment hands leftovers to the biggest fractions", () => {
    // 7 atoms over 3 even shares → 2.333 each; the two largest remainders win
    expect(splitAtoms(items, [1, 1, 1]).map((p) => p.length)).toEqual([3, 2, 2]);
  });

  test("weighted apportionment", () => {
    expect(splitAtoms(items, [3, 1]).map((p) => p.length)).toEqual([5, 2]);
  });

  test("fewer atoms than downstreams leaves some empty-handed", () => {
    const parts = splitAtoms([1, 2], [1, 1, 1]);
    expect(parts.map((p) => p.length)).toEqual([1, 1, 0]);
    expect(parts.flat()).toEqual([1, 2]);
  });

  test("count is conserved for every shape", () => {
    for (let n = 1; n <= 6; n++)
      for (let k = 0; k <= 20; k++) {
        const atoms = Array.from({ length: k }, (_, i) => i);
        const parts = splitAtoms(atoms, Array.from({ length: n }, (_, i) => i + 1));
        expect(parts.flat()).toEqual(atoms);
      }
  });
});

describe("splitLines — the 'line' atom boundary", () => {
  test("keeps the newline with its line and never cuts mid-line", () => {
    expect(splitLines('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}\n', '{"b":2}\n']);
  });
  test("a trailing partial line stays whole", () => {
    expect(splitLines("a\nb")).toEqual(["a\n", "b"]);
  });
  test("empty text has no atoms", () => {
    expect(splitLines("")).toEqual([]);
  });
});

describe("routeIndex — fair round robin", () => {
  test("cycles through the downstreams", () => {
    expect([0, 1, 2, 3, 4].map((s) => routeIndex(s, 3))).toEqual([0, 1, 2, 0, 1]);
  });
  test("handles a single downstream and a negative seq", () => {
    expect(routeIndex(7, 1)).toBe(0);
    expect(routeIndex(-1, 3)).toBe(2);
  });
});

describe("forkValue — the three fan-out modes", () => {
  test("copy broadcasts the identical value: a->b and a->c both see (3,4,5)", () => {
    const coord = { x: 3, y: 4, z: 5 };
    const [b, c] = forkValue(coord, resolveSignal(port("p", "p", SIGNALS.coord)), 2);
    expect(b).toBe(coord);
    expect(c).toBe(coord);
  });

  test("an STT transcript is EXTENSIVE yet still broadcasts — it is a fact, not a resource", () => {
    // the single-axis 'change ⇒ split' story would round-robin this sentence to
    // one downstream. Both the translator and the subtitle sink need all of it.
    const s = resolveSignal(port("t", "t", SIGNALS.transcript));
    expect(s.measure).toBe("extensive");
    expect(forkValue("こんにちは、世界", s, 2)).toEqual([
      "こんにちは、世界",
      "こんにちは、世界",
    ]);
  });

  test("split of a continuous budget conserves the total", () => {
    const s = resolveSignal(port("b", "b", SIGNALS.budget));
    const parts = forkValue(120, s, 3) as number[];
    expect(parts).toEqual([40, 40, 40]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(120);
  });

  test("split honors weights", () => {
    const s = resolveSignal(port("b", "b", SIGNALS.budget));
    expect(forkValue(100, s, 2, { weights: [1, 4] })).toEqual([20, 80]);
  });

  test("split of jsonl cuts at line boundaries, never mid-line", () => {
    const s = resolveSignal(port("j", "j", SIGNALS.jsonl));
    const jsonl = '{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n';
    const parts = forkValue(jsonl, s, 2) as string[];
    expect(parts).toEqual(['{"a":1}\n{"b":2}\n', '{"c":3}\n{"d":4}\n']);
    // conservation: reassembling the parts reproduces the whole
    expect(parts.join("")).toBe(jsonl);
    // and every part is itself valid JSONL
    for (const p of parts)
      for (const line of p.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  test("an odd number of lines still splits only at boundaries", () => {
    const s = resolveSignal(port("j", "j", SIGNALS.jsonl));
    const parts = forkValue("a\nb\nc\n", s, 2) as string[];
    expect(parts).toEqual(["a\nb\n", "c\n"]);
    expect(parts.join("")).toBe("a\nb\nc\n");
  });

  test("route sends the whole chunk to exactly one downstream", () => {
    const s = resolveSignal(port("w", "w", SIGNALS.work));
    expect(forkValue("job-1", s, 3, { seq: 0 })).toEqual(["job-1", undefined, undefined]);
    expect(forkValue("job-2", s, 3, { seq: 1 })).toEqual([undefined, "job-2", undefined]);
    expect(forkValue("job-4", s, 3, { seq: 3 })).toEqual(["job-4", undefined, undefined]);
  });

  test("route never duplicates: exactly one slot is filled", () => {
    const s = resolveSignal(port("w", "w", SIGNALS.work));
    for (let seq = 0; seq < 10; seq++) {
      const slots = forkValue({ job: seq }, s, 4, { seq });
      expect(slots.filter((x) => x !== undefined)).toHaveLength(1);
    }
  });

  test("splitting a non-numeric continuous value is refused, not guessed", () => {
    const s = resolveSignal({
      id: "x",
      label: "x",
      kind: "image",
      measure: "extensive",
      fanout: "split",
      grain: "continuous",
    });
    expect(() => forkValue({ pixels: 1 }, s, 2)).toThrow(TypeError);
  });

  test("fanning out to zero downstreams yields nothing", () => {
    expect(forkValue(1, resolveSignal(port("b", "b", SIGNALS.budget)), 0)).toEqual([]);
  });

  const rowPort = resolveSignal({
    id: "r",
    label: "r",
    kind: "text",
    measure: "extensive",
    fanout: "split",
    grain: "atom",
    atom: "row",
  });

  test("an array of rows splits into whole rows by default", () => {
    expect(forkValue([1, 2, 3, 4], rowPort, 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("a custom atomizer overrides the defaults", () => {
    // atoms need not share the value's type: here the value is a string and the
    // atoms are its comma-separated records
    const csv: Atomizer<string, string> = {
      atoms: (v) => v.split(","),
      join: (parts) => parts.join(","),
    };
    expect(forkValue("a,b,c,d", rowPort, 2, { atomizer: csv })).toEqual(["a,b", "c,d"]);
  });

  test("split at atom grain refuses a value it cannot take apart", () => {
    expect(() => forkValue({ opaque: true }, rowPort, 2)).toThrow(TypeError);
  });

  test("joining the parts of any atom split reproduces the whole", () => {
    for (let n = 1; n <= 4; n++) {
      const parts = forkValue("a\nb\nc\nd\ne\n", rowPort, n) as string[];
      expect(parts.join("")).toBe("a\nb\nc\nd\ne\n");
    }
  });
});

describe("checkSignals", () => {
  test("a clean graph is silent", () => {
    const g: Graph = {
      nodes: [
        node("stt", [], [port("t", "transcript", SIGNALS.transcript)]),
        node("tr", [port("t", "text", SIGNALS.transcript)], []),
      ],
      edges: [wire("stt", "t", "tr", "t")],
    };
    expect(checkSignals(g)).toEqual([]);
  });

  test("summing an intensive port is an ERROR — the load-bearing check", () => {
    const bad: Port = { ...port("c", "coord", SIGNALS.coord), merge: "sum" };
    const g: Graph = { nodes: [node("n", [bad], [])], edges: [] };
    const d = checkSignals(g);
    expect(d).toHaveLength(1);
    expect(d[0]!.code).toBe("sum-on-state");
    expect(d[0]!.severity).toBe("error");
  });

  test("averaging an intensive port is fine — a centroid is an affine combination", () => {
    const ok: Port = { ...port("c", "coord", SIGNALS.coord), merge: "mean" };
    const g: Graph = { nodes: [node("n", [ok], [])], edges: [] };
    expect(checkSignals(g)).toEqual([]);
  });

  test("an unmerged fan-in warns and names the default it will use", () => {
    const g: Graph = {
      nodes: [
        node("a", [], [port("o", "o", SIGNALS.transcript)]),
        node("b", [], [port("o", "o", SIGNALS.transcript)]),
        node("c", [port("i", "i", SIGNALS.transcript)], []),
      ],
      edges: [wire("a", "o", "c", "i"), wire("b", "o", "c", "i")],
    };
    const d = checkSignals(g);
    expect(d.map((x) => x.code)).toEqual(["unmerged-fan-in"]);
    expect(d[0]!.message).toContain("concat");
  });

  test("a single edge into a port does not warn", () => {
    const g: Graph = {
      nodes: [
        node("a", [], [port("o", "o", SIGNALS.transcript)]),
        node("c", [port("i", "i", SIGNALS.transcript)], []),
      ],
      edges: [wire("a", "o", "c", "i")],
    };
    expect(checkSignals(g)).toEqual([]);
  });

  test("mismatched kinds across a wire warn", () => {
    const g: Graph = {
      nodes: [
        node("a", [], [port("o", "o", SIGNALS.pcm)]),
        node("b", [port("i", "i", SIGNALS.frame)], []),
      ],
      edges: [wire("a", "o", "b", "i")],
    };
    expect(checkSignals(g).map((d) => d.code)).toContain("kind-mismatch");
  });

  test("broadcasting into a consumer that conserves is a double-spend warning", () => {
    const g: Graph = {
      nodes: [
        // an output that copies…
        node("mint", [], [{ id: "o", label: "coins", kind: "ctl" }]),
        // …feeding a port that treats its input as an exclusive resource
        node("wallet", [port("i", "coins", SIGNALS.lease)], []),
      ],
      edges: [wire("mint", "o", "wallet", "i")],
    };
    expect(checkSignals(g).map((d) => d.code)).toContain("copied-resource");
  });

  test("grain without a split, and an atom without grain, both warn", () => {
    const g: Graph = {
      nodes: [
        node(
          "n",
          [{ id: "i", label: "i", kind: "text", grain: "atom", atom: "line" }],
          [{ id: "o", label: "o", kind: "text", atom: "line" }],
        ),
      ],
      edges: [],
    };
    const codes = checkSignals(g).map((d) => d.code);
    expect(codes).toContain("grain-without-split");
    expect(codes).toContain("atom-without-grain");
  });

  test("a split fan-out with no grain warns and assumes continuous", () => {
    const p: Port = {
      id: "o",
      label: "o",
      kind: "ctl",
      measure: "extensive",
      fanout: "split",
    };
    const g: Graph = {
      nodes: [
        node("a", [], [p]),
        node("b", [{ id: "i", label: "i", kind: "ctl" }], []),
        node("c", [{ id: "i", label: "i", kind: "ctl" }], []),
      ],
      edges: [wire("a", "o", "b", "i"), wire("a", "o", "c", "i")],
    };
    const d = checkSignals(g).filter((x) => x.code === "grain-without-split");
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toContain("continuous");
  });

  test("edges naming ports that do not exist are ignored, not crashed on", () => {
    const g: Graph = {
      nodes: [node("a", [], [])],
      edges: [wire("a", "nope", "ghost", "also-nope")],
    };
    expect(() => checkSignals(g)).not.toThrow();
    expect(checkSignals(g)).toEqual([]);
  });
});

describe("the 2×2 the presets span", () => {
  test("measure and fanout vary independently", () => {
    const cell = (p: { measure: string; fanout: string }) => `${p.measure}/${p.fanout}`;
    expect(cell(SIGNALS.transcript)).toBe("extensive/copy");
    expect(cell(SIGNALS.coord)).toBe("intensive/copy");
    expect(cell(SIGNALS.budget)).toBe("extensive/split");
    expect(cell(SIGNALS.lease)).toBe("intensive/route");
  });

  test("a counter is additive across shards yet copied on fan-out", () => {
    // the counterexample that breaks the single-axis model
    const counter: Port = {
      id: "n",
      label: "requests",
      kind: "ctl",
      measure: "extensive",
      fanout: "copy",
    };
    const s = resolveSignal(counter);
    expect(isMergeLegal("sum", s.measure)).toBe(true); // sum across shards ✓
    expect(forkValue(1523, s, 2)).toEqual([1523, 1523]); // copied, not halved ✓
  });
});
