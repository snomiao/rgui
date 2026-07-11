import {
  DYADIC_ZERO,
  addDyadic,
  compareDyadic,
  equalsDyadic,
  splitOctreeVolume,
  subtractAvailableDyadic,
  type Dyadic,
} from "./dyadic.js";
import { childPath, encodeOctreePath, isAncestorPath, type OctreePath } from "./octreePath.js";

export type Material = "stone" | "wood" | "water";

export interface MaterialCell {
  path: OctreePath;
  material: Material;
  volume: Dyadic;
  rotation?: readonly [number, number, number];
}

export interface QuickSlot {
  material: Material | null;
  amount: Dyadic;
}

export interface WorldModel {
  cells: ReadonlyMap<string, MaterialCell>;
  slots: readonly QuickSlot[];
  selectedSlot: number;
  viewDepth: ReadonlyMap<string, number>;
}

export function createWorldModel(): WorldModel {
  const cells = new Map<string, MaterialCell>();
  for (const [root, material] of [["0,0,0", "wood"], ["2,0,-2", "stone"], ["-2,0,-1", "stone"], ["0,1,-3", "wood"]] as const) {
    const path: OctreePath = { root, octants: [] };
    cells.set(encodeOctreePath(path), { path, material, volume: { mantissa: 1n, exponent: 0 } });
  }
  const slots: QuickSlot[] = Array.from({ length: 10 }, () => ({ material: null, amount: DYADIC_ZERO }));
  slots[0] = { material: "stone", amount: DYADIC_ZERO };
  slots[1] = { material: "wood", amount: DYADIC_ZERO };
  slots[2] = { material: "water", amount: DYADIC_ZERO };
  return { cells, slots, selectedSlot: 0, viewDepth: new Map() };
}

export function setSelectedSlot(model: WorldModel, selectedSlot: number): WorldModel {
  return { ...model, selectedSlot: Math.max(0, Math.min(9, selectedSlot)) };
}

export function setViewDepth(model: WorldModel, root: string, depth: number): WorldModel {
  const viewDepth = new Map(model.viewDepth);
  viewDepth.set(root, Math.max(0, Math.min(3, Math.round(depth))));
  return { ...model, viewDepth };
}

function materializeToPath(cells: Map<string, MaterialCell>, target: OctreePath): boolean {
  for (let depth = 0; depth < target.octants.length; depth++) {
    const parent: OctreePath = { root: target.root, octants: target.octants.slice(0, depth) };
    const parentKey = encodeOctreePath(parent);
    const source = cells.get(parentKey);
    if (!source) continue;
    cells.delete(parentKey);
    for (let octant = 0; octant < 8; octant++) {
      const path = childPath(parent, octant as 0|1|2|3|4|5|6|7);
      cells.set(encodeOctreePath(path), { path, material: source.material, volume: splitOctreeVolume(source.volume) });
    }
  }
  return cells.has(encodeOctreePath(target));
}

export function materializeCell(model: WorldModel, target: OctreePath): WorldModel | undefined {
  const cells = new Map(model.cells);
  if (!materializeToPath(cells, target)) return undefined;
  return { ...model, cells };
}

function expectedVolume(path: OctreePath): Dyadic {
  let volume: Dyadic = { mantissa: 1n, exponent: 0 };
  for (let depth = 0; depth < path.octants.length; depth++) volume = splitOctreeVolume(volume);
  return volume;
}

function overlapsOccupied(cells: ReadonlyMap<string, MaterialCell>, target: OctreePath, except?: string): boolean {
  for (const [key, cell] of cells) {
    if (key === except) continue;
    if (isAncestorPath(cell.path, target) || isAncestorPath(target, cell.path)) return true;
  }
  return false;
}

export function mineCell(model: WorldModel, target: OctreePath): WorldModel | undefined {
  const cells = new Map(model.cells);
  if (!materializeToPath(cells, target)) return undefined;
  const key = encodeOctreePath(target);
  const cell = cells.get(key)!;
  const slots = model.slots.map((slot) => ({ ...slot }));
  let slotIndex = slots.findIndex((slot) => slot.material === cell.material);
  if (slotIndex < 0) slotIndex = slots.findIndex((slot) => slot.material === null);
  if (slotIndex < 0) return undefined;
  cells.delete(key);
  slots[slotIndex] = { material: cell.material, amount: addDyadic(slots[slotIndex]!.amount, cell.volume) };
  return { ...model, cells, slots };
}

export function placeCell(model: WorldModel, target: OctreePath): WorldModel | undefined {
  const key = encodeOctreePath(target);
  if (overlapsOccupied(model.cells, target)) return undefined;
  const slot = model.slots[model.selectedSlot];
  if (!slot?.material) return undefined;
  const volume = expectedVolume(target);
  const remainder = subtractAvailableDyadic(slot.amount, volume);
  if (!remainder) return undefined;
  const cells = new Map(model.cells);
  cells.set(key, { path: target, material: slot.material, volume });
  const slots = model.slots.map((entry, index) => index === model.selectedSlot ? { ...entry, amount: remainder } : { ...entry });
  return { ...model, cells, slots };
}

export function moveCell(model: WorldModel, source: OctreePath, target: OctreePath, rotation?: readonly [number, number, number]): WorldModel | undefined {
  const sourceKey = encodeOctreePath(source);
  const targetKey = encodeOctreePath(target);
  const cell = model.cells.get(sourceKey);
  if (!cell || source.octants.length !== target.octants.length || !equalsDyadic(cell.volume, expectedVolume(target)) || overlapsOccupied(model.cells, target, sourceKey)) return undefined;
  const cells = new Map(model.cells);
  cells.delete(sourceKey);
  cells.set(targetKey, { ...cell, path: target, rotation: rotation ?? cell.rotation });
  return { ...model, cells };
}

export function materialTotal(model: WorldModel, material: Material): Dyadic {
  let total = DYADIC_ZERO;
  for (const cell of model.cells.values()) if (cell.material === material) total = addDyadic(total, cell.volume);
  for (const slot of model.slots) if (slot.material === material) total = addDyadic(total, slot.amount);
  return total;
}

export function semanticWorldHash(model: WorldModel): string {
  const cells = [...model.cells.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, cell]) => `${id}=${cell.material}:${cell.volume.mantissa}/${cell.volume.exponent}:${cell.rotation?.join(",")??"0,0,0"}`);
  const slots = model.slots.map((slot) => `${slot.material ?? "-"}:${slot.amount.mantissa}/${slot.amount.exponent}`);
  return `${cells.join("|")}#${slots.join("|")}#${model.selectedSlot}`;
}

export function sameMaterialTotal(a: WorldModel, b: WorldModel, material: Material): boolean {
  return equalsDyadic(materialTotal(a, material), materialTotal(b, material));
}

export function canAfford(slot: QuickSlot, amount: Dyadic): boolean {
  return compareDyadic(slot.amount, amount) >= 0;
}
