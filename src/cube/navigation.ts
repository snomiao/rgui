export type FocusDirection = "left" | "right" | "up" | "down" | "near" | "far";

export interface FocusCandidate {
  id: number;
  x: number;
  y: number;
  depth: number;
}

export function directionalFocusTarget(
  candidates: readonly FocusCandidate[],
  currentId: number | undefined,
  direction: FocusDirection,
): number | undefined {
  if (candidates.length === 0) return undefined;
  const current = candidates.find((candidate) => candidate.id === currentId) ??
    candidates.reduce((best, candidate) =>
      Math.hypot(candidate.x, candidate.y) < Math.hypot(best.x, best.y) ? candidate : best,
    );
  let best: { id: number; score: number } | undefined;
  for (const candidate of candidates) {
    if (candidate.id === current.id) continue;
    const dx = candidate.x - current.x;
    const dy = candidate.y - current.y;
    const dz = candidate.depth - current.depth;
    let forward = 0;
    let lateral = 0;
    if (direction === "left" || direction === "right") {
      forward = dx * (direction === "left" ? -1 : 1);
      lateral = Math.abs(dy) + Math.abs(dz) * 0.7;
    } else if (direction === "up" || direction === "down") {
      forward = dy * (direction === "up" ? 1 : -1);
      lateral = Math.abs(dx) + Math.abs(dz) * 0.7;
    } else {
      forward = dz * (direction === "far" ? 1 : -1);
      lateral = Math.hypot(dx, dy) * 0.45;
    }
    if (forward <= 1e-5) continue;
    const score = Math.hypot(forward, lateral) + (lateral / forward) * 1.5;
    if (!best || score < best.score) best = { id: candidate.id, score };
  }
  return best?.id;
}

export function depthPlanePanScale(depth: number, verticalFovRadians: number, viewportHeight: number): number {
  if (depth <= 0 || viewportHeight <= 0) return 0;
  return (2 * depth * Math.tan(verticalFovRadians / 2)) / viewportHeight;
}
