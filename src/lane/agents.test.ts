import { describe, expect, test } from "bun:test";
import { commitImp, commitTrack, createAgentsSource, windowCells } from "./agents.js";
import { createTimelineSource } from "./timeline.js";

describe("commitTrack", () => {
  test("Claude co-author trailer wins over human author", () => {
    const msg = "feat: thing\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>";
    expect(commitTrack(msg, "snomiao")).toBe("claude");
  });
  test("codex trailer routes to codex", () => {
    expect(commitTrack("fix: x\n\nCo-authored-by: Codex <codex@openai.com>", "snomiao")).toBe("codex");
  });
  test("bot authors outrank trailers", () => {
    const msg = "chore(release): 2.24.0\n\nCo-Authored-By: Claude <n@a>";
    expect(commitTrack(msg, "semantic-release-bot")).toBe("bot");
    expect(commitTrack("bump", "dependabot[bot]")).toBe("bot");
  });
  test("no trailer, human author → human", () => {
    expect(commitTrack("docs: readme", "snomiao")).toBe("human");
  });
  test("agent as direct author (no trailer) still attributes", () => {
    expect(commitTrack("wip", "claude-code")).toBe("claude");
  });
  test("mention of an agent in the SUBJECT is not attribution", () => {
    expect(commitTrack("docs: describe claude workflow", "snomiao")).toBe("human");
  });
});

describe("commitImp", () => {
  test("orders breaking > feat > fix > chore", () => {
    const imp = (s: string) => commitImp(s);
    expect(imp("feat!: break")).toBeGreaterThan(imp("feat: add"));
    expect(imp("feat: add")).toBeGreaterThan(imp("fix: bug"));
    expect(imp("fix: bug")).toBeGreaterThan(imp("chore: tidy"));
  });
  test("releases sit between feat and fix", () => {
    expect(commitImp("chore(release): 2.0.0")).toBeGreaterThan(commitImp("fix: y"));
    expect(commitImp("chore(release): 2.0.0")).toBeLessThan(commitImp("feat!: z"));
  });
});

describe("windowCells", () => {
  test("cells are power-of-two sized, aligned, and cover the window", () => {
    const cells = windowCells(0.4, 0.1);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      const size = c.top - c.bot;
      expect(Math.log2(size * 32) % 1).toBeCloseTo(0, 9);
      expect(c.bot / size).toBeCloseTo(Math.round(c.bot / size), 9);
    }
    expect(cells[0]!.top).toBeGreaterThanOrEqual(0.4);
    expect(cells[cells.length - 1]!.bot).toBeLessThanOrEqual(0.1);
  });
  test("a slow zoom sweep reuses keys instead of minting per-frame", () => {
    const keys = new Set<string>();
    for (let f = 0; f < 100; f++) {
      const top = 0.3 + f * 0.0003; // drifting view, ~zoom animation
      for (const c of windowCells(top, top - 0.25))
        keys.add(`${c.bot}:${c.top}`);
    }
    expect(keys.size).toBeLessThanOrEqual(4);
  });
  test("future-only bound clamps at now", () => {
    for (const c of windowCells(0.02, -0.01)) expect(c.bot).toBeGreaterThanOrEqual(0);
  });
});

describe("dataset injection", () => {
  test("agents source exposes its own tracks, not deep time's", () => {
    const src = createAgentsSource();
    expect(src.title).toBe("agents");
    expect(src.categories.map((c) => c.cat)).toEqual([
      "human", "claude", "codex", "other", "bot",
    ]);
  });
  test("deep-time default is untouched by the parameterization", () => {
    const src = createTimelineSource();
    expect(src.title).toBe("deep time");
    expect(src.categories.map((c) => c.cat)).toContain("cosmic");
    expect(src.find("COVID", 3).length).toBeGreaterThan(0);
  });
  test("injected statics render into search + extent stays within reach", () => {
    const src = createTimelineSource({
      dataset: {
        title: "t",
        tracks: [{ cat: "a", label: "A", color: "#ff0000" }],
        statics: [
          { y: 0.5, tMs: Date.now() - 0.5 * 31556952e3, label: "hello world", imp: 0.9, cat: "a" },
        ],
        oldestYBP: 2,
        futureYears: 0.1,
      },
    });
    const hits = src.find("hello", 3);
    expect(hits.length).toBe(1);
    expect(hits[0]!.color).toBe("#ff0000");
    const ext = src.extent();
    expect(ext.max - ext.min).toBeLessThan(30); // symlog decades, not the universe
  });
});
