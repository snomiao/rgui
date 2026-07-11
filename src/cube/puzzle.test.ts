import { describe, expect, test } from "bun:test";
import {
  CUBE_CELL_COUNT,
  CUBE_SIZE,
  TARGET_COUNT,
  createCubePuzzle,
} from "./puzzle.js";

describe("cube puzzle", () => {
  test("creates a deterministic 4x4x4 cube with unique two-digit values", () => {
    const first = createCubePuzzle(42);
    const second = createCubePuzzle(42);

    expect(first).toEqual(second);
    expect(first.cells).toHaveLength(CUBE_CELL_COUNT);
    expect(new Set(first.cells.map((cell) => cell.value)).size).toBe(
      CUBE_CELL_COUNT,
    );
    expect(
      first.cells.every((cell) => cell.value >= 10 && cell.value <= 99),
    ).toBe(true);
  });

  test("maps every cell to the expected cube coordinates", () => {
    const puzzle = createCubePuzzle(7);
    const coordinates = new Set(
      puzzle.cells.map((cell) => `${cell.x},${cell.y},${cell.z}`),
    );

    expect(coordinates.size).toBe(CUBE_SIZE ** 3);
    expect(coordinates.has("0,0,0")).toBe(true);
    expect(coordinates.has("3,3,3")).toBe(true);
  });

  test("builds an eight-step route that starts across all depths", () => {
    const puzzle = createCubePuzzle(99);
    const byValue = new Map(puzzle.cells.map((cell) => [cell.value, cell]));
    const initialDepths = new Set(
      puzzle.targets.slice(0, CUBE_SIZE).map((value) => byValue.get(value)?.z),
    );

    expect(puzzle.targets).toHaveLength(TARGET_COUNT);
    expect(new Set(puzzle.targets).size).toBe(TARGET_COUNT);
    expect(initialDepths.size).toBe(CUBE_SIZE);
  });
});
