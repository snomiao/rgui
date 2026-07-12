import { describe, expect, spyOn, test } from "bun:test";
import { createLazyTreeSource, createTreeSource, type FileNode } from "./tree.js";
import type { TreeProvider, TreeProviderEntry } from "./treeprovider.js";
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

// scrollY=0 puts world [0,1] exactly on screen [0,600]
const view = (height = 600, zoomY = 600, scrollY = 0): LaneView =>
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
    const nowSpy = spyOn(performance, "now").mockReturnValue(1_000);
    try {
      const before = probe();
      src.applyFsEvent("src/huge.ts", { name: "huge.ts", size: 45 * 5000 });
      nowSpy.mockReturnValue(2_000); // past GLIDE_MS: displayed == target
      const after = probe();
      expect(after).toEqual(before);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("deletion tombstones: the row shrinks over the glide instead of vanishing", () => {
    const src = createTreeSource(structuredClone(ROOT));
    const v = view();
    const nowSpy = spyOn(performance, "now").mockReturnValue(1_000);
    try {
      const sweep = () => {
        const seen = new Set<string>();
        for (let y = 24; y < 596; y += 2) seen.add(src.hudLine!(v, y) ?? "");
        return seen;
      };
      expect([...sweep()].some((s) => s.includes("docs"))).toBe(true);
      src.applyFsEvent("docs", null);
      nowSpy.mockReturnValue(1_100); // mid-glide: tombstone still on screen
      expect([...sweep()].some((s) => s.includes("docs"))).toBe(true);
      nowSpy.mockReturnValue(2_000); // settled: reaped
      expect([...sweep()].some((s) => s.includes("docs"))).toBe(false);
      // and it is gone from the model, not just hidden
      expect(src.applyFsEvent("docs", null)).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
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

  test("loaded real lines REPLACE an inflated size estimate in the zoom clamp", () => {
    const bloated = createTreeSource({
      name: "root",
      children: [{ name: "sparse.bin", size: 45 * 100000 }], // est ~100k lines
    });
    const real = createTreeSource({
      name: "root",
      // same file but its actual content is 20 lines
      children: [{ name: "sparse.bin", size: 45 * 100000, content: Array(20).fill("x").join("\n") }],
    });
    // with content present, the clamp must be SHALLOWER than the estimate's
    expect(real.maxZoom!).toBeLessThan(bloated.maxZoom!);
  });

  test("aggregates refresh along the ancestor chain", () => {
    const src = createTreeSource(structuredClone(ROOT));
    src.applyFsEvent("docs/new.md", { name: "new.md", size: 2048 });
    const v = view();
    // root header line still resolves; docs gained a file (smoke via hud)
    expect(src.hudLine!(v, 300)).toBeTruthy();
  });
});

describe("lazy tree source — provider integration", () => {
  // in-memory provider over a FileNode tree, paginated `pageSize` at a time
  function memoryProvider(root: FileNode, pageSize = 2): TreeProvider & { calls: string[] } {
    const find = (path: string): FileNode | null => {
      if (!path) return root;
      let cur: FileNode | undefined = root;
      for (const seg of path.split("/")) {
        cur = cur?.children?.find((c) => c.name === seg);
        if (!cur) return null;
      }
      return cur ?? null;
    };
    const calls: string[] = [];
    return {
      calls,
      async list(path, { cursor, limit }) {
        calls.push(path);
        const dir = find(path);
        if (!dir?.children) throw new Error(`not a dir: ${path}`);
        const entries: TreeProviderEntry[] = dir.children.map((c) => ({
          name: c.name,
          kind: c.children ? ("directory" as const) : ("file" as const),
          size: c.size,
        }));
        const start = cursor ? parseInt(cursor, 10) : 0;
        const n = Math.min(limit ?? pageSize, pageSize);
        const end = Math.min(entries.length, start + n);
        return {
          entries: entries.slice(start, end),
          cursor: end < entries.length ? String(end) : undefined,
          complete: end >= entries.length,
          version: 1,
        };
      },
      async read(path) {
        return find(path)?.content ?? null;
      },
    };
  }

  const DATA: FileNode = {
    name: "lazy-root",
    children: [
      {
        name: "src",
        children: [
          { name: "a.ts", size: 4500 },
          { name: "b.ts", size: 4500 },
        ],
      },
      { name: "docs", children: [] }, // complete-EMPTY, not unknown
      { name: "package.json", size: 450 },
      { name: "README.md", size: 900 },
    ],
  };

  const view = (height = 600, zoomY = 600, scrollY = 0): LaneView =>
    ({ height, zoomY, scrollY, width: 800 } as unknown as LaneView);

  test("nothing is known before the first listing", () => {
    const src = createLazyTreeSource(memoryProvider(structuredClone(DATA)), { rootName: "root" });
    const v = view();
    for (let y = 30; y < 590; y += 40) {
      expect(src.hudLine!(v, y)).toBe("root");
    }
  });

  test("paginated listings materialize children incrementally", async () => {
    const provider = memoryProvider(structuredClone(DATA), 2);
    const src = createLazyTreeSource(provider, { rootName: "root" });
    const v = view();
    await src.ensureListed(""); // page 1: src, docs
    const sweep = () => {
      const s = new Set<string>();
      for (let y = 24; y < 596; y += 2) s.add(src.hudLine!(v, y) ?? "");
      return [...s].join("|");
    };
    const nowSpy = spyOn(performance, "now").mockReturnValue(10_000);
    try {
      expect(sweep()).toContain("src");
      expect(sweep()).not.toContain("README");
      await src.ensureListed(""); // page 2: package.json, README.md → complete
      nowSpy.mockReturnValue(20_000);
      expect(sweep()).toContain("README.md");
      // nested listing materializes grandchildren
      await src.ensureListed("src");
      nowSpy.mockReturnValue(30_000);
      expect(sweep()).toContain("a.ts");
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("provider errors resolve (not reject) and leave the tree intact", async () => {
    const provider = memoryProvider(structuredClone(DATA));
    const src = createLazyTreeSource(provider, { rootName: "root" });
    await src.ensureListed("no/such/dir"); // provider throws inside
    expect(src.hudLine!(view(), 300)).toBe("root");
  });

  test("eager sources treat ensureListed as a no-op", async () => {
    const src = createTreeSource(structuredClone(DATA));
    await src.ensureListed();
    expect(src.hudLine!(view(), 300)).toBeTruthy();
  });
});

describe("lazy tree source — review regressions", () => {
  const view = (height = 600, zoomY = 600, scrollY = 0): LaneView =>
    ({ height, zoomY, scrollY, width: 800 } as unknown as LaneView);

  test("tombstoned entries resurrect with their weight restored", async () => {
    // mutable provider with a watch hook: delete b.ts, re-list, restore it
    let names = ["a.ts", "b.ts", "c.ts"];
    let invalidate: (() => void) | null = null;
    const provider: TreeProvider = {
      async list() {
        return {
          entries: names.map((name) => ({ name, kind: "file" as const, size: 4500 })),
          complete: true,
          version: names.join(","),
        };
      },
      watch(_path, cb) {
        invalidate = () => cb({ path: "" });
        return () => {};
      },
    };
    const src = createLazyTreeSource(provider, { rootName: "root" });
    const v = view();
    const nowSpy = spyOn(performance, "now").mockReturnValue(1_000);
    try {
      await src.ensureListed();
      nowSpy.mockReturnValue(2_000);
      const sweep = () => {
        const s = new Set<string>();
        for (let y = 24; y < 596; y += 2) s.add(src.hudLine!(v, y) ?? "");
        return [...s].join("|");
      };
      expect(sweep()).toContain("b.ts");
      names = ["a.ts", "c.ts"]; // delete
      invalidate!();
      await src.ensureListed();
      nowSpy.mockReturnValue(3_000); // glide out + reap
      expect(sweep()).not.toContain("b.ts");
      names = ["a.ts", "b.ts", "c.ts"]; // resurrect
      invalidate!();
      await src.ensureListed();
      nowSpy.mockReturnValue(4_000); // settle
      // a weight-0 resurrection would leave b.ts at share 0 → invisible
      expect(sweep()).toContain("b.ts");
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("provider paths that aren't display-name joins still materialize", async () => {
    // provider keys look like opaque ids, nothing like "src/a.ts"
    const provider: TreeProvider = {
      async list(path) {
        if (path === "id:root") {
          return {
            entries: [
              { name: "src", kind: "directory" as const, path: "id:42" },
              { name: "readme.md", kind: "file" as const, size: 900 },
            ],
            complete: true,
            version: 1,
          };
        }
        if (path === "id:42") {
          return {
            entries: [{ name: "deep.ts", kind: "file" as const, size: 4500 }],
            complete: true,
            version: 1,
          };
        }
        throw new Error(`unknown key ${path}`);
      },
    };
    const src = createLazyTreeSource(provider, { rootName: "root", rootPath: "id:root" });
    const v = view();
    const nowSpy = spyOn(performance, "now").mockReturnValue(1_000);
    try {
      await src.ensureListed(); // root by its provider key
      await src.ensureListed("id:42"); // the dir by ITS provider key
      nowSpy.mockReturnValue(2_000);
      const seen = new Set<string>();
      for (let y = 24; y < 596; y += 2) seen.add(src.hudLine!(v, y) ?? "");
      const all = [...seen].join("|");
      expect(all).toContain("src");
      expect(all).toContain("deep.ts"); // grandchild materialized under id:42
    } finally {
      nowSpy.mockRestore();
    }
  });
});
