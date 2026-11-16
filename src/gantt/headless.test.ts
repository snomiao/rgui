import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

// the @snomiao/rgui/gantt entry must stay headless: no DOM module in its import graph, no DOM globals, no deps
test("headless entry: imports only core modules, no DOM globals, no packages", async () => {
  const seen = new Set<string>(),
    todo = [join(import.meta.dir, "index.ts")];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = await Bun.file(f).text();
    for (const m of src.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']/g)) {
      const spec = m[1]!;
      expect(spec.startsWith(".")).toBe(true);
      todo.push(join(dirname(f), spec.endsWith(".ts") ? spec : `${spec}.ts`));
    }
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(
      /\b(document|window|requestAnimationFrame|HTMLElement|ResizeObserver)\b/,
    );
  }
  const names = [...seen].map((f) => f.split("/").pop());
  expect(names).not.toContain("native.ts");
  expect(names).not.toContain("input.ts");
  expect(names.sort()).toEqual([
    "core.ts",
    "index.ts",
    "interact.ts",
    "layout.ts",
    "model.ts",
    "scale.ts",
    "source.ts",
  ]);
});

test("canvas entry re-exports the core and the renderer", async () => {
  const src = await Bun.file(join(import.meta.dir, "canvas.ts")).text();
  for (const m of ['"./index"', '"./native"', '"./input"']) expect(src).toContain(m);
});
