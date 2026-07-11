export const CUBE_SIZE = 4;
export const CUBE_CELL_COUNT = CUBE_SIZE ** 3;
export const TARGET_COUNT = 8;

export interface CubeCell {
  id: number;
  x: number;
  y: number;
  z: number;
  value: number;
  tens: number;
  ones: number;
}

export interface CubePuzzle {
  seed: number;
  cells: CubeCell[];
  targets: number[];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(values: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

export function createCubePuzzle(seed: number): CubePuzzle {
  const normalizedSeed = seed >>> 0;
  const values = shuffled(
    Array.from({ length: 90 }, (_, index) => index + 10),
    normalizedSeed,
  ).slice(0, CUBE_CELL_COUNT);

  const cells = values.map((value, id): CubeCell => ({
    id,
    x: id % CUBE_SIZE,
    y: Math.floor(id / CUBE_SIZE) % CUBE_SIZE,
    z: Math.floor(id / CUBE_SIZE ** 2),
    value,
    tens: Math.floor(value / 10),
    ones: value % 10,
  }));

  const targetIds = shuffled(
    cells.map((cell) => cell.id),
    normalizedSeed ^ 0x9e3779b9,
  );

  // Seed the route with one target from every depth before filling the rest.
  const firstByDepth = Array.from({ length: CUBE_SIZE }, (_, z) =>
    targetIds.find((id) => cells[id]?.z === z),
  ).filter((id): id is number => id !== undefined);
  const remaining = targetIds.filter((id) => !firstByDepth.includes(id));
  const targets = [...firstByDepth, ...remaining]
    .slice(0, TARGET_COUNT)
    .map((id) => cells[id]!.value);

  return { seed: normalizedSeed, cells, targets };
}
