import { describe, expect, test } from "bun:test";
import {
  KIND_ORDER,
  NO_LEVEL,
  bucketWeight,
  chooseTreeFold,
  chunkRows,
  contentLevels,
  discloseLevel,
  heatRampColor,
  kindCounts,
  kindOf,
  shareIntervals,
  srgbToOklch,
} from "./treefold.js";

const REM = 16;

describe("kindOf", () => {
  test("dirs always bucket to dir regardless of name", () => {
    expect(kindOf("src.ts", true)).toBe("dir");
    expect(kindOf("node_modules", true)).toBe("dir");
  });
  test("classifies common extensions", () => {
    expect(kindOf("index.ts", false)).toBe("code");
    expect(kindOf("style.css", false)).toBe("code");
    expect(kindOf("package.json", false)).toBe("data");
    expect(kindOf("bun.lock", false)).toBe("data");
    expect(kindOf("README.md", false)).toBe("doc");
    expect(kindOf("logo.svg", false)).toBe("media");
    expect(kindOf("blob.bin", false)).toBe("other");
  });
  test("well-known extensionless names bucket to doc", () => {
    expect(kindOf("LICENSE", false)).toBe("doc");
    expect(kindOf("Makefile", false)).toBe("doc");
    expect(kindOf("README", false)).toBe("doc");
  });
  test("dotfiles without a real extension fall to other", () => {
    // leading dot is not an extension separator (dot > 0 guard)
    expect(kindOf(".env", false)).toBe("other");
  });
});

describe("kindCounts", () => {
  test("counts immediate entries per bucket", () => {
    const c = kindCounts([
      { name: "src", isDir: true },
      { name: "a.ts", isDir: false },
      { name: "b.ts", isDir: false },
      { name: "package.json", isDir: false },
    ]);
    expect(c.dir).toBe(1);
    expect(c.code).toBe(2);
    expect(c.data).toBe(1);
    expect(c.doc + c.media + c.other).toBe(0);
  });
});

describe("chunkRows", () => {
  test("empty input / no rows", () => {
    expect(chunkRows([], 5)).toEqual([]);
    expect(chunkRows(["a"], 0)).toEqual([]);
  });
  test("single entries get full-name labels", () => {
    const rows = chunkRows(["alpha", "beta"], 5);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ start: 0, end: 1, label: "alpha" });
    expect(rows[1]).toEqual({ start: 1, end: 2, label: "beta" });
  });
  test("chunks are contiguous, cover everything, near-equal", () => {
    const names = Array.from({ length: 103 }, (_, i) => `f${String(i).padStart(3, "0")}`);
    const rows = chunkRows(names, 10);
    expect(rows).toHaveLength(10);
    expect(rows[0]!.start).toBe(0);
    expect(rows[rows.length - 1]!.end).toBe(103);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.start).toBe(rows[i - 1]!.end);
    for (const r of rows) expect(r.end - r.start).toBeGreaterThanOrEqual(10);
    for (const r of rows) expect(r.end - r.start).toBeLessThanOrEqual(11);
  });
  test("multi-entry chunks label with their first name as a position hint", () => {
    const rows = chunkRows(["apple", "axe", "banana", "cherry"], 2);
    expect(rows[0]!.label).toBe("apple…");
    expect(rows[1]!.label).toBe("banana…");
  });
  test("more rows than entries collapses to one row per entry", () => {
    const rows = chunkRows(["x", "y"], 100);
    expect(rows).toHaveLength(2);
  });
});

describe("chooseTreeFold", () => {
  const W = 800;
  test("empty dir strips", () => {
    expect(chooseTreeFold(0, 400, W, REM).mode).toBe("strip");
  });
  test("list when every child affords a ≥1rem row", () => {
    expect(chooseTreeFold(10, 10 * REM, W, REM).mode).toBe("list");
    expect(chooseTreeFold(10, 9 * REM, W, REM).mode).not.toBe("list");
  });
  test("grid when rows overflow but at least one readable row + kind columns fit", () => {
    const m = chooseTreeFold(500, 10 * REM, W, REM);
    expect(m.mode).toBe("grid");
    if (m.mode === "grid") expect(m.rows).toBe(10);
  });
  test("grid rows never exceed child count", () => {
    const m = chooseTreeFold(12, 5 * REM, W, REM);
    if (m.mode === "grid") expect(m.rows).toBeLessThanOrEqual(12);
  });
  test("strip when band affords no readable grid row", () => {
    expect(chooseTreeFold(500, REM - 1, W, REM).mode).toBe("strip");
  });
  test("strip when width can't host the kind columns", () => {
    const w = KIND_ORDER.length * REM - 1;
    expect(chooseTreeFold(500, 10 * REM, w, REM).mode).toBe("strip");
  });
  test("hysteresis hook: scaled remPx moves the boundary", () => {
    // same geometry, stricter (enter) unit folds; looser (exit) unit lists
    expect(chooseTreeFold(10, 10 * REM, W, REM * 1.25).mode).toBe("grid");
    expect(chooseTreeFold(12, 10 * REM, W, REM * 0.8).mode).toBe("list");
  });
  test("uneven shares: the SMALLEST child must stay readable for list", () => {
    // 4 children over 10rem is fine when equal (2.5rem each)…
    expect(chooseTreeFold(4, 10 * REM, W, REM).mode).toBe("list");
    // …but a 5% runt child (0.5rem) forces the fold
    expect(chooseTreeFold(4, 10 * REM, W, REM, 0.05).mode).toBe("grid");
  });
});

describe("bucketWeight", () => {
  test("unknown/zero sizes share equally", () => {
    expect(bucketWeight(undefined)).toBe(1);
    expect(bucketWeight(0)).toBe(1);
  });
  test("monotone over decades and quantized within a bucket", () => {
    expect(bucketWeight(1024)).toBe(1);
    expect(bucketWeight(1024 * 1024)).toBeGreaterThan(bucketWeight(1024));
    // ±5% jitter stays in the same bucket — layout never moves on noise
    expect(bucketWeight(1000_000)).toBe(bucketWeight(1050_000));
  });
});

describe("shareIntervals", () => {
  test("sums to 1 and preserves proportion", () => {
    const s = shareIntervals([1, 3]);
    expect(s[0]! + s[1]!).toBeCloseTo(1);
    expect(s[1]! / s[0]!).toBeCloseTo(3);
  });
  test("degenerate weights fall back to equal shares", () => {
    expect(shareIntervals([0, 0])).toEqual([0.5, 0.5]);
    expect(shareIntervals([])).toEqual([]);
  });
});

describe("progressive disclosure", () => {
  test("markdown headings ladder to levels; body text never surfaces", () => {
    const lv = contentLevels(["# a", "body", "## b", "### c", "", "#not-heading"], true);
    expect(lv).toEqual([0, NO_LEVEL, 1, 2, NO_LEVEL, NO_LEVEL]);
  });
  test("code indent levels use the file's own indent unit", () => {
    const lv = contentLevels(["fn a() {", "    one", "        two", "", "}"], false);
    expect(lv).toEqual([0, 1, 2, NO_LEVEL, 0]);
  });
  test("tab indentation counts as one unit step", () => {
    const lv = contentLevels(["top", "\tin", "\t\tdeep"], false);
    expect(lv[0]).toBe(0);
    expect(lv[1]).toBe(1);
    expect(lv[2]).toBe(2);
  });
  test("discloseLevel unlocks deeper levels only within budget", () => {
    // 2× level-0, 4× level-1, 8× level-2
    const levels = [0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2];
    expect(discloseLevel(levels, 0, 13, 1)).toBe(0); // first level always shows
    expect(discloseLevel(levels, 0, 13, 2)).toBe(0);
    expect(discloseLevel(levels, 0, 13, 6)).toBe(1);
    expect(discloseLevel(levels, 0, 13, 14)).toBe(2);
    expect(discloseLevel(levels, 0, 13, 13)).toBe(1);
  });
  test("window with no structural lines yields -1", () => {
    expect(discloseLevel([NO_LEVEL, NO_LEVEL], 0, 1, 10)).toBe(-1);
  });
});

describe("heat ramp", () => {
  test("srgbToOklch is sane on primaries", () => {
    const white = srgbToOklch("#ffffff");
    expect(white.L).toBeCloseTo(1, 1);
    expect(white.C).toBeLessThan(0.01);
    const blue = srgbToOklch("#60a5fa");
    expect(blue.H).toBeGreaterThan(230);
    expect(blue.H).toBeLessThan(280);
  });
  test("lightness ramps darker with count in light theme, lighter in dark", () => {
    const L = (s: string) => Number(s.match(/oklch\(([\d.]+)/)![1]);
    expect(L(heatRampColor("#60a5fa", 16, false))).toBeLessThan(L(heatRampColor("#60a5fa", 1, false)));
    expect(L(heatRampColor("#60a5fa", 16, true))).toBeGreaterThan(L(heatRampColor("#60a5fa", 1, true)));
  });
  test("ramp saturates at the 16+ bucket", () => {
    expect(heatRampColor("#60a5fa", 31, false)).toBe(heatRampColor("#60a5fa", 400, false));
  });
});
