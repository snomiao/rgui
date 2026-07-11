export interface WorldSimState {
  position: [number, number, number];
  velocityY: number;
  yaw: number;
  pitch: number;
  logFocusDistance: number;
  grounded: boolean;
  heldRotation: [number, number, number];
  heldDistance: number;
  tick: number;
}

export type WorldAction =
  | "move-forward" | "move-back" | "move-left" | "move-right"
  | "move-up" | "move-down" | "look-left" | "look-right"
  | "look-up" | "look-down" | "focus-far" | "focus-near"
  | "orbit-left" | "orbit-right"
  | "object-yaw-left" | "object-yaw-right" | "object-pitch-up" | "object-pitch-down"
  | "object-roll-left" | "object-roll-right" | "object-far" | "object-near";

export const FIXED_DT = 1 / 60;
export const ARENA_HALF = 8;
export const PLAYER_RADIUS = 0.6;
export type WorldObstacle = readonly [x: number, y: number, z: number, size: number];

export function initialWorldState(): WorldSimState {
  return {
    position: [0, 1.6, 5], velocityY: 0, yaw: 0, pitch: 0,
    logFocusDistance: Math.log(4), grounded: true, heldRotation: [0,0,0], heldDistance: 2.2, tick: 0,
  };
}

export function stepWorld(state: WorldSimState, active: ReadonlySet<WorldAction>, obstacles: readonly WorldObstacle[] = []): WorldSimState {
  const next: WorldSimState = { ...state, position: [...state.position] };
  const moveX = Number(active.has("move-right")) - Number(active.has("move-left"));
  const moveZ = Number(active.has("move-back")) - Number(active.has("move-forward"));
  const length = Math.hypot(moveX, moveZ) || 1;
  const speed = 3.8;
  const localX = moveX / length;
  const localZ = moveZ / length;
  next.position[0] += (localX * Math.cos(state.yaw) + localZ * Math.sin(state.yaw)) * speed * FIXED_DT;
  next.position[2] += (-localX * Math.sin(state.yaw) + localZ * Math.cos(state.yaw)) * speed * FIXED_DT;
  const lookRate = 1.45 * FIXED_DT;
  next.yaw += (Number(active.has("look-left")) - Number(active.has("look-right"))) * lookRate;
  next.pitch = Math.max(-1.35, Math.min(1.35, next.pitch +
    (Number(active.has("look-up")) - Number(active.has("look-down"))) * lookRate));
  next.logFocusDistance = Math.max(Math.log(0.25), Math.min(Math.log(64),
    next.logFocusDistance + (Number(active.has("focus-far")) - Number(active.has("focus-near"))) * 1.8 * FIXED_DT));
  const orbit = (Number(active.has("orbit-left")) - Number(active.has("orbit-right"))) * 0.8 * FIXED_DT;
  if (orbit) {
    const radius = Math.max(0.25, Math.exp(state.logFocusDistance));
    const focusX = state.position[0] - Math.sin(state.yaw) * radius;
    const focusZ = state.position[2] - Math.cos(state.yaw) * radius;
    const dx = state.position[0] - focusX, dz = state.position[2] - focusZ;
    next.position[0] = focusX + dx * Math.cos(orbit) + dz * Math.sin(orbit);
    next.position[2] = focusZ - dx * Math.sin(orbit) + dz * Math.cos(orbit);
    next.yaw += orbit;
  }
  const movementLimit = ARENA_HALF - PLAYER_RADIUS;
  const collides = (x: number, z: number) => obstacles.some(([ox, oy, oz, size]) => {
    const feet = next.position[1] - 1.6;
    const vertical = next.position[1] > oy - size / 2 && feet < oy + size / 2;
    return vertical && Math.abs(x - ox) < size / 2 + PLAYER_RADIUS && Math.abs(z - oz) < size / 2 + PLAYER_RADIUS;
  });
  const candidateX = Math.max(-movementLimit, Math.min(movementLimit, next.position[0]));
  const candidateZ = Math.max(-movementLimit, Math.min(movementLimit, next.position[2]));
  next.position[0] = collides(candidateX, state.position[2]) ? state.position[0] : candidateX;
  next.position[2] = collides(next.position[0], candidateZ) ? state.position[2] : candidateZ;
  const rotationRate = 1.35 * FIXED_DT;
  next.heldRotation = [...state.heldRotation];
  next.heldRotation[1] += (Number(active.has("object-yaw-left")) - Number(active.has("object-yaw-right"))) * rotationRate;
  next.heldRotation[0] += (Number(active.has("object-pitch-up")) - Number(active.has("object-pitch-down"))) * rotationRate;
  next.heldRotation[2] += (Number(active.has("object-roll-left")) - Number(active.has("object-roll-right"))) * rotationRate;
  next.heldDistance = Math.max(0.35, Math.min(8, state.heldDistance + (Number(active.has("object-far")) - Number(active.has("object-near"))) * 2 * FIXED_DT));

  if (active.has("move-up") && state.grounded) {
    next.velocityY = 5.2;
    next.grounded = false;
  }
  if (active.has("move-down") && !state.grounded) next.velocityY -= 8 * FIXED_DT;
  next.velocityY -= 12 * FIXED_DT;
  next.position[1] += next.velocityY * FIXED_DT;
  if (next.position[1] <= 1.6) {
    next.position[1] = 1.6;
    next.velocityY = 0;
    next.grounded = true;
  }
  next.tick++;
  return next;
}

export function hashWorldState(state: WorldSimState): string {
  // This replay hash promises determinism within the pinned JS runtime. The
  // simulation deliberately uses native libm until cross-platform lockstep exists.
  const values = [...state.position, state.velocityY, state.yaw, state.pitch, state.logFocusDistance, ...state.heldRotation, state.heldDistance]
    .map((value) => Math.round(value * 1e9));
  return `${state.tick}|${Number(state.grounded)}|${values.join(",")}`;
}
