import { describe, expect, test } from "bun:test";
import { depthPlanePanScale, directionalFocusTarget, type FocusCandidate } from "./navigation.js";

const cells: FocusCandidate[] = [
  { id: 0, x: 0, y: 0, depth: 0.5 },
  { id: 1, x: -1, y: 0, depth: 0.5 },
  { id: 2, x: 1, y: 0, depth: 0.5 },
  { id: 3, x: 0, y: 1, depth: 0.5 },
  { id: 4, x: 0, y: -1, depth: 0.5 },
  { id: 5, x: 0.1, y: 0, depth: 0.9 },
  { id: 6, x: -0.1, y: 0, depth: 0.1 },
];

describe("cube keyboard focus navigation", () => {
  test("HJKL directions follow projected screen coordinates", () => {
    expect(directionalFocusTarget(cells, 0, "left")).toBe(1);
    expect(directionalFocusTarget(cells, 0, "right")).toBe(2);
    expect(directionalFocusTarget(cells, 0, "up")).toBe(3);
    expect(directionalFocusTarget(cells, 0, "down")).toBe(4);
  });

  test("U/I choose farther and nearer depth", () => {
    expect(directionalFocusTarget(cells, 0, "far")).toBe(5);
    expect(directionalFocusTarget(cells, 0, "near")).toBe(6);
  });

  test("navigation without a current cell starts at screen center", () => {
    expect(directionalFocusTarget(cells, undefined, "right")).toBe(2);
  });

  test("dragging at twice the depth maps each pixel to twice the world distance", () => {
    const near = depthPlanePanScale(4, Math.PI / 3, 800);
    const far = depthPlanePanScale(8, Math.PI / 3, 800);
    expect(far).toBeCloseTo(near * 2, 12);
  });
});
