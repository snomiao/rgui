import { expect, test } from "bun:test";
import { openSpp, packSlices } from "./core";

test("packSlices: overlapping sub-tasks get separate sub-lanes, others reuse them", () => {
  const k = (id: string, a: number, b: number) => ({ id, lane: "l", a, due: b, b, outcome: "verified" });
  const r = packSlices([k("p/1", 0, 10), k("p/2", 5, 15), k("p/3", 12, 20)], 100);
  expect(r.n).toBe(2);
  expect(r.slices.map((s) => s.k)).toEqual([0, 1, 0]);
});

test("openSpp: P95 span of the soonest-ending open task and neighbours fills 3/4 width", () => {
  const now = 10000,
    b = (id: string, a: number, due: number) => ({ id, lane: "l", a, due });
  const spp = openSpp([b("x", 9000, 12000), b("y", 8000, 11000), b("z", 0, 99999)], now, 800)!;
  expect(spp).toBeCloseTo(99999 / 600);
  expect(openSpp([], now, 800)).toBeUndefined();
});
