import { describe, expect, test } from "bun:test";
import { createCubePuzzle } from "./puzzle.js";
import {
  buildCubeRepresentation,
  type CubeRepresentation,
} from "./merge.js";

const puzzle = createCubePuzzle(42);

function memberCounts(representation: CubeRepresentation) {
  const counts = new Map<number, number>();
  for (const cell of representation.cells) {
    for (const member of cell.members) {
      counts.set(member.id, (counts.get(member.id) ?? 0) + 1);
    }
  }
  return counts;
}

function connected(ids: readonly number[]) {
  const remaining = new Set(ids);
  const queue = [ids[0]!];
  remaining.delete(ids[0]!);
  while (queue.length) {
    const id = queue.shift()!;
    const cell = puzzle.cells[id]!;
    for (const candidate of [...remaining]) {
      const next = puzzle.cells[candidate]!;
      if (
        Math.abs(cell.x - next.x) +
          Math.abs(cell.y - next.y) +
          Math.abs(cell.z - next.z) ===
        1
      ) {
        remaining.delete(candidate);
        queue.push(candidate);
      }
    }
  }
  return remaining.size === 0;
}

describe("3D cube RG merge methods", () => {
  test("all methods follow 4³ → 2³ → 1³ and preserve two-digit labels", () => {
    for (const method of ["block", "gaussian", "graph"] as const) {
      expect(buildCubeRepresentation(puzzle, method, "mean", 0).cells).toHaveLength(64);
      expect(buildCubeRepresentation(puzzle, method, "mean", 1).cells).toHaveLength(8);
      const root = buildCubeRepresentation(puzzle, method, "mean", 2);
      expect(root.cells).toHaveLength(1);
      expect(root.fixedPoint).toBe(true);
      for (const level of [0, 1, 2] as const) {
        expect(
          buildCubeRepresentation(puzzle, method, "mean", level).cells.every(
            (cell) => cell.value >= 10 && cell.value <= 99,
          ),
        ).toBe(true);
      }
    }
  });

  test("block 2³ is a disjoint, exhaustive partition", () => {
    const representation = buildCubeRepresentation(puzzle, "block", "mean", 1);
    const counts = memberCounts(representation);

    expect(representation.cells.every((cell) => cell.members.length === 8)).toBe(true);
    expect(counts.size).toBe(64);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
  });

  test("Gaussian support overlaps while retaining every source cell", () => {
    const representation = buildCubeRepresentation(
      puzzle,
      "gaussian",
      "mean",
      1,
    );
    const counts = memberCounts(representation);

    expect(counts.size).toBe(64);
    expect([...counts.values()].some((count) => count > 1)).toBe(true);
    expect(representation.cells.every((cell) => cell.members.length === 27)).toBe(
      true,
    );
  });

  test("graph coarsening creates disjoint connected 6-neighbor regions", () => {
    const representation = buildCubeRepresentation(puzzle, "graph", "mean", 1);
    const counts = memberCounts(representation);

    expect(counts.size).toBe(64);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);
    expect(
      representation.cells.every((cell) =>
        connected(cell.members.map((member) => member.id)),
      ),
    ).toBe(true);
  });

  test("mean, sum, and median reduce the same hard block by field semantics", () => {
    const baseIds = puzzle.cells
      .filter((cell) => cell.x < 2 && cell.y < 2 && cell.z < 2)
      .map((cell) => cell.id);
    const values = baseIds.map((id) => puzzle.cells[id]!.value).sort((a, b) => a - b);
    const expectedMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const mean = buildCubeRepresentation(puzzle, "block", "mean", 1).cells[0]!;
    const sum = buildCubeRepresentation(puzzle, "block", "sum", 1).cells[0]!;
    const median = buildCubeRepresentation(puzzle, "block", "median", 1).cells[0]!;

    expect(mean.rawValue).toBeCloseTo(expectedMean);
    expect(sum.rawValue).toBe(values.reduce((total, value) => total + value, 0));
    expect(median.rawValue).toBe(values[3]!);
  });

  test("coarsening is deterministic and source labels are exactly reversible", () => {
    const first = buildCubeRepresentation(puzzle, "graph", "median", 1);
    const second = buildCubeRepresentation(puzzle, "graph", "median", 1);
    const source = buildCubeRepresentation(puzzle, "graph", "median", 0);

    expect(first).toEqual(second);
    expect(source.cells.map((cell) => cell.value)).toEqual(
      puzzle.cells.map((cell) => cell.value),
    );
  });
});
