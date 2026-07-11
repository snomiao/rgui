import { describe, expect, test } from "bun:test";
import {
  crdtAddEdge,
  crdtAddNode,
  crdtEdgeId,
  crdtRemoveEdge,
  crdtRemoveNode,
  crdtSetFields,
  crdtToGraph,
  mergeGraphCrdt,
  newGraphCrdt,
  type GraphCrdtState,
} from "./crdt.js";

const clone = (s: GraphCrdtState): GraphCrdtState => JSON.parse(JSON.stringify(s));
const nodeIds = (s: GraphCrdtState) => crdtToGraph(s).nodes.map((n) => n.id).sort();
const view = (s: GraphCrdtState) => JSON.stringify(crdtToGraph(s));

describe("GraphCrdt", () => {
  test("basic add/set/materialize round-trip", () => {
    const s = newGraphCrdt();
    crdtAddNode(s, "a", "n1", { title: "one", x: 10 });
    crdtAddNode(s, "a", "n2");
    crdtAddEdge(s, "a", { node: "n1", port: "out" }, { node: "n2", port: "in" });
    const g = crdtToGraph(s);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(g.nodes.find((n) => n.id === "n1")?.fields.title).toBe("one");
    expect(g.edges).toEqual([
      { id: crdtEdgeId({ node: "n1", port: "out" }, { node: "n2", port: "in" }), from: { node: "n1", port: "out" }, to: { node: "n2", port: "in" } },
    ]);
  });

  test("merge is commutative, associative, idempotent (materialized view)", () => {
    const base = newGraphCrdt();
    crdtAddNode(base, "a", "n1", { title: "base" });
    const ra = clone(base);
    const rb = clone(base);
    const rc = clone(base);
    crdtSetFields(ra, "a", "n1", { title: "from-a" });
    crdtAddNode(rb, "b", "n2", { title: "b-node" });
    crdtRemoveNode(rc, "n1");
    crdtAddNode(rc, "c", "n3");

    const ab = mergeGraphCrdt(ra, rb);
    const ba = mergeGraphCrdt(rb, ra);
    expect(view(ab)).toBe(view(ba));

    const abc1 = mergeGraphCrdt(mergeGraphCrdt(ra, rb), rc);
    const abc2 = mergeGraphCrdt(ra, mergeGraphCrdt(rb, rc));
    expect(view(abc1)).toBe(view(abc2));

    expect(view(mergeGraphCrdt(ab, ab))).toBe(view(ab));
  });

  test("concurrent add wins over remove", () => {
    const base = newGraphCrdt();
    crdtAddNode(base, "a", "n1");
    const ra = clone(base);
    const rb = clone(base);
    crdtRemoveNode(ra, "n1");
    crdtAddNode(rb, "b", "n1", { title: "revived-concurrently" }); // re-add = fresh dot
    const m = mergeGraphCrdt(ra, rb);
    expect(nodeIds(m)).toEqual(["n1"]);
  });

  test("observed remove wins when the remover has seen the add", () => {
    const ra = newGraphCrdt();
    crdtAddNode(ra, "a", "n1");
    const rb = mergeGraphCrdt(newGraphCrdt(), ra); // b observed the add
    crdtRemoveNode(rb, "n1");
    const m = mergeGraphCrdt(ra, rb);
    expect(nodeIds(m)).toEqual([]);
  });

  test("re-add after remove revives with last-known fields", () => {
    const s = newGraphCrdt();
    crdtAddNode(s, "a", "n1", { title: "keep-me" });
    crdtRemoveNode(s, "n1");
    expect(nodeIds(s)).toEqual([]);
    crdtAddNode(s, "a", "n1");
    expect(crdtToGraph(s).nodes[0]).toEqual({ id: "n1", fields: { title: "keep-me" } });
  });

  test("field conflict resolves by deterministic Lamport LWW on both replicas", () => {
    const base = newGraphCrdt();
    crdtAddNode(base, "a", "n1", { title: "base" });
    const ra = clone(base);
    const rb = clone(base);
    crdtSetFields(ra, "a", "n1", { title: "alpha" });
    crdtSetFields(rb, "b", "n1", { title: "beta" });
    const winner = crdtToGraph(mergeGraphCrdt(ra, rb)).nodes[0]!.fields.title;
    expect(winner).toBe(crdtToGraph(mergeGraphCrdt(rb, ra)).nodes[0]!.fields.title);
    expect(winner).toBe("beta"); // equal seq → higher actor id wins
  });

  test("typed semilattice joins: max and any", () => {
    const mk = () => newGraphCrdt({ progress: "max", alarm: "any" });
    const base = mk();
    crdtAddNode(base, "a", "n1", { progress: 1, alarm: false });
    const ra = clone(base);
    const rb = clone(base);
    crdtSetFields(ra, "a", "n1", { progress: 7, alarm: false });
    crdtSetFields(rb, "b", "n1", { progress: 3, alarm: true });
    const f = crdtToGraph(mergeGraphCrdt(ra, rb)).nodes[0]!.fields;
    expect(f.progress).toBe(7); // max, not LWW
    expect(f.alarm).toBe(true); // any, sticky-or
  });

  test("merge throws on join-schema mismatch", () => {
    const ra = newGraphCrdt({ progress: "max" });
    const rb = newGraphCrdt({ progress: "min" });
    expect(() => mergeGraphCrdt(ra, rb)).toThrow(/schema mismatch/);
  });

  test("edges dangle-filter: hidden while an endpoint is removed, back on revive", () => {
    const s = newGraphCrdt();
    crdtAddNode(s, "a", "n1");
    crdtAddNode(s, "a", "n2");
    crdtAddEdge(s, "a", { node: "n1", port: "out" }, { node: "n2", port: "in" });
    crdtRemoveNode(s, "n2");
    expect(crdtToGraph(s).edges).toHaveLength(0);
    crdtAddNode(s, "a", "n2");
    expect(crdtToGraph(s).edges).toHaveLength(1);
    crdtRemoveEdge(s, { node: "n1", port: "out" }, { node: "n2", port: "in" });
    expect(crdtToGraph(s).edges).toHaveLength(0);
  });

  test("randomized 3-replica convergence", () => {
    // deterministic pseudo-random walk (no Math.random in tests either)
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const base = newGraphCrdt({ n: "max" });
    const replicas = [clone(base), clone(base), clone(base)];
    const actors = ["a", "b", "c"];
    for (let i = 0; i < 120; i++) {
      const r = Math.floor(rnd() * 3);
      const s = replicas[r]!;
      const op = rnd();
      const id = `n${Math.floor(rnd() * 8)}`;
      if (op < 0.45) crdtAddNode(s, actors[r]!, id, { n: Math.floor(rnd() * 100) });
      else if (op < 0.65) crdtRemoveNode(s, id);
      else if (op < 0.85) crdtSetFields(s, actors[r]!, id, { n: Math.floor(rnd() * 100) });
      else crdtAddEdge(s, actors[r]!, { node: id, port: "out" }, { node: `n${Math.floor(rnd() * 8)}`, port: "in" });
    }
    const total1 = mergeGraphCrdt(mergeGraphCrdt(replicas[0]!, replicas[1]!), replicas[2]!);
    const total2 = mergeGraphCrdt(replicas[2]!, mergeGraphCrdt(replicas[1]!, replicas[0]!));
    const total3 = mergeGraphCrdt(mergeGraphCrdt(replicas[1]!, replicas[2]!), replicas[0]!);
    expect(view(total1)).toBe(view(total2));
    expect(view(total1)).toBe(view(total3));
  });

  test("join-typed fields reject mistyped writes (associativity guard)", () => {
    const s = newGraphCrdt({ score: "max", ok: "all" });
    crdtAddNode(s, "a", "n1");
    expect(() => crdtSetFields(s, "a", "n1", { score: "oops" as never })).toThrow(/finite number/);
    expect(() => crdtSetFields(s, "a", "n1", { score: NaN })).toThrow(/finite number/);
    expect(() => crdtSetFields(s, "a", "n1", { ok: 1 as never })).toThrow(/boolean/);
    // corrupt imported state (mistyped join value smuggled past the API)
    const rb = clone(s);
    crdtSetFields(s, "a", "n1", { score: 5 });
    rb.nodes.n1!.fields.score = { value: "corrupt", dot: { actor: "z", seq: 99 } };
    expect(() => mergeGraphCrdt(s, rb)).toThrow(/mistyped/);
  });

  test("non-JSON values are rejected at write time", () => {
    const s = newGraphCrdt();
    crdtAddNode(s, "a", "n1");
    expect(() => crdtSetFields(s, "a", "n1", { bad: undefined as never })).toThrow(/non-JSON/);
    expect(() => crdtSetFields(s, "a", "n1", { bad: (() => 1) as never })).toThrow(/non-JSON/);
    expect(() => crdtSetFields(s, "a", "n1", { bad: Infinity })).toThrow(/non-finite/);
    expect(() => crdtSetFields(s, "a", "n1", { bad: { nested: [1, NaN] } })).toThrow(/non-finite/);
    // failed writes must not partially apply
    expect(crdtToGraph(s).nodes[0]!.fields.bad).toBeUndefined();
  });

  test("edge ids stay injective for hostile node/port strings", () => {
    const s = newGraphCrdt();
    for (const id of ["n", "r", "m", "p->m:q"]) crdtAddNode(s, "a", id);
    const e1 = crdtAddEdge(s, "a", { node: "n", port: "p->m:q" }, { node: "r", port: "s" });
    const e2 = crdtAddEdge(s, "a", { node: "n", port: "p" }, { node: "m", port: "q->r:s" });
    expect(e1).not.toBe(e2);
    expect(crdtToGraph(s).edges).toHaveLength(2);
    const round = crdtToGraph(s).edges.find((e) => e.id === e1)!;
    expect(round.from).toEqual({ node: "n", port: "p->m:q" });
  });

  test("setFields on a removed node is a lost update (documented policy)", () => {
    const base = newGraphCrdt();
    crdtAddNode(base, "a", "n1", { title: "v1" });
    const ra = clone(base);
    const rb = clone(base);
    crdtRemoveNode(ra, "n1");
    crdtSetFields(ra, "a", "n1", { title: "after-remove" }); // no-op: dead locally
    crdtAddNode(rb, "b", "n1"); // concurrent revive
    const m = mergeGraphCrdt(ra, rb);
    expect(crdtToGraph(m).nodes[0]!.fields.title).toBe("v1"); // write was lost
  });

  test("covered dot does not resurrect via a third replica after record drop", () => {
    const ra = newGraphCrdt();
    crdtAddNode(ra, "a", "n1"); // no fields → removal can drop the record entirely
    const rb = mergeGraphCrdt(newGraphCrdt(), ra);
    crdtRemoveNode(rb, "n1");
    const rbCompact = mergeGraphCrdt(rb, newGraphCrdt()); // record dropped, clock kept
    expect(rbCompact.nodes.n1).toBeUndefined();
    const rc = mergeGraphCrdt(newGraphCrdt(), rbCompact); // third replica, late joiner
    expect(nodeIds(mergeGraphCrdt(ra, rc))).toEqual([]); // covered dot stays dead
    expect(nodeIds(mergeGraphCrdt(rc, ra))).toEqual([]);
  });

  test("join associativity with missing registers, all four rules", () => {
    const joins = { hi: "max", lo: "min", any: "any", all: "all" } as const;
    const base = newGraphCrdt(joins);
    crdtAddNode(base, "a", "n1", { hi: 5, lo: 5, any: false, all: true });
    const reps = [clone(base), clone(base), clone(base)];
    crdtSetFields(reps[0]!, "a", "n1", { hi: 9, lo: 2 });
    crdtSetFields(reps[1]!, "b", "n1", { any: true });
    crdtSetFields(reps[2]!, "c", "n1", { hi: 7, all: false, lo: 8 });
    const m1 = mergeGraphCrdt(mergeGraphCrdt(reps[0]!, reps[1]!), reps[2]!);
    const m2 = mergeGraphCrdt(reps[0]!, mergeGraphCrdt(reps[1]!, reps[2]!));
    const m3 = mergeGraphCrdt(mergeGraphCrdt(reps[2]!, reps[0]!), reps[1]!);
    expect(view(m1)).toBe(view(m2));
    expect(view(m1)).toBe(view(m3));
    const f = crdtToGraph(m1).nodes[0]!.fields;
    expect(f).toEqual({ all: false, any: true, hi: 9, lo: 2 });
  });

  test("JSON round-trip preserves state (encoding is plain JSON)", () => {
    const s = newGraphCrdt({ progress: "max" });
    crdtAddNode(s, "a", "n1", { progress: 5 });
    const restored = JSON.parse(JSON.stringify(s)) as GraphCrdtState;
    crdtSetFields(restored, "b", "n1", { progress: 9 });
    expect(crdtToGraph(mergeGraphCrdt(s, restored)).nodes[0]!.fields.progress).toBe(9);
  });
});
