import { expect, test } from "bun:test";
import { dur, fitView, paceOf, panBy, segmentsOf, stateOf, toT, toX, zoomAt } from "./model";

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
