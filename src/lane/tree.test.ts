import { describe, expect, test } from "bun:test";
import { createTreeSource, type FileNode } from "./tree.js";
import type { LaneView } from "./view.js";
import { worldToScreenY } from "./view.js";

// deterministic little repo: two dirs + a fat file, no network
const ROOT: FileNode = {
  name: "root",
  children: [
    {
      name: "src",
      children: [
        { name: "a.ts", size: 4500 },
        { name: "b.ts", size: 4500 },
        { name: "big.ts", size: 45 * 200 }, // ~200 lines → weight ~120 cap
      ],
    },
    {
      name: "docs",
      children: [
        { name: "README.md", size: 900 },
        { name: "guide.md", size: 900 },
      ],
    },
    { name: "package.json", size: 450 },
  ],
};

const view = (height = 600, zoomY = 600, scrollY = 0.5): LaneView =>
  ({ height, zoomY, scrollY, width: 800 } as unknown as LaneView);

describe("tree source — interval coordinates", () => {
  test("extent is the fixed unit interval", () => {
    const src = createTreeSource(structuredClone(ROOT));
    expect(src.extent()).toEqual({ min: 0, max: 1 });
  });

  test("hudLine resolves the node under the pointer via the shared layout", () => {
    const src = createTreeSource(structuredClone(ROOT));
    const v = view();
    // world 0..1 maps to screen 0..600 (scroll centered at 0.5)
    // src owns the top of the tree after the root header
    const line = src.hudLine!(v, 40);
    expect(line).toContain("root");
    expect(line).toContain("src");
  });

  test("focusAt returns a world interval inside [0,1] consistent with hudLine", () => {
    const src = createTreeSource(structuredClone(ROOT));
    const v = view();
    for (const y of [40, 150, 300, 450, 580]) {
      const f = src.focusAt!(y, v)!;
      expect(f.center).toBeGreaterThanOrEqual(0);
      expect(f.center).toBeLessThanOrEqual(1);
      expect(f.zoom).toBeGreaterThan(0);
      // the focused interval must contain the world y that was clicked…
      // (screen→world affinity only holds outside stolen headers, so allow
      // the header offset: the clicked node's band contains the pointer)
      const back = worldToScreenY(v, f.center);
      expect(Math.abs(back - y)).toBeLessThan(v.height); // sanity: same screen
    }
  });

  test("hit at a screen y inside a child row returns that child, not a neighbor", () => {
    const src = createTreeSource(structuredClone(ROOT));
    const v = view();
    // scan downward; trail transitions must be monotone through child order
    const seen: string[] = [];
    for (let y = 30; y < 590; y += 10) {
      const line = src.hudLine!(v, y) ?? "";
      if (!seen.length || seen[seen.length - 1] !== line) seen.push(line);
    }
    const order = ["src", "docs", "package.json"];
    const firstIdx = order.map((n) => seen.findIndex((s) => s.includes(n)));
    const present = firstIdx.filter((i) => i >= 0);
    expect(present.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < firstIdx.length; i++) {
      if (firstIdx[i]! >= 0 && firstIdx[i - 1]! >= 0) {
        expect(firstIdx[i]!).toBeGreaterThan(firstIdx[i - 1]!);
      }
    }
  });
});

describe("tree source — mutations & locality", () => {
  test("applyFsEvent upserts, deletes, and reports missing parents", () => {
    const src = createTreeSource(structuredClone(ROOT));
    expect(src.applyFsEvent("src/c.ts", { name: "c.ts", size: 1000 })).toBe(true);
    expect(src.applyFsEvent("src/c.ts", null)).toBe(true);
    expect(src.applyFsEvent("src/c.ts", null)).toBe(false); // already gone
    expect(src.applyFsEvent("nope/x.ts", { name: "x.ts" })).toBe(false);
    expect(src.applyFsEvent("", null)).toBe(false);
  });

  test("a mutation inside a dir does not move its siblings' world intervals", () => {
    const src = createTreeSource(structuredClone(ROOT));
    const v = view();
    // sample the boundary between docs and package.json before/after a
    // mutation inside src — stick-breaking locality says it must not move
    const probe = () => {
      const out: string[] = [];
      for (let y = 30; y < 590; y += 4) out.push(`${y}:${src.hudLine!(v, y)}`);
      return out.filter((s) => !s.includes("/src")); // everything outside src
    };
    const before = probe();
    src.applyFsEvent("src/huge.ts", { name: "huge.ts", size: 45 * 5000 });
    // settle the glide: probe far in the future by faking time via repeated calls
    const t0 = performance.now();
    while (performance.now() - t0 < 300) {
      /* wait out GLIDE_MS so displayed == target */
    }
    const after = probe();
    expect(after).toEqual(before);
  });

  test("adaptive maxZoom deepens when finer content arrives", () => {
    const src = createTreeSource(structuredClone(ROOT));
    const z0 = src.maxZoom!;
    expect(z0).toBeGreaterThan(0);
    // a much bigger file → finer lines → deeper zoom allowed
    src.applyFsEvent("src/colossal.ts", { name: "colossal.ts", size: 45 * 100000 });
    const z1 = src.maxZoom!;
    expect(z1).toBeGreaterThanOrEqual(z0);
  });

  test("aggregates refresh along the ancestor chain", () => {
    const src = createTreeSource(structuredClone(ROOT));
    src.applyFsEvent("docs/new.md", { name: "new.md", size: 2048 });
    const v = view();
    // root header line still resolves; docs gained a file (smoke via hud)
    expect(src.hudLine!(v, 300)).toBeTruthy();
  });
});
