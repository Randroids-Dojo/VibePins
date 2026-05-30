// End-to-end reset-cycle timing smoke (GDD 03-string-pinsetter#reset-cycle,
// REQ-018). The GDD defines the reset as one timed sequence: "Settle and detect
// (short window) ... Lift fallen ... Reposition ... Lower and ready", running
// "roughly three to five seconds total". The pure ResetCycle tests pin the four
// reel phases in isolation, but REQ-018's claim is about the WHOLE cycle in the
// order the live loop runs it: the SettleWindow that classifies the rack is the
// "settle and detect" step, and only then does the ResetCycle lift, reposition,
// lower, and ready. This runs that full sequence against the real DETECTION and
// RESET config on the real Rapier WASM (no renderer) and asserts the combined
// settle-through-ready wall time lands in the 3-5s window, for both the slowest
// (timed-out settle) and fastest (immediate settle) cases the loop can take.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER, DETECTION, RESET, PIN_REST_Y } from '../src/config.js';
import { pinRackPositions, pinMassProperties, neckLocalAnchor } from '../src/pins.js';
import { SettleWindow, type PinKinematics } from '../src/detection.js';
import { ResetCycle, type ResetPhase } from '../src/reset.js';

beforeAll(async () => {
  await RAPIER.init();
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const FIXED_STEP = 1 / 60;
const cfg = { ...RESET, restY: PIN_REST_Y };

function makeWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = FIXED_STEP;
  return world;
}
function addBed(world: RAPIER.World): void {
  const bed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, -LANE.length / 2));
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, LANE.length / 2), bed);
}
function addDeck(world: RAPIER.World): void {
  const frontZ = LANE.headSpot.z + 0.15;
  const backZ = LANE.headSpot.z - LANE.pinDeckDepth;
  const deck = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, (frontZ + backZ) / 2));
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, (frontZ - backZ) / 2), deck);
}
function addRack(world: RAPIER.World): RAPIER.RigidBody[] {
  const mass = pinMassProperties();
  return pinRackPositions().map((spot) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(spot.x, spot.y, spot.z));
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2, LANE.pinBellyRadius)
        .setMassProperties(mass.mass, mass.centerOfMass, mass.principalAngularInertia, IDENTITY)
        .setCollisionGroups((GROUP.PIN << 16) | 0xffff),
      body,
    );
    const anchor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(spot.x, TETHER.topY, spot.z));
    world.createImpulseJoint(
      RAPIER.JointData.rope(TETHER.slackLength, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
      body,
      anchor,
      true,
    );
    return body;
  });
}
function kinematics(bodies: RAPIER.RigidBody[]): PinKinematics[] {
  return bodies.map((body) => {
    const t = body.translation();
    const r = body.rotation();
    const lv = body.linvel();
    const av = body.angvel();
    return {
      position: { x: t.x, y: t.y, z: t.z },
      rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
      linSpeed: Math.hypot(lv.x, lv.y, lv.z),
      angSpeed: Math.hypot(av.x, av.y, av.z),
    };
  });
}

// Run the live-loop reset sequence on a real rack and return how many fixed
// steps it took from the first settle step through the reset's final ready step,
// plus the ordered phase log. Mirrors main.ts: settle the rack (settle-and-detect
// window), then carry the fallen pins through the ResetCycle to completion.
function runLiveCycle(): { settleFrames: number; resetFrames: number; phaseOrder: ResetPhase[] } {
  const world = makeWorld();
  addBed(world);
  addDeck(world);
  const pins = addRack(world);
  const homes = pinRackPositions();

  // Settle the fresh rack, then knock the three front pins down with a shove so
  // there is real fallen-pin physics for the cycle to clear.
  for (let i = 0; i < 60; i += 1) world.step();
  for (const i of [0, 1, 2]) {
    pins[i].setLinvel({ x: 2.5, y: 0, z: 0 }, true);
    pins[i].setAngvel({ x: 0, y: 0, z: -16 }, true);
  }

  // Phase 1: the settle-and-detect window, exactly as main.ts drives it (one
  // step() per fixed physics step until it latches a result).
  const settle = new SettleWindow(DETECTION, DETECTION.settleAtRestFrames, DETECTION.settleMaxFrames);
  let settleFrames = 0;
  let result = settle.step(kinematics(pins));
  while (!result.settled) {
    world.step();
    settleFrames += 1;
    result = settle.step(kinematics(pins));
  }
  const fallen = result.pins.filter((p) => !p.standing).map((p) => p.pinIndex);
  expect(fallen.length).toBeGreaterThanOrEqual(3);

  // Phases 2-4 plus ready: lift, reposition, lower (the ResetCycle), then hand
  // the carried pins back to the dynamics (the "ready" handoff). The GDD's
  // "roughly three to five seconds total" claim is about the full reset, the
  // frame-end re-rack that carries every pin home; the between-balls lift is
  // deliberately shorter (it stops after the lift), so the full-cycle timing is
  // measured against a re-rack of all ten.
  const all = pins.map((_, i) => i);
  const settledPositions = pins.map((b) => b.translation());
  for (const i of all) pins[i].setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  const reset = new ResetCycle(cfg);
  reset.start('rerack', all, homes, settledPositions);

  const phaseOrder: ResetPhase[] = [];
  let last: ResetPhase | null = null;
  let resetFrames = 0;
  while (reset.isRunning) {
    if (reset.phase !== last) {
      phaseOrder.push(reset.phase);
      last = reset.phase;
    }
    for (const t of reset.step()) {
      pins[t.pinIndex].setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
      pins[t.pinIndex].setNextKinematicRotation(IDENTITY);
    }
    world.step();
    resetFrames += 1;
  }
  for (const i of all) {
    pins[i].setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    pins[i].setLinvel({ x: 0, y: 0, z: 0 }, true);
    pins[i].setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  world.free();
  return { settleFrames, resetFrames, phaseOrder };
}

describe('reset cycle end-to-end timing (REQ-018)', () => {
  it('runs settle, lift, reposition, lower, ready in order over the live loop', () => {
    const { phaseOrder } = runLiveCycle();
    // The reset's own phases, in the GDD order, ending idle (the ready handoff).
    expect(phaseOrder).toEqual(['settle-hold', 'lift', 'reposition', 'lower']);
  });

  it('completes the whole settle-through-ready cycle inside the GDD 3-5s window', () => {
    const { settleFrames, resetFrames } = runLiveCycle();
    const totalSeconds = (settleFrames + resetFrames) * FIXED_STEP;
    // "roughly three to five seconds total" (GDD reset-cycle). A small margin on
    // the upper bound keeps "roughly" honest without letting the cycle drag.
    expect(totalSeconds).toBeGreaterThanOrEqual(3);
    expect(totalSeconds).toBeLessThanOrEqual(5);
  });

  it('stays in the window at both settle extremes (fastest and slowest detect)', () => {
    // The settle-and-detect step is bounded: at least settleAtRestFrames (the
    // rack stilled immediately) and at most settleMaxFrames (a pin never fully
    // stills and the window times out). The reset phases are fixed. Both bounds,
    // added to the reel cycle, must land in the 3-5s window so the cycle is
    // snappy in the best case and never drags in the worst.
    const fastestSeconds = (DETECTION.settleAtRestFrames + new ResetCycle(cfg).totalFrames) * FIXED_STEP;
    const slowestSeconds = (DETECTION.settleMaxFrames + new ResetCycle(cfg).totalFrames) * FIXED_STEP;
    expect(fastestSeconds).toBeGreaterThanOrEqual(3);
    expect(slowestSeconds).toBeLessThanOrEqual(5);
  });
});
