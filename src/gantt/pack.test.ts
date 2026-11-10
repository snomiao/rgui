import { expect, test } from "bun:test";
import { packSlices } from "./native";

test("packSlices: overlapping sub-tasks get separate sub-lanes, others reuse them", () => {
  const k = (id: string, a: number, b: number) => ({ id, lane: "l", a, due: b, b, outcome: "verified" });
  const r = packSlices([k("p/1", 0, 10), k("p/2", 5, 15), k("p/3", 12, 20)], 100);
  expect(r.n).toBe(2);
  expect(r.slices.map((s) => s.k)).toEqual([0, 1, 0]);
});
