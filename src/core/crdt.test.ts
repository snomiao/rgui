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

  test("JSON round-trip preserves state (encoding is plain JSON)", () => {
    const s = newGraphCrdt({ progress: "max" });
    crdtAddNode(s, "a", "n1", { progress: 5 });
    const restored = JSON.parse(JSON.stringify(s)) as GraphCrdtState;
    crdtSetFields(restored, "b", "n1", { progress: 9 });
    expect(crdtToGraph(mergeGraphCrdt(s, restored)).nodes[0]!.fields.progress).toBe(9);
  });
});
