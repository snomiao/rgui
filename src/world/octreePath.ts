export type Octant = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface OctreePath {
  root: string;
  octants: readonly Octant[];
}

export function childPath(path: OctreePath, octant: Octant): OctreePath {
  return { root: path.root, octants: [...path.octants, octant] };
}

export function parentPath(path: OctreePath): OctreePath | undefined {
  if (path.octants.length === 0) return undefined;
  return { root: path.root, octants: path.octants.slice(0, -1) };
}

export function encodeOctreePath(path: OctreePath): string {
  return `${encodeURIComponent(path.root)}:${path.octants.join("")}`;
}

export function decodeOctreePath(encoded: string): OctreePath {
  const separator = encoded.indexOf(":");
  if (separator < 0) throw new Error("Invalid octree path");
  const suffix = encoded.slice(separator + 1);
  if (!/^[0-7]*$/.test(suffix)) throw new Error("Invalid octant sequence");
  return {
    root: decodeURIComponent(encoded.slice(0, separator)),
    octants: [...suffix].map((value) => Number(value) as Octant),
  };
}

export function isAncestorPath(ancestor: OctreePath, descendant: OctreePath): boolean {
  return (
    ancestor.root === descendant.root &&
    ancestor.octants.every((octant, index) => descendant.octants[index] === octant)
  );
}

export const isAncestorOrSelfPath = isAncestorPath;
