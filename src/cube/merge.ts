import { CUBE_SIZE, type CubeCell, type CubePuzzle } from "./puzzle.js";

export type MergeMethod = "block" | "gaussian" | "graph";
export type ValueReducer = "mean" | "sum" | "median";
export type RgLevel = 0 | 1 | 2;

export interface WeightedMember {
  id: number;
  weight: number;
}

export interface RgPart {
  center: readonly [number, number, number];
  span: number;
}

export interface RgCell {
  id: number;
  key: string;
  value: number;
  rawValue: number;
  mean: number;
  variance: number;
  mass: number;
  center: readonly [number, number, number];
  depth: number;
  members: WeightedMember[];
  parts: RgPart[];
}

export interface CubeRepresentation {
  method: MergeMethod;
  reducer: ValueReducer;
  level: RgLevel;
  gridSize: 4 | 2 | 1;
  cells: RgCell[];
  supportLabel: string;
  fixedPoint: boolean;
}

const METHOD_LABELS: Record<MergeMethod, string> = {
  block: "hard 2×2×2 partition",
  gaussian: "overlap · Gaussian 3³ support",
  graph: "hard 6-neighbor similarity path",
};

function cellById(puzzle: CubePuzzle) {
  return new Map(puzzle.cells.map((cell) => [cell.id, cell]));
}

function consolidateMembers(members: readonly WeightedMember[]) {
  const weights = new Map<number, number>();
  for (const member of members) {
    weights.set(member.id, (weights.get(member.id) ?? 0) + member.weight);
  }
  return [...weights]
    .map(([id, weight]) => ({ id, weight }))
    .filter((member) => member.weight > 1e-9)
    .sort((a, b) => a.id - b.id);
}

function weightedMedian(
  members: readonly WeightedMember[],
  cells: ReadonlyMap<number, CubeCell>,
) {
  const ordered = members
    .map((member) => ({
      value: cells.get(member.id)?.value ?? 0,
      weight: member.weight,
    }))
    .sort((a, b) => a.value - b.value);
  const half = ordered.reduce((sum, item) => sum + item.weight, 0) / 2;
  let cumulative = 0;
  for (const item of ordered) {
    cumulative += item.weight;
    if (cumulative >= half) return item.value;
  }
  return ordered.at(-1)?.value ?? 0;
}

function displayValue(rawValue: number, reducer: ValueReducer) {
  const rounded = Math.round(rawValue);
  if (reducer !== "sum") return Math.max(10, Math.min(99, rounded));
  return 10 + ((((rounded - 10) % 90) + 90) % 90);
}

function mergedCell(
  id: number,
  key: string,
  membersInput: readonly WeightedMember[],
  parts: RgPart[],
  center: readonly [number, number, number],
  gridSize: 4 | 2 | 1,
  nominalMass: number,
  reducer: ValueReducer,
  cells: ReadonlyMap<number, CubeCell>,
): RgCell {
  const members = consolidateMembers(membersInput);
  const weight = members.reduce((sum, member) => sum + member.weight, 0) || 1;
  const mean =
    members.reduce(
      (sum, member) => sum + (cells.get(member.id)?.value ?? 0) * member.weight,
      0,
    ) / weight;
  const variance =
    members.reduce((sum, member) => {
      const delta = (cells.get(member.id)?.value ?? 0) - mean;
      return sum + delta * delta * member.weight;
    }, 0) / weight;
  const rawValue =
    reducer === "mean"
      ? mean
      : reducer === "median"
        ? weightedMedian(members, cells)
        : mean * nominalMass;
  const depthScale = CUBE_SIZE / gridSize;

  return {
    id,
    key,
    value: displayValue(rawValue, reducer),
    rawValue,
    mean,
    variance,
    mass: nominalMass,
    center,
    depth: Math.min(gridSize - 1, Math.floor(center[2] / depthScale)),
    members,
    parts,
  };
}

function makeValuesUnique(cells: RgCell[]) {
  const used = new Set<number>();
  for (const cell of cells) {
    let value = cell.value;
    while (used.has(value)) value = value === 99 ? 10 : value + 1;
    cell.value = value;
    used.add(value);
  }
  return cells;
}

function baseRepresentation(
  puzzle: CubePuzzle,
  method: MergeMethod,
  reducer: ValueReducer,
): CubeRepresentation {
  const cells: RgCell[] = puzzle.cells.map((cell) => ({
    id: cell.id,
    key: `base:${cell.id}`,
    value: cell.value,
    rawValue: cell.value,
    mean: cell.value,
    variance: 0,
    mass: 1,
    center: [cell.x, cell.y, cell.z],
    depth: cell.z,
    members: [{ id: cell.id, weight: 1 }],
    parts: [{ center: [cell.x, cell.y, cell.z], span: 1 }],
  }));
  return {
    method,
    reducer,
    level: 0,
    gridSize: 4,
    cells,
    supportLabel: "source lattice · exact labels",
    fixedPoint: false,
  };
}

function blockRepresentation(
  puzzle: CubePuzzle,
  level: 1 | 2,
  reducer: ValueReducer,
) {
  const source = cellById(puzzle);
  const gridSize = level === 1 ? 2 : 1;
  const span = level === 1 ? 2 : 4;
  const cells: RgCell[] = [];
  let id = 0;
  for (let z = 0; z < gridSize; z++) {
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const members = puzzle.cells
          .filter(
            (cell) =>
              Math.floor(cell.x / span) === x &&
              Math.floor(cell.y / span) === y &&
              Math.floor(cell.z / span) === z,
          )
          .map((cell) => ({ id: cell.id, weight: 1 }));
        const center = [
          x * span + (span - 1) / 2,
          y * span + (span - 1) / 2,
          z * span + (span - 1) / 2,
        ] as const;
        cells.push(
          mergedCell(
            id,
            `block:${level}:${x}:${y}:${z}`,
            members,
            [{ center, span }],
            center,
            gridSize,
            span ** 3,
            reducer,
            source,
          ),
        );
        id++;
      }
    }
  }
  return makeValuesUnique(cells);
}

function gaussianWeight(distance: number, sigma: number, radius: number) {
  if (distance > radius) return 0;
  return Math.exp(-(distance * distance) / (2 * sigma * sigma));
}

function gaussianRepresentation(
  puzzle: CubePuzzle,
  level: 1 | 2,
  reducer: ValueReducer,
) {
  const source = cellById(puzzle);
  const gridSize = level === 1 ? 2 : 1;
  const span = level === 1 ? 2 : 4;
  const sigma = level === 1 ? 0.85 : 1.35;
  const radius = level === 1 ? 1.5 : Infinity;
  const cells: RgCell[] = [];
  let id = 0;
  for (let z = 0; z < gridSize; z++) {
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const center = [
          x * span + (span - 1) / 2,
          y * span + (span - 1) / 2,
          z * span + (span - 1) / 2,
        ] as const;
        const members = puzzle.cells.map((cell) => ({
          id: cell.id,
          weight:
            gaussianWeight(Math.abs(cell.x - center[0]), sigma, radius) *
            gaussianWeight(Math.abs(cell.y - center[1]), sigma, radius) *
            gaussianWeight(Math.abs(cell.z - center[2]), sigma, radius),
        }));
        cells.push(
          mergedCell(
            id,
            `gaussian:${level}:${x}:${y}:${z}`,
            members,
            [{ center, span }],
            center,
            gridSize,
            span ** 3,
            reducer,
            source,
          ),
        );
        id++;
      }
    }
  }
  return makeValuesUnique(cells);
}

function semanticClusters(puzzle: CubePuzzle, targetCount: number) {
  if (targetCount === 1) return [{ ids: puzzle.cells.map((cell) => cell.id) }];

  const byCoordinate = new Map(
    puzzle.cells.map((cell) => [`${cell.x}:${cell.y}:${cell.z}`, cell]),
  );
  const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ] as const;
  let bestGroups: { ids: number[] }[] = [];
  let bestScore = Infinity;
  let bestKey = "";

  for (const permutation of permutations) {
    for (let flipMask = 0; flipMask < 8; flipMask++) {
      const path: CubeCell[] = [];
      for (let outer = 0; outer < CUBE_SIZE; outer++) {
        for (let middleIndex = 0; middleIndex < CUBE_SIZE; middleIndex++) {
          const middle = outer % 2 ? CUBE_SIZE - 1 - middleIndex : middleIndex;
          const row = outer * CUBE_SIZE + middleIndex;
          for (let innerIndex = 0; innerIndex < CUBE_SIZE; innerIndex++) {
            const inner = row % 2 ? CUBE_SIZE - 1 - innerIndex : innerIndex;
            const sourceCoordinate = [inner, middle, outer];
            const coordinate = [0, 0, 0];
            for (let axis = 0; axis < 3; axis++) {
              const value = sourceCoordinate[axis]!;
              coordinate[permutation[axis]!] =
                flipMask & (1 << axis) ? CUBE_SIZE - 1 - value : value;
            }
            path.push(
              byCoordinate.get(coordinate.join(":"))!,
            );
          }
        }
      }

      const groups = Array.from({ length: targetCount }, (_, groupIndex) => ({
        ids: path
          .slice(groupIndex * 8, groupIndex * 8 + 8)
          .map((cell) => cell.id),
      }));
      let score = 0;
      for (const group of groups) {
        const cells = group.ids.map((id) => puzzle.cells[id]!);
        for (let index = 1; index < cells.length; index++) {
          score += Math.abs(cells[index]!.value - cells[index - 1]!.value);
        }
        const ranges = ["x", "y", "z"].map((axis) => {
          const values = cells.map((cell) => cell[axis as "x" | "y" | "z"]);
          return Math.max(...values) - Math.min(...values) + 1;
        });
        score += (ranges[0]! * ranges[1]! * ranges[2]! - 8) * 2;
      }
      const key = path.map((cell) => cell.id).join(":");
      if (score < bestScore || (score === bestScore && key < bestKey)) {
        bestScore = score;
        bestKey = key;
        bestGroups = groups;
      }
    }
  }

  return bestGroups;
}

function graphRepresentation(
  puzzle: CubePuzzle,
  level: 1 | 2,
  reducer: ValueReducer,
) {
  const source = cellById(puzzle);
  const gridSize = level === 1 ? 2 : 1;
  const clusters = semanticClusters(puzzle, level === 1 ? 8 : 1);
  const cells = clusters.map((cluster, id) => {
    const members = cluster.ids.map((memberId) => ({ id: memberId, weight: 1 }));
    const center = [0, 1, 2].map(
      (axis) =>
        cluster.ids.reduce((sum, memberId) => {
          const cell = source.get(memberId);
          return sum + (axis === 0 ? cell?.x : axis === 1 ? cell?.y : cell?.z)!;
        }, 0) / cluster.ids.length,
    ) as [number, number, number];
    const parts = cluster.ids.map((memberId) => {
      const cell = source.get(memberId)!;
      return { center: [cell.x, cell.y, cell.z] as const, span: 1 };
    });
    return mergedCell(
      id,
      `graph:${level}:${cluster.ids.join("-")}`,
      members,
      parts,
      center,
      gridSize,
      cluster.ids.length,
      reducer,
      source,
    );
  });
  cells.sort(
    (a, b) =>
      a.center[2] - b.center[2] ||
      a.center[1] - b.center[1] ||
      a.center[0] - b.center[0],
  );
  cells.forEach((cell, id) => (cell.id = id));
  return makeValuesUnique(cells);
}

export function buildCubeRepresentation(
  puzzle: CubePuzzle,
  method: MergeMethod,
  reducer: ValueReducer,
  level: RgLevel,
): CubeRepresentation {
  if (level === 0) return baseRepresentation(puzzle, method, reducer);
  const gridSize = level === 1 ? 2 : 1;
  const cells =
    method === "block"
      ? blockRepresentation(puzzle, level, reducer)
      : method === "gaussian"
        ? gaussianRepresentation(puzzle, level, reducer)
        : graphRepresentation(puzzle, level, reducer);
  return {
    method,
    reducer,
    level,
    gridSize,
    cells,
    supportLabel: METHOD_LABELS[method],
    fixedPoint: level === 2,
  };
}
