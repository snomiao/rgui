import { expect, test } from "bun:test";
import { columns, dayStart, parseDay, presetView, weekStart } from "./scale";
import { toX } from "./model";

const JST = 32400;

test("day / week starts in a zone", () => {
  const t = parseDay("2026-11-13", JST)! + 15 * 3600; // Fri 15:00 JST
  expect(dayStart(t, JST)).toBe(parseDay("2026-11-13", JST)!);
  expect(weekStart(t, JST)).toBe(parseDay("2026-11-09", JST)!); // Monday
  expect(parseDay("nope")).toBeUndefined();
});

test("day preset: fixed columns, today and weekends marked", () => {
  const from = parseDay("2026-11-13", JST)!,
    v = presetView("day", from + 3600, 40, JST);
  expect(toX(v, from)).toBe(0);
  const cols = columns(v, 0, 40 * 3 - 1, "day", from + 5 * 3600, JST);
  expect(cols.map((c) => c.date)).toEqual(["2026-11-13", "2026-11-14", "2026-11-15"]);
  expect(cols.map((c) => c.x)).toEqual([0, 40, 80]);
  expect(cols.map((c) => c.today)).toEqual([true, false, false]);
  expect(cols.map((c) => c.weekend)).toEqual([false, true, true]);
  const wk = columns(presetView("week", from, 70, JST), 0, 139, "week", from, JST);
  expect(wk.map((c) => c.date)).toEqual(["2026-11-09", "2026-11-16"]);
});
