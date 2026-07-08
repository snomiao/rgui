import { expect, test } from "bun:test";
import { AccModel2D } from "./accModel.js";

/** Drive a model holding one direction for `holdMs` at `fps`, return travel. */
function travel(
  fps: number,
  holdMs: number,
  press: (m: AccModel2D, t: number) => void,
): number {
  const m = new AccModel2D(1600);
  const step = 1000 / fps;
  let t = 0;
  press(m, t);
  let d = 0;
  for (; t <= holdMs; t += step) d += m.tick(t).dy;
  return d;
}

test("holding right for 1s travels ~rate units (px/first-second)", () => {
  const d = travel(60, 1000, (m, t) => m.pressDown(t));
  // rate 1600 → ~1600 units over the first second (damping trims a little)
  expect(d).toBeGreaterThan(1200);
  expect(d).toBeLessThan(1800);
});

test("displacement is FPS-independent", () => {
  const at30 = travel(30, 800, (m, t) => m.pressDown(t));
  const at144 = travel(144, 800, (m, t) => m.pressDown(t));
  // same hold, wildly different tick rates → within a few percent
  expect(Math.abs(at30 - at144) / at144).toBeLessThan(0.05);
});

test("settles to rest after release", () => {
  const m = new AccModel2D(1600);
  m.pressDown(0);
  for (let t = 0; t <= 300; t += 16) m.tick(t);
  m.releaseDown();
  let t = 316;
  for (; t <= 2000 && m.isActive; t += 16) m.tick(t);
  expect(m.isActive).toBe(false);
});

test("opposite keys cancel to near-zero net velocity", () => {
  const m = new AccModel2D(1600);
  m.pressLeft(0);
  m.pressRight(0);
  let last = { dx: 0, dy: 0, active: true };
  for (let t = 0; t <= 500; t += 16) last = m.tick(t);
  expect(Math.abs(last.dx)).toBeLessThan(1);
});
