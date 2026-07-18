import { describe, expect, test } from "bun:test";
import { commitImp, commitTrack, createGitHistorySource, gqlRows, parseRepoSpec, windowCells } from "./githistory.js";
import { createTimelineSource, massBucket, massWeight } from "./timeline.js";

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

describe("mass ladder", () => {
  test("powers-of-16 rung boundaries (codex off-by-one catch)", () => {
    expect(massBucket(undefined)).toBe(0);
    expect(massBucket(1)).toBe(0);
    expect(massBucket(15)).toBe(0);
    expect(massBucket(16)).toBe(1);
    expect(massBucket(255)).toBe(1);
    expect(massBucket(256)).toBe(2);
    expect(massBucket(4095)).toBe(2);
    expect(massBucket(4096)).toBe(3);
    expect(massBucket(1e9)).toBe(3); // capped top rung
  });
  test("invalid public input reads as unknown, never NaN", () => {
    expect(massBucket(NaN)).toBe(0);
    expect(massBucket(-5)).toBe(0);
    expect(massBucket(Infinity)).toBe(0);
    expect(massWeight(NaN)).toBe(1);
    expect(massWeight(-5)).toBe(1);
    expect(massWeight(undefined)).toBe(1);
  });
  test("cell weight: unknown = exactly legacy count; known bounded", () => {
    expect(massWeight(undefined)).toBe(1);
    expect(massWeight(1)).toBe(0.5); // a KNOWN one-liner weighs less than unknown
    expect(massWeight(2000)).toBeGreaterThan(2);
    expect(massWeight(1e8)).toBeLessThanOrEqual(6);
  });
});

describe("parseRepoSpec", () => {
  test("plain and branch specs", () => {
    expect(parseRepoSpec("torvalds/linux")).toEqual({ path: "torvalds/linux" });
    expect(parseRepoSpec("snomiao/rgui/tree/main")).toEqual({
      path: "snomiao/rgui",
      ref: "main",
    });
    expect(parseRepoSpec("o/r/tree/feat/nested-branch")).toEqual({
      path: "o/r",
      ref: "feat/nested-branch",
    });
  });
  test("branch specs get their own track labels and cats", () => {
    const src = createGitHistorySource({
      repos: ["snomiao/rgui", "snomiao/rgui/tree/dev"],
    });
    expect(src.categories.map((c) => c.label)).toEqual(["rgui", "rgui@dev"]);
    expect(src.categories.map((c) => c.cat)).toEqual([
      "snomiao/rgui",
      "snomiao/rgui/tree/dev",
    ]);
  });
});

describe("gqlRows", () => {
  const payload = {
    data: {
      repository: {
        defaultBranchRef: {
          target: {
            history: {
              pageInfo: { hasNextPage: true, endCursor: "abc123" },
              nodes: [
                {
                  oid: "deadbeef",
                  message: "feat: big thing\n\nCo-Authored-By: Claude <n@a>",
                  additions: 1200,
                  deletions: 300,
                  committedDate: "2026-07-01T12:00:00Z",
                  author: { name: "Sno", user: { login: "snomiao" } },
                },
                { oid: null, committedDate: null }, // malformed row dropped
              ],
            },
          },
        },
      },
    },
  };
  test("normalizes history nodes to REST-shaped rows with stats", () => {
    const { rows, next } = gqlRows(payload);
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.sha).toBe("deadbeef");
    expect(r.author?.login).toBe("snomiao");
    expect(r.commit.author?.date).toBe("2026-07-01T12:00:00Z");
    expect(r.stats).toEqual({ additions: 1200, deletions: 300 });
    expect(next).toBe("abc123");
  });
  test("last page yields next=null; error body yields empty", () => {
    const done = JSON.parse(JSON.stringify(payload)) as typeof payload;
    done.data.repository.defaultBranchRef.target.history.pageInfo.hasNextPage = false;
    expect(gqlRows(done).next).toBeNull();
    expect(gqlRows({ errors: [{ message: "bad" }] })).toEqual({ rows: [], next: null });
    expect(gqlRows(null)).toEqual({ rows: [], next: null });
  });
});

describe("dataset injection", () => {
  test("git-history source tracks are its repos, not deep time's cats", () => {
    const src = createGitHistorySource({ repos: ["a/x", "b/y"] });
    expect(src.title).toBe("git history");
    expect(src.categories.map((c) => c.cat)).toEqual(["a/x", "b/y"]);
    expect(src.categories.map((c) => c.label)).toEqual(["x", "y"]);
    // distinct colors per repo track
    expect(new Set(src.categories.map((c) => c.color)).size).toBe(2);
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
