import { describe, expect, test } from "bun:test";
import { createSpatialCursorState, reduceSpatialCursor, type SpatialCursorEnvelope } from "./spatialCursor";

function frame(
  ts: number,
  x = 0,
  z = 1,
  ratio = 0.8,
  confidence = 1,
): Extract<SpatialCursorEnvelope, { state: "tracking" }> {
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  landmarks[5] = { x: 0.4, y: 0.5 };
  landmarks[17] = { x: 0.6, y: 0.5 };
  landmarks[4] = { x: 0.5 - ratio * 0.1, y: 0.5 };
  landmarks[8] = { x: 0.5 + ratio * 0.1, y: 0.5 };
  return {
    version: 1, type: "cursor", ts, sourceId: "test", state: "tracking",
    confidence: { overall: confidence, hand: 1, depth: 1, temporal: 1 },
    space: {
      kind: "calibrated-hand-space", finger: { x, y: 0, z }, direction: { x: 0, y: 0, z: -1 },
      joints3d: { indexMcp: { x: x - 0.05, y: 0, z: z + 0.02 }, indexTip: { x, y: 0, z } },
      landmarks, depthNormalized: 0.5, capture: { inferenceMirrored: false },
    },
  };
}

describe("spatial cursor reducer", () => {
  test("engages after stable tracking and maps relative XYZ", () => {
    let state = createSpatialCursorState();
    state = reduceSpatialCursor(state, frame(0)).state;
    let result = reduceSpatialCursor(state, frame(210));
    state = result.state;
    expect(result.intents.some((intent) => intent.kind === "engage")).toBe(true);
    result = reduceSpatialCursor(state, frame(260, 0.1, 1.1), { smoothingMs: 1 });
    const move = result.intents.find((intent) => intent.kind === "move");
    expect(move?.kind === "move" && move.x).toBeGreaterThan(0.8);
    expect(move?.kind === "move" && move.depth).toBeGreaterThan(0.6);
  });

  test("requires open arming before a three-frame pinch", () => {
    let state = createSpatialCursorState();
    for (const ts of [0, 210, 220, 230, 240, 250]) state = reduceSpatialCursor(state, frame(ts)).state;
    let starts = 0;
    for (const ts of [260, 270, 280]) {
      const result = reduceSpatialCursor(state, frame(ts, 0, 1, 0.2));
      state = result.state;
      starts += result.intents.filter((intent) => intent.kind === "pinch-start").length;
    }
    expect(starts).toBe(1);
    const released = reduceSpatialCursor(state, frame(300));
    expect(released.intents.some((intent) => intent.kind === "pinch-end")).toBe(true);
  });

  test("lost cancels without a pinch or selection event", () => {
    let state = createSpatialCursorState();
    state = reduceSpatialCursor(state, frame(0)).state;
    state = reduceSpatialCursor(state, frame(220)).state;
    const lost: SpatialCursorEnvelope = {
      version: 1, type: "cursor", ts: 230, sourceId: "test", state: "lost", space: null,
      confidence: { overall: 0, hand: 0, depth: 0, temporal: 0 }, reason: "hand-not-found",
    };
    const result = reduceSpatialCursor(state, lost);
    expect(result.intents).toEqual([{ kind: "rest", reason: "hand-not-found" }]);
    expect(result.state.phase).toBe("rest");
  });

  test("mirror metadata flips horizontal movement exactly once", () => {
    let normal = createSpatialCursorState();
    normal = reduceSpatialCursor(normal, frame(0)).state;
    normal = reduceSpatialCursor(normal, frame(210)).state;
    const normalMove = reduceSpatialCursor(normal, frame(220, 0.1), { smoothingMs: 1 }).state.cursor.x;
    let mirrored = createSpatialCursorState();
    const first = frame(0); first.space.capture.inferenceMirrored = true;
    mirrored = reduceSpatialCursor(mirrored, first).state;
    const second = frame(210); second.space.capture.inferenceMirrored = true;
    mirrored = reduceSpatialCursor(mirrored, second).state;
    const moved = frame(220, 0.1); moved.space.capture.inferenceMirrored = true;
    const mirroredMove = reduceSpatialCursor(mirrored, moved, { smoothingMs: 1 }).state.cursor.x;
    expect(normalMove - 0.5).toBeCloseTo(0.5 - mirroredMove, 6);
  });

  test("recovers from a restarted sender timebase", () => {
    let state = createSpatialCursorState();
    state = reduceSpatialCursor(state, frame(10_000)).state;
    state = reduceSpatialCursor(state, frame(10_210)).state;
    const restarted = reduceSpatialCursor(state, frame(10));
    expect(restarted.state.phase).toBe("engaging");
    expect(restarted.state.lastTs).toBe(10);
  });

  test("requires five open frames before every pinch", () => {
    let state = createSpatialCursorState();
    for (const ts of [0, 210, 220, 230, 240, 250]) state = reduceSpatialCursor(state, frame(ts)).state;
    for (const ts of [260, 270, 280]) state = reduceSpatialCursor(state, frame(ts, 0, 1, 0.2)).state;
    state = reduceSpatialCursor(state, frame(290)).state;
    let starts = 0;
    for (const ts of [300, 310, 320]) {
      const result = reduceSpatialCursor(state, frame(ts, 0, 1, 0.2));
      state = result.state;
      starts += result.intents.filter((intent) => intent.kind === "pinch-start").length;
    }
    expect(starts).toBe(0);
  });

  test("locks to one source until that source is lost", () => {
    let state = createSpatialCursorState();
    state = reduceSpatialCursor(state, frame(0)).state;
    const other = frame(220, 0.2);
    other.sourceId = "other";
    expect(reduceSpatialCursor(state, other).state).toEqual(state);
  });

  test("uses the stable MCP anchor while a pinched fingertip curls", () => {
    let state = createSpatialCursorState();
    for (const ts of [0, 210, 220, 230, 240, 250]) state = reduceSpatialCursor(state, frame(ts)).state;
    for (const ts of [260, 270, 280]) state = reduceSpatialCursor(state, frame(ts, 0, 1, 0.2)).state;
    const before = state.cursor.x;
    const curled = frame(290, 0.3, 1, 0.2);
    curled.space.joints3d.indexMcp = { x: -0.05, y: 0, z: 1.02 };
    const after = reduceSpatialCursor(state, curled, { smoothingMs: 1 }).state.cursor.x;
    expect(after).toBeCloseTo(before, 6);
  });
});
