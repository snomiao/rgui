import { expect, test } from "bun:test";
import { GanttController, type GanttRow } from "./core";
import {
  inWindow,
  lineKey,
  nearestOutside,
  rowShift,
  rowTops,
  stableSlots,
  timeWindow,
  windowStale,
} from "./layout";

const now = 1_800_000_000;
const bar = (lane: string, id: string, a = now, due = now + 3600): GanttRow => ({
  id,
  lane,
  a,
  due,
});
const keys = (c: GanttController) => c.lines.map((l) => lineKey(l));

test("stableSlots: staying rows keep their slot, leavers leave blanks, incomers fill their own lane's blank", () => {
  const s = stableSlots(),
    c = new GanttController({
      now: () => now,
      storage: null,
      crosshair: false,
      arrange: s.arrange,
    });
  c.setViewport(800, 400);
  c.setBars([bar("x", "/x/a"), bar("x", "/x/b"), bar("y", "/y/a"), bar("y", "/y/b")]);
  expect(keys(c)).toEqual(["lane x", "x /x/a", "x /x/b", "lane y", "y /y/a", "y /y/b"]);
  // /x/a leaves (its slot goes blank); /y/c arrives: no free y slot, y is the last group, so it is appended
  c.setBars([bar("x", "/x/b"), bar("y", "/y/a"), bar("y", "/y/b"), bar("y", "/y/c")]);
  expect(keys(c)).toEqual(["lane x", null, "x /x/b", "lane y", "y /y/a", "y /y/b", "y /y/c"]);
  expect(c.lines[1]!.blank).toBe(true);
  // /x/c arrives: takes the free x slot at the top
  c.setBars([
    bar("x", "/x/b"),
    bar("x", "/x/c"),
    bar("y", "/y/a"),
    bar("y", "/y/b"),
    bar("y", "/y/c"),
  ]);
  expect(keys(c)[1]).toBe("x /x/c");
  expect(c.indexOf("/x/c")).toBe(1);
  // a new x row with no free x slot goes to the bottom under a repeated x header
  c.setBars([bar("x", "/x/b"), bar("x", "/x/c"), bar("x", "/x/d"), bar("y", "/y/a")]);
  const k = keys(c);
  expect(k.slice(0, 5)).toEqual(["lane x", "x /x/c", "x /x/b", "lane y", "y /y/a"]);
  expect(k.at(-1)).toBe("x /x/d");
  expect(c.lines.at(-2)!.lane).toBe("x"); // the repeated header
  // trim drops free slots at the bottom; reset lays out afresh
  s.trim();
  c.setBars([bar("x", "/x/b"), bar("x", "/x/c"), bar("y", "/y/a")]);
  expect(keys(c).at(-1)).toBe("y /y/a");
  s.reset();
  c.setBars([bar("y", "/y/a"), bar("x", "/x/b")]);
  expect(keys(c)).toEqual(["lane y", "y /y/a", "lane x", "x /x/b"]);
});

test("stableSlots is linear enough: 5,000 rows re-arranged quickly", () => {
  const s = stableSlots(),
    c = new GanttController({
      now: () => now,
      storage: null,
      crosshair: false,
      arrange: s.arrange,
    });
  const many = (off: number) =>
    Array.from({ length: 5000 }, (_, i) => bar(`l${i % 20}`, `/l${i % 20}/t${i + off}`));
  c.setBars(many(0));
  const t = performance.now();
  c.setBars(many(2500));
  expect(performance.now() - t).toBeLessThan(1500);
  expect(c.lines.filter((l) => l.bar).length).toBe(5000);
});

test("blank lines: frame rows carry them with no parts; dy offsets rowY", () => {
  const c = new GanttController({
    now: () => now,
    storage: null,
    crosshair: false,
    arrange: (ls) => [ls[0]!, { segs: [], blank: true }, ...ls.slice(1)],
  });
  c.setViewport(800, 400);
  c.setBars([bar("x", "/x/a")]);
  const f = c.frame();
  expect(f.rows[1]!.line.blank).toBe(true);
  expect(f.rows[1]!.parts).toEqual([]);
  expect(f.rows[2]!.parts.length).toBeGreaterThan(0);
  const y = c.rowY(2);
  c.dy = (i) => (i === 2 ? 10 : 0);
  expect(c.rowY(2)).toBe(y + 10);
});

test("window query: span ± margin, re-pick only on leaving or zooming, focused task kept, nearest outside", () => {
  const w = timeWindow({ from: 1000, to: 2000 });
  expect(w).toEqual({ from: 0, to: 3000, span: 1000 });
  expect(windowStale(w, { from: 1500, to: 2500 })).toBe(false); // a sideways pan inside
  expect(windowStale(w, { from: 2500, to: 3500 })).toBe(true); // left the window
  expect(windowStale(w, { from: 1000, to: 1500 })).toBe(true); // zoomed
  expect(windowStale(null, { from: 0, to: 1 })).toBe(true);
  const bs = [
    bar("l", "/in", 500, 900),
    bar("l", "/out", 5000, 6000),
    bar("l", "/far", 9000, 9500),
    { ...bar("l", "/u"), undated: true },
  ];
  expect(inWindow(bs, w, 0).map((b) => b.id)).toEqual(["/in"]);
  expect(inWindow(bs, w, 0, "l /far").map((b) => b.id)).toEqual(["/in", "/far"]);
  expect(nearestOutside(bs, [bs[0]!], 1500, 0, 1).map((b) => b.id)).toEqual(["/out"]);
});

test("rowShift: FLIP offsets between layouts", () => {
  const c = new GanttController({ now: () => now, storage: null, crosshair: false });
  c.setViewport(800, 400);
  c.setBars([bar("x", "/x/a"), bar("x", "/x/b")]);
  const before = rowTops(c.lines, (i) => c.rowTop(i));
  c.setBars([bar("x", "/x/b"), bar("x", "/x/n")]);
  const off = rowShift(before, c.lines, (i) => c.rowTop(i), 26);
  expect(off).toEqual([0, 26, 26]); // header stays; /x/b moved up one row; /x/n is new
});
