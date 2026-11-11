import { expect, test } from "bun:test";
import { GanttController } from "./core";

const now = 1_800_000_000;
const mk = () => {
  const c = new GanttController({ now: () => now, foldKey: null });
  c.setViewport(800, 400);
  c.setBars([
    { id: "/l/cat/a", lane: "l", a: now - 3600, due: now + 3600 },
    { id: "/l/cat/b", lane: "l", a: now - 7200, due: now - 3600, b: now - 3600, outcome: "verified" },
    { id: "/l/idle/a", lane: "l", a: now - 9000, due: now - 8000, b: now - 8000, outcome: "verified" },
    { id: "/l/idle/b", lane: "l", a: now - 8000, due: now - 7000, b: now - 7000, outcome: "verified" },
  ]);
  return c;
};

test("controller: tree rows, default folds, toggle", () => {
  const c = mk();
  const names = () => c.lines.map((l) => l.lane ?? `${l.folded ? "▸" : ""}${l.bar!.id}`);
  expect(names()).toEqual(["l", "/l/cat", "/l/cat/a", "/l/cat/b", "▸/l/idle"]);
  c.toggle("l", "/l/idle");
  expect(names()).toContain("/l/idle/b");
});

test("controller: zoomAt keeps the time under the point, linear and log", () => {
  for (const log of [false, true]) {
    const c = mk();
    if (log) c.setLog(true);
    const t = c.t(300);
    c.zoomAt(300, 2);
    expect(Math.abs(c.t(300) - t)).toBeLessThan(1);
  }
});

test("controller: endless axis recentres near an edge when data lies beyond, keeping the view", () => {
  const c = mk();
  c.setBars([...c.bars, { id: "/l/old", lane: "l", a: now - 400 * 86400, due: now - 399 * 86400 }]);
  c.scrollTo(10, 0); // near the left edge, data further left
  const t = c.t(0);
  expect(c.scrollX).toBeGreaterThan(10);
  c.scrollTo(c.scrollX, 0);
  expect(Math.abs(c.t(0) - t)).toBeLessThan(1);
});

test("controller: frame gives rows, parts in px, ticks, now-line, events", () => {
  const c = mk();
  let views = 0,
    opened: unknown;
  c.on("view", () => views++);
  c.on("open", (b) => (opened = b));
  c.today();
  const f = c.frame();
  expect(views).toBe(1);
  expect(f.nowX).toBeCloseTo(400, 0);
  const a = f.rows.find((r) => r.line.bar?.id === "/l/cat/a")!;
  expect(a.parts[0]!.x).toBeCloseTo(c.x(now - 3600), 5);
  expect(a.parts[0]!.w).toBeCloseTo(7200 / c.spp, 5);
  expect(f.ticks.length).toBeGreaterThan(0);
  c.open(a.line.bar!);
  expect((opened as { id: string }).id).toBe("/l/cat/a");
});

test("controller: crosshair focus after scrolling settles, snap, padding, remembered", async () => {
  const c = mk();
  let got: unknown;
  c.on("focus", (b) => (got = b));
  expect(c.pad).toBe(200);
  expect(c.contentHeight).toBe(5 * 26 + 400);
  // the first row can reach the crosshair
  c.scrollTo(c.scrollX, c.rowTop(1) + 13 - 200 + 5);
  await new Promise((r) => setTimeout(r, 220));
  expect(c.scrollY).toBe(c.rowTop(1) + 13 - 200); // snapped
  expect((got as { id: string }).id).toBe("/l/cat");
  expect(c.focus).toBe("l /l/cat");
  c.setFocus(c.lines[3]!.bar);
  expect(c.crosshairRow()).toBe(3);
});
