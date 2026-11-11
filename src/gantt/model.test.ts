import { expect, test } from "bun:test";
import { treeOrder, categorize, categoryOf, dur, fitView, paceOf, panBy, segmentsOf, stateOf, toT, toX, zoomAt } from "./model";

test("zoomAt keeps the time under the cursor", () => {
  const v = { t0: 1000, spp: 10 },
    z = zoomAt(v, 300, 2);
  expect(toT(z, 300)).toBe(toT(v, 300));
  expect(z.spp).toBe(5);
});
test("panBy moves later for positive dx", () => {
  expect(panBy({ t0: 0, spp: 2 }, 50).t0).toBe(100);
});
test("fitView spans lo..hi", () => {
  const v = fitView(0, 1000, 148, 24);
  expect(Math.round(toX(v, 1000))).toBe(124);
});
test("open bar past its ETA gets a late segment", () => {
  const b = { id: "/x", lane: "l", a: 0, due: 100 };
  expect(stateOf(b)).toBe("open");
  expect(segmentsOf(b, 150).map((s) => s.part)).toEqual(["core", "late"]);
});
test("planned bar: range lo..hi plus solid core", () => {
  const b = { id: "/x", lane: "l", a: 10, due: 100, planned: true, loA: 0, lo: 50 };
  expect(segmentsOf(b, 0).map((s) => s.part)).toEqual(["range", "core"]);
});

test("dur: language-free units", () => {
  expect(dur(300)).toBe("5M");
  expect(dur(-300)).toBe("-5M");
  expect(dur(5400)).toBe("1.5H");
  expect(dur(400 * 86400)).toBe("1.1Y");
  expect(dur(20)).toBe("0M");
});

test("paceOf: underline tip against now", () => {
  const b = { id: "x", lane: "l", a: 0, due: 36000 };
  expect(paceOf({ ...b, progress: 0.1 }, 18000)).toBe("behind");
  expect(paceOf({ ...b, progress: 0.9 }, 18000)).toBe("ahead");
  expect(paceOf({ ...b, progress: 0.5 }, 18000)).toBe("on");
  expect(paceOf(b, 18000)).toBeUndefined();
});

test("categorize: a category without its own bar gets a group row, members follow it", () => {
  const b = (id: string, a: number, due: number, x: object = {}) => ({ id, lane: "l", a, due, ...x });
  const out = categorize([
    b("/l/ui/a", 0, 10, { b: 10, outcome: "verified" }),
    b("/l/solo", 5, 20),
    b("/l/ui/b", 3, 30),
  ]);
  expect(out.map((x) => x.id)).toEqual(["/l/ui", "/l/ui/a", "/l/ui/b", "/l/solo"]);
  expect(out[0]).toMatchObject({ a: 0, due: 30, group: { n: 2, open: 1 } });
  expect((out[0] as { b?: number }).b).toBeUndefined();
  expect(categoryOf("/l/ui/a")).toBe("/l/ui");
  expect(categoryOf("/l/solo")).toBeUndefined();
});

test("categorize: a one-member category gets no group row", () => {
  const out = categorize([{ id: "/l/x/only", lane: "l", a: 0, due: 1 }]);
  expect(out.map((x) => x.id)).toEqual(["/l/x/only"]);
});

test("treeOrder: children sit right under their parent, in order, with depth", () => {
  const r = (id: string) => ({ id, lane: "l", a: 0, due: 1 });
  const out = treeOrder([r("/l/b/x"), r("/l/a"), r("/l/b"), r("/l/a/1"), r("/l/b/x/y"), r("/l/a/2")]);
  expect(out.map((x) => `${x.depth}${x.bar.id}`)).toEqual([
    "0/l/a", "1/l/a/1", "1/l/a/2", "0/l/b", "1/l/b/x", "2/l/b/x/y",
  ]);
});
