export const SPATIAL_CURSOR_CHANNEL = "otoji-spatial";

export interface SpatialPoint {
  x: number;
  y: number;
  z: number;
}

export interface SpatialCursorSpace {
  kind: "calibrated-hand-space";
  finger: SpatialPoint;
  direction: SpatialPoint;
  joints3d: { indexMcp: SpatialPoint; indexTip: SpatialPoint };
  landmarks: Array<{ x: number; y: number; z?: number }>;
  depthNormalized: number;
  capture: { inferenceMirrored: boolean };
}

export type SpatialCursorEnvelope =
  | {
      version: 1;
      type: "cursor";
      ts: number;
      sourceId: string;
      state: "tracking";
      space: SpatialCursorSpace;
      confidence: { overall: number; hand: number; depth: number; temporal: number };
    }
  | {
      version: 1;
      type: "cursor";
      ts: number;
      sourceId: string;
      state: "lost";
      space: null;
      confidence: { overall: number; hand: number; depth: number; temporal: number };
      reason?: string;
    };

export type SpatialCursorIntent =
  | { kind: "engage"; x: number; y: number; depth: number }
  | { kind: "move"; x: number; y: number; depth: number }
  | { kind: "pinch-start"; x: number; y: number; depth: number }
  | { kind: "pinch-end"; x: number; y: number; depth: number; durationMs: number }
  | { kind: "rest"; reason: string };

export interface SpatialCursorState {
  phase: "rest" | "engaging" | "engaged";
  stableSince: number;
  lastTs: number;
  anchorHand?: SpatialPoint;
  anchorCursor: { x: number; y: number; depth: number };
  cursor: { x: number; y: number; depth: number };
  filteredHand?: SpatialPoint;
  pinch: "unarmed" | "armed" | "closed";
  openFrames: number;
  closedFrames: number;
  pinchStartedAt?: number;
  pinchCandidate?: { x: number; y: number; depth: number };
  sourceId?: string;
  maxHandScale: number;
}

export interface SpatialCursorOptions {
  engageMs: number;
  confidence: number;
  xyGain: number;
  depthGain: number;
  smoothingMs: number;
}

const DEFAULT_OPTIONS: SpatialCursorOptions = {
  engageMs: 200,
  confidence: 0.35,
  xyGain: 3.6,
  depthGain: 1.4,
  smoothingMs: 55,
};

export function createSpatialCursorState(): SpatialCursorState {
  return {
    phase: "rest",
    stableSince: 0,
    lastTs: 0,
    anchorCursor: { x: 0.5, y: 0.5, depth: 0.5 },
    cursor: { x: 0.5, y: 0.5, depth: 0.5 },
    pinch: "unarmed",
    openFrames: 0,
    closedFrames: 0,
    maxHandScale: 0,
  };
}

const finitePoint = (point: SpatialPoint | undefined) =>
  !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function isSpatialCursorEnvelope(value: unknown): value is SpatialCursorEnvelope {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<SpatialCursorEnvelope>;
  if (frame.version !== 1 || frame.type !== "cursor" || !Number.isFinite(frame.ts)) return false;
  if (frame.state === "lost") return frame.space === null;
  return frame.state === "tracking" && !!frame.space && frame.space.kind === "calibrated-hand-space" &&
    finitePoint(frame.space.finger) && finitePoint(frame.space.direction) &&
    finitePoint(frame.space.joints3d?.indexMcp) && finitePoint(frame.space.joints3d?.indexTip) &&
    Array.isArray(frame.space.landmarks) && frame.space.landmarks.length >= 21 &&
    Number.isFinite(frame.confidence?.overall);
}

function distance2(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function reduceSpatialCursor(
  state: SpatialCursorState,
  frame: SpatialCursorEnvelope,
  overrides: Partial<SpatialCursorOptions> = {},
): { state: SpatialCursorState; intents: SpatialCursorIntent[] } {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const next: SpatialCursorState = { ...state, anchorCursor: { ...state.anchorCursor }, cursor: { ...state.cursor } };
  const intents: SpatialCursorIntent[] = [];
  if (state.sourceId && frame.sourceId !== state.sourceId) return { state, intents };
  if (frame.ts < state.lastTs - 2_000) {
    state = { ...createSpatialCursorState(), cursor: { ...state.cursor }, anchorCursor: { ...state.cursor } };
    return reduceSpatialCursor(state, frame, overrides);
  }
  if (frame.ts < state.lastTs) return { state, intents };
  next.lastTs = frame.ts;

  if (frame.state === "lost" || frame.confidence.overall < options.confidence) {
    if (state.phase !== "rest") intents.push({ kind: "rest", reason: frame.state === "lost" ? frame.reason ?? "lost" : "low-confidence" });
    const releasedSource = !state.sourceId || frame.sourceId === state.sourceId;
    return {
      state: { ...createSpatialCursorState(), cursor: { ...state.cursor }, anchorCursor: { ...state.cursor }, lastTs: frame.ts },
      intents: releasedSource ? intents : [],
    };
  }

  const raw = state.pinch === "closed" ? frame.space.joints3d.indexMcp : frame.space.finger;
  const hand = { x: frame.space.capture.inferenceMirrored ? -raw.x : raw.x, y: raw.y, z: raw.z };
  if (next.phase === "rest") {
    next.sourceId = frame.sourceId;
    next.phase = "engaging";
    next.stableSince = frame.ts;
    next.filteredHand = hand;
    return { state: next, intents };
  }
  if (next.phase === "engaging") {
    next.filteredHand = hand;
    if (frame.ts - next.stableSince < options.engageMs) return { state: next, intents };
    next.phase = "engaged";
    next.anchorHand = hand;
    next.anchorCursor = { ...next.cursor };
    intents.push({ kind: "engage", ...next.cursor });
  }

  const dt = Math.max(1, frame.ts - state.lastTs);
  const alpha = 1 - Math.exp(-dt / options.smoothingMs);
  const previous = next.filteredHand ?? hand;
  next.filteredHand = {
    x: previous.x + (hand.x - previous.x) * alpha,
    y: previous.y + (hand.y - previous.y) * alpha,
    z: previous.z + (hand.z - previous.z) * alpha,
  };
  const anchor = next.anchorHand ?? next.filteredHand;
  next.cursor = {
    x: clamp01(next.anchorCursor.x + (next.filteredHand.x - anchor.x) * options.xyGain),
    y: clamp01(next.anchorCursor.y - (next.filteredHand.y - anchor.y) * options.xyGain),
    depth: clamp01(next.anchorCursor.depth + (next.filteredHand.z - anchor.z) * options.depthGain),
  };
  intents.push({ kind: "move", ...next.cursor });

  const landmarks = frame.space.landmarks;
  const handScale = distance2(landmarks[5]!, landmarks[17]!);
  if (handScale < 0.035) return { state: next, intents };
  next.maxHandScale = Math.max(next.maxHandScale * 0.995, handScale);
  if (next.maxHandScale > 0 && handScale < next.maxHandScale * 0.55) return { state: next, intents };
  const ratio = distance2(landmarks[4]!, landmarks[8]!) / handScale;
  if (ratio > 0.55) {
    next.openFrames += 1;
    next.closedFrames = 0;
    if (state.pinch === "closed") {
      intents.push({ kind: "pinch-end", ...next.cursor, durationMs: frame.ts - (state.pinchStartedAt ?? frame.ts) });
      next.pinchStartedAt = undefined;
      next.pinch = "unarmed";
      next.openFrames = 1;
      const tip = frame.space.joints3d.indexTip;
      next.anchorHand = { x: frame.space.capture.inferenceMirrored ? -tip.x : tip.x, y: tip.y, z: tip.z };
      next.filteredHand = { ...next.anchorHand };
      next.anchorCursor = { ...next.cursor };
    } else if (next.openFrames >= 5) {
      next.pinch = "armed";
    }
  } else if (ratio < 0.35 && next.pinch === "armed") {
    if (next.closedFrames === 0) next.pinchCandidate = { ...next.cursor };
    next.closedFrames += 1;
    if (next.closedFrames >= 3) {
      next.pinch = "closed";
      next.openFrames = 0;
      next.pinchStartedAt = frame.ts;
      const candidate = next.pinchCandidate ?? next.cursor;
      intents.push({ kind: "pinch-start", ...candidate });
      const mcp = frame.space.joints3d.indexMcp;
      next.anchorHand = { x: frame.space.capture.inferenceMirrored ? -mcp.x : mcp.x, y: mcp.y, z: mcp.z };
      next.filteredHand = { ...next.anchorHand };
      next.anchorCursor = { ...next.cursor };
      next.pinchCandidate = undefined;
    }
  } else {
    next.closedFrames = 0;
    next.pinchCandidate = undefined;
  }
  return { state: next, intents };
}

export function createSpatialCursorChannel(onFrame: (frame: SpatialCursorEnvelope) => void) {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(SPATIAL_CURSOR_CHANNEL);
  channel.addEventListener("message", (event) => {
    if (isSpatialCursorEnvelope(event.data)) onFrame(event.data);
  });
  return channel;
}
