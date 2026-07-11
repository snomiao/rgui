import { describe, expect, test } from "bun:test";
import { addDyadic, equalsDyadic, splitOctreeVolume, subtractAvailableDyadic, subtractDyadic } from "./dyadic.js";
import {
  childPath,
  decodeOctreePath,
  encodeOctreePath,
  isAncestorPath,
  type OctreePath,
} from "./octreePath.js";
import { WorldInputRouter } from "./inputRouter.js";
import { hashWorldState, initialWorldState, stepWorld, type WorldAction } from "./simulation.js";
import { createWorldModel, materialTotal, materializeCell, mineCell, moveCell, placeCell, semanticWorldHash, setSelectedSlot, setViewDepth } from "./model.js";

describe("world dyadic material accounting", () => {
  test("eight octree children conserve their parent exactly", () => {
    const parent = { mantissa: 1n, exponent: 0 };
    const child = splitOctreeVolume(parent);
    let sum = { mantissa: 0n, exponent: 0 };
    for (let index = 0; index < 8; index++) sum = addDyadic(sum, child);
    expect(sum).toEqual(parent);
  });

  test("mine then place is an exact round trip", () => {
    const world = { mantissa: 31n, exponent: 3 };
    const mined = { mantissa: 1n, exponent: 3 };
    expect(addDyadic(subtractDyadic(world, mined), mined)).toEqual(world);
  });

  test("a transaction cannot mine more material than is available", () => {
    const world = { mantissa: 1n, exponent: 3 };
    expect(subtractAvailableDyadic(world, { mantissa: 2n, exponent: 3 })).toBeUndefined();
    expect(equalsDyadic({ mantissa: 4n, exponent: 2 }, { mantissa: 1n, exponent: 0 })).toBe(true);
  });
});

describe("deterministic world replay", () => {
  test("the same action log produces the same state hash", () => {
    const replay = () => {
      let state = initialWorldState();
      for (let tick = 0; tick < 360; tick++) {
        const actions = new Set<WorldAction>();
        if (tick < 180) actions.add("move-forward");
        if (tick >= 60 && tick < 140) actions.add("look-right");
        if (tick === 20) actions.add("move-up");
        if (tick > 220) actions.add("focus-far");
        state = stepWorld(state, actions);
      }
      return hashWorldState(state);
    };
    expect(replay()).toBe(replay());
  });

  test("manipulation and orbit actions are part of the replayed state", () => {
    const replay = () => {
      let state = initialWorldState();
      const actions = new Set<WorldAction>(["object-roll-right", "object-far", "orbit-left"]);
      for (let tick = 0; tick < 90; tick++) state = stepWorld(state, actions);
      return hashWorldState(state);
    };
    expect(replay()).toBe(replay());
    expect(replay()).not.toBe(hashWorldState(initialWorldState()));
  });

  test("the kinematic player cannot cross an occupied block root", () => {
    let state = initialWorldState();
    const forward = new Set<WorldAction>(["move-forward"]);
    for (let tick = 0; tick < 180; tick++) state = stepWorld(state, forward, [[0, 0.5, 3, 1]]);
    expect(state.position[2]).toBeGreaterThanOrEqual(4.1);
  });

  test("focus-point orbit preserves its pivot", () => {
    let state = initialWorldState();
    const radius = Math.exp(state.logFocusDistance);
    const pivot = [state.position[0] - Math.sin(state.yaw) * radius, state.position[2] - Math.cos(state.yaw) * radius];
    for (let tick = 0; tick < 60; tick++) state = stepWorld(state, new Set<WorldAction>(["orbit-left"]));
    const nextPivot = [state.position[0] - Math.sin(state.yaw) * radius, state.position[2] - Math.cos(state.yaw) * radius];
    expect(Math.hypot(nextPivot[0]! - pivot[0]!, nextPivot[1]! - pivot[1]!)).toBeLessThan(1e-9);
  });
});

describe("eternal octree path ids", () => {
  test("paths round-trip and retain ancestry", () => {
    const root: OctreePath = { root: "chunk:-2,0,4", octants: [] };
    const leaf = childPath(childPath(root, 7), 3);
    expect(decodeOctreePath(encodeOctreePath(leaf))).toEqual(leaf);
    expect(isAncestorPath(root, leaf)).toBe(true);
  });
});

describe("world input routing", () => {
  test("a held key keeps its press-time action across target changes", () => {
    let target = "environment";
    const events: string[] = [];
    const router = new WorldInputRouter({
      resolveAction: (code) => `${target}:${code}`,
      onPress: ({ action }) => events.push(`+${action}`),
      onRelease: ({ action }) => events.push(`-${action}`),
    });
    router.keyDown("KeyH", 10);
    target = "object";
    router.keyUp("KeyH");
    router.keyDown("KeyH", 20);
    expect(events).toEqual([
      "+environment:KeyH",
      "-environment:KeyH",
      "+object:KeyH",
    ]);
  });

  test("entering UI releases movement and captures further keys", () => {
    const events: string[] = [];
    const router = new WorldInputRouter({
      resolveAction: (code) => code,
      onPress: ({ action }) => events.push(`+${action}`),
      onRelease: ({ action }) => events.push(`-${action}`),
    });
    router.keyDown("KeyW", 0);
    router.setContext("ui", 1);
    expect(router.keyDown("KeyA", 1)).toBe(false);
    expect(events).toEqual(["+KeyW", "-KeyW"]);
  });

  test("physical key resync restores a key after leaving UI", () => {
    const events: string[] = [];
    const router = new WorldInputRouter({
      resolveAction: (code) => code,
      onPress: ({ action }) => events.push(`+${action}`),
      onRelease: ({ action }) => events.push(`-${action}`),
    });
    router.keyDown("KeyW", 0);
    router.setContext("ui", 1);
    router.setContext("world", 2);
    router.resync(["KeyW"], 2);
    expect(events).toEqual(["+KeyW", "-KeyW", "+KeyW"]);
  });
});

describe("view-only RG and conserved material transactions", () => {
  test("any Y/O view-depth sequence leaves semantic state unchanged", () => {
    const model = createWorldModel();
    const hash = semanticWorldHash(model);
    let viewed = model;
    for (const depth of [1, 2, 3, 1, 0, 2, 0]) viewed = setViewDepth(viewed, "0,0,0", depth);
    expect(semanticWorldHash(viewed)).toBe(hash);
  });

  test("mine and replace a refined child conserves exact material volume", () => {
    const initial = setSelectedSlot(createWorldModel(), 1);
    const total = materialTotal(initial, "wood");
    const child: OctreePath = { root: "0,0,0", octants: [3] };
    const mined = mineCell(initial, child);
    expect(mined).toBeDefined();
    const placed = placeCell(mined!, child);
    expect(placed).toBeDefined();
    expect(materialTotal(placed!, "wood")).toEqual(total);
  });

  test("repeated random-looking mine/place cycles never drift", () => {
    let model = setSelectedSlot(createWorldModel(), 1);
    const total = materialTotal(model, "wood");
    for (let index = 0; index < 1000; index++) {
      const target: OctreePath = { root: "0,0,0", octants: [index % 8 as 0|1|2|3|4|5|6|7] };
      const mined = mineCell(model, target);
      if (mined) model = placeCell(mined, target) ?? mined;
    }
    expect(materialTotal(model, "wood")).toEqual(total);
  });

  test("refined grab materializes a semantic child and preserves depth on move", () => {
    const source: OctreePath = { root: "0,0,0", octants: [7] };
    const target: OctreePath = { root: "1,0,0", octants: [7] };
    const materialized = materializeCell(createWorldModel(), source)!;
    const moved = moveCell(materialized, source, target, [0.1, 0.2, 0.3]);
    expect(moved).toBeDefined();
    expect(moved!.cells.get(encodeOctreePath(target))?.volume).toEqual({ mantissa: 1n, exponent: 3 });
    expect(moved!.cells.get(encodeOctreePath(target))?.rotation).toEqual([0.1, 0.2, 0.3]);
    expect(moveCell(materialized, source, { root: "1,0,0", octants: [] })).toBeUndefined();
  });

  test("placement refuses occupied ancestors and descendants", () => {
    const model = setSelectedSlot(createWorldModel(), 1);
    expect(placeCell(model, { root: "0,0,0", octants: [2] })).toBeUndefined();
    const mined = mineCell(model, { root: "0,0,0", octants: [2] })!;
    expect(placeCell(mined, { root: "0,0,0", octants: [] })).toBeUndefined();
  });
});
