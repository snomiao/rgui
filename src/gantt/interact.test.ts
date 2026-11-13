import { expect, test } from "bun:test";
import { GanttController } from "./core";
import { cursorOf, desireAnswered, dragTo, hitPart, startDrag, toDesire } from "./interact";

const now = 1_800_000_000;
const mk = (log = false) => {
  const c = new GanttController({ now: () => now, storage: null, crosshair: false, log });
  c.setViewport(1000, 400);
  c.setBars([
    { id: "/l/a", lane: "l", a: now - 3600, due: now + 3600 },
    {
      id: "/l/done",
      lane: "l",
      a: now - 9000,
      due: now - 8000,
      b: now - 8000,
      outcome: "verified",
    },
  ]);
  return c;
};

test("hitPart: edges on wide bars, body, none", () => {
  expect(hitPart(100, 100, 200)).toBe("start");
  expect(hitPart(198, 100, 200)).toBe("end");
  expect(hitPart(150, 100, 200)).toBe("body");
  expect(hitPart(50, 100, 200)).toBe("none");
  expect(hitPart(101, 100, 110)).toBe("body"); // narrow: no edges
  expect(cursorOf("body")).toBe("grab");
  expect(cursorOf("end")).toBe("ew-resize");
});

test("controller.hitTest: row, bar, time and part; header rows have no bar", () => {
  const c = mk(),
    H = c.o.rowHeight;
  expect(c.lines[0]!.lane).toBe("l");
  expect(c.hitTest(10, H / 2)?.bar).toBeUndefined();
  const i = c.indexOf("/l/a")!,
    y = c.rowY(i) + H / 2,
    xm = c.x(now);
  const h = c.hitTest(xm, y)!;
  expect(h.bar?.id).toBe("/l/a");
  expect(h.part).toBe("body");
  expect(Math.abs(h.t - now)).toBeLessThan(c.spp + 1);
  expect(c.hitTest(c.x(now - 3600) + 1, y)!.part).toBe("start");
  expect(c.hitTest(-5000, y)!.part).toBe("none");
  expect(c.hitTest(0, 1e6)).toBeUndefined();
});

test("drag-to-propose: body moves both ends, edges one, through the scale (linear and log); closed bars refuse", () => {
  for (const log of [false, true]) {
    const c = mk(log),
      i = c.indexOf("/l/a")!,
      y = c.rowY(i) + 5;
    const d0 = startDrag(c.hitTest(c.x(now), y)!, undefined, now)!;
    expect(d0.part).toBe("body");
    expect(dragTo(d0, 2, c).moved).toBe(false); // under the slop: a click
    const d = dragTo(d0, 100, c);
    expect(d.moved).toBe(true);
    expect(d.a).toBeGreaterThan(d0.a);
    if (!log) expect(Math.abs(d.b - d.a - (d0.b - d0.a))).toBeLessThan(1e-6);
    const e = dragTo(startDrag(c.hitTest(c.x(now + 3600) - 1, y)!, undefined, now)!, -1e5, c);
    expect(e.part).toBe("end");
    expect(e.b).toBe(e.a + 60); // never shorter than a minute
    const des = toDesire(d);
    expect(c.setDesires({ [d.key]: des })).toEqual([]);
    const row = c.frame().rows.find((r) => r.line.bar?.id === "/l/a")!;
    expect(row.desire?.a).toBe(des.a);
  }
  const c = mk(),
    j = c.indexOf("/l/done");
  if (j !== undefined)
    expect(startDrag(c.hitTest(c.x(now - 8500), c.rowY(j) + 5)!)).toBeUndefined();
});

test("a desire is answered (dropped) once the task is re-planned", () => {
  const c = mk(),
    b = c.bars[0]!,
    d = { a: now, b: now + 7200, pa: b.a, pdue: b.due };
  expect(desireAnswered(d, b)).toBe(false);
  c.setDesires({ "l /l/a": d });
  c.setBars([{ ...b, due: b.due + 60 }]);
  expect(c.setDesires(c.desires)).toEqual(["l /l/a"]);
  expect(c.desires).toEqual({});
});

test("focusAt: hover focus picks the task row at y, a header keeps the focus", () => {
  const c = mk(),
    H = c.o.rowHeight,
    seen: unknown[] = [];
  c.on("focus", (b) => seen.push((b as { id: string } | undefined)?.id));
  const i = c.indexOf("/l/a")!;
  expect(c.focusAt(c.rowY(i) + H / 2)?.id).toBe("/l/a");
  expect(c.focus).toBe("l /l/a");
  expect(c.focusAt(H / 2)).toBeUndefined(); // the header row
  expect(c.focus).toBe("l /l/a");
  expect(seen).toEqual(["/l/a"]);
});
