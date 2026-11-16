import { expect, test } from "bun:test";
import { categorize, treeOrder } from "./model";
import { toBars } from "./source";

// a syform-shaped roadmap item
type RoadmapItem = { id: string; title: string; category: string; status: string; start?: string; end?: string; deps?: string[] };
const STATUSES = {
  done: { color: "#2e7d32", label: "完了", closed: true },
  partial: { color: "#f9a825", label: "一部" },
  not_started: { color: "#9e9e9e", label: "未着手" },
  blocked: { color: "#c62828", label: "ブロック" },
  unchecked: { color: "#6a1b9a", label: "未確認" },
};

test("toBars: dated, undated, closed, milestone, deps, group", () => {
  const items: RoadmapItem[] = [
    { id: "a", title: "設計", category: "基盤", status: "done", start: "2026-11-01", end: "2026-11-03" },
    { id: "b", title: "実装", category: "基盤", status: "partial", start: "2026-11-03", deps: ["a"] },
    { id: "c", title: "調査", category: "運用", status: "unchecked" },
  ];
  const bars = toBars(
    items,
    (r) => ({ id: r.id, name: r.title, group: r.category, start: r.start, end: r.end, status: r.status, deps: r.deps }),
    { statuses: STATUSES, now: 1e9 },
  );
  expect(bars[0]).toMatchObject({ lane: "基盤", outcome: "verified", b: Date.parse("2026-11-03") / 1000 });
  expect(bars[1]).toMatchObject({ due: bars[1]!.a + 86400, deps: ["a"], status: "partial" });
  expect(bars[1]!.b).toBeUndefined();
  expect(bars[2]).toMatchObject({ undated: true, a: 1e9, due: 1e9, lane: "運用" });
  expect(treeOrder(categorize(bars)).length).toBe(3);
});
