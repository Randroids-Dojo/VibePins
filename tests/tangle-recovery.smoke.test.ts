// Physics smoke for the tangle drop-and-unwind reset recovery (GDD
// 03-string-pinsetter, REQ-024). Runs the real Rapier WASM (no renderer) against
// the real RESET + TANGLE config so the recovery is proven to run on genuine
// physics, not scripted.
//
// The recovery is emergent and chaotic, so this test does NOT assert a specific
// untangle. It proves the controller-plus-adapter loop the live game runs:
//   1. a snagged/tangled rack is constructed (pins driven across the deck so
//      their cords cross and they pile off their spots),
//   2. the reset reels the whole rack up and, at the top of the lift, lets it
//      hang loose for the tangle read,
//   3. on a tangle the rack visibly DROPS and re-lifts (observable pin Y over
//      time across the release sub-phases),
//   4. the loop is BOUNDED: it always terminates within the retry cap and ends
//      with the rack set on its home spots (the force-clear guarantees no hang).

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER, RESET, TANGLE, PIN_REST_Y } from '../src/config.js';
import { pinRackPositions, pinMassProperties, neckLocalAnchor } from '../src/pins.js';
import { isRackTangled, type PinKinematics } from '../src/detection.js';
import { ResetCycle } from '../src/reset.js';

beforeAll(async () => {
  await RAPIER.init();
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const restY = PIN_REST_Y;
const cfg = { ...RESET, ...TANGLE, restY };
const PIN_GROUPS = (GROUP.PIN << 16) | 0xffff;

function makeWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = 1 / 60;
  return world;
}
function addDeck(world: RAPIER.World): void {
  const frontZ = LANE.headSpot.z + 0.15;
  const backZ = LANE.headSpot.z - LANE.pinDeckDepth;
  const deck = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, (frontZ + backZ) / 2),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, (frontZ - backZ) / 2), deck);
}
function addRack(world: RAPIER.World): RAPIER.RigidBody[] {
  const mass = pinMassProperties();
  return pinRackPositions().map((spot) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(spot.x, spot.y, spot.z));
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2, LANE.pinBellyRadius)
        .setMassProperties(mass.mass, mass.centerOfMass, mass.principalAngularInertia, IDENTITY)
        .setCollisionGroups(PIN_GROUPS),
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
const upAxisY = (b: RAPIER.RigidBody): number => {
  const r = b.rotation();
  return 1 - 2 * (r.x * r.x + r.z * r.z);
};

// Drive pins hard across the deck and into each other so the cords cross and the
// pins pile up off their home spots: a genuinely snagged starting state.
function tangleTheRack(world: RAPIER.World, pins: RAPIER.RigidBody[]): void {
  for (let i = 0; i < 60; i += 1) world.step();
  const shoves: [number, number][] = [
    [6, 8],
    [9, -8],
    [3, 7],
    [1, -7],
    [4, 6],
  ];
  for (const [idx, vx] of shoves) {
    pins[idx].setLinvel({ x: vx, y: 2.5, z: -2 }, true);
    pins[idx].setAngvel({ x: 0, y: 0, z: vx < 0 ? 18 : -18 }, true);
  }
  for (let i = 0; i < 180; i += 1) world.step();
}

// Run the reset cycle with the live tangle drop-and-unwind recovery, mirroring
// main.ts stepReset(): the carried pins are kinematic except during verify-clear
// and release, where the rack is dynamic so the hang test and the drop run on
// real physics. Returns observability data: the distinct phases seen, the per-pin
// min/max Y across the recovery sub-phases, and the final retry count.
function runRecovery(
  world: RAPIER.World,
  pins: RAPIER.RigidBody[],
  reset: ResetCycle,
): { phases: string[]; recoveryMinY: number[]; recoveryMaxY: number[]; retries: number; steps: number } {
  const reeled = [...reset.targets];
  const phases: string[] = [];
  const recoveryMinY = pins.map(() => Infinity);
  const recoveryMaxY = pins.map(() => -Infinity);
  let prev = 'idle';
  let steps = 0;
  const cap = reset.totalFrames + (TANGLE.releaseFrames + TANGLE.reLiftFrames + TANGLE.verifyFrames) * (TANGLE.maxRetries + 2) + 50;

  while (reset.isRunning && steps < cap) {
    const targets = reset.step();
    const phase = reset.phase;
    if (phases[phases.length - 1] !== phase) phases.push(phase);

    // Entering verify-clear: the rack has been lowered to just above the deck;
    // let it loose on its cords for the settle and the tangle read.
    if (phase === 'verify-clear' && prev !== 'verify-clear') {
      for (const i of reeled) pins[i].setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    }

    if (reset.needsTangleVerdict) {
      const tangled = isRackTangled(kinematics(pins), RESET.liftPinY, TANGLE);
      reset.reportTangle(tangled);
      prev = phase;
      world.step();
      steps += 1;
      continue;
    }

    // Re-lift just began (after a release, or straight from a clear verdict):
    // re-capture the dropped pins kinematic where they landed.
    if (phase === 're-lift' && prev !== 're-lift') {
      for (const i of reeled) pins[i].setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      reset.updateSettled(kinematics(pins).map((s) => s.position));
    }

    if (phase !== 'verify-clear') {
      for (const t of targets) {
        pins[t.pinIndex].setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
        pins[t.pinIndex].setNextKinematicRotation(IDENTITY);
      }
    }

    world.step();

    // Track Y during the recovery sub-phases only (the drop-and-unwind motion).
    if (phase === 'verify-clear' || phase === 'release' || phase === 're-lift') {
      pins.forEach((b, i) => {
        const y = b.translation().y;
        recoveryMinY[i] = Math.min(recoveryMinY[i], y);
        recoveryMaxY[i] = Math.max(recoveryMaxY[i], y);
      });
    }

    prev = phase;
    steps += 1;
  }

  return { phases, recoveryMinY, recoveryMaxY, retries: reset.retryCount, steps };
}

describe('tangle drop-and-unwind reset recovery on the real cord sim (REQ-024)', () => {
  it('detects the tangle, visibly drops and re-lifts the rack, then clears and sets within the cap', () => {
    const world = makeWorld();
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    tangleTheRack(world, pins);

    // The rack is genuinely snagged before the reset: at least some pins are off
    // their home spots (the cross actually happened).
    const displaced = pins.filter((p, i) => {
      const t = p.translation();
      return Math.hypot(t.x - homes[i].x, t.z - homes[i].z) > LANE.pinSpacing;
    });
    expect(displaced.length).toBeGreaterThan(0);

    // Reel the whole rack: a re-rack carries all ten home with recovery armed.
    const all = pins.map((_, i) => i);
    const settled = pins.map((b) => b.translation());
    for (const i of all) pins[i].setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    const reset = new ResetCycle(cfg);
    reset.start('rerack', all, homes, settled);

    const { phases, recoveryMinY, recoveryMaxY, retries, steps } = runRecovery(world, pins, reset);

    // The cycle ran the recovery: it reached the verify-clear hang test.
    expect(phases).toContain('verify-clear');

    // The loop is BOUNDED: it terminated (did not run out the step cap) within the
    // retry cap, and completed the full cycle.
    expect(reset.isComplete()).toBe(true);
    expect(steps).toBeLessThan(
      reset.totalFrames + (TANGLE.releaseFrames + TANGLE.reLiftFrames + TANGLE.verifyFrames) * (TANGLE.maxRetries + 2) + 50,
    );
    expect(retries).toBeLessThanOrEqual(TANGLE.maxRetries);

    // The tangled rack was real, so the recovery loop should have actually dropped
    // and re-lifted at least once: a release phase ran and the rack moved through
    // a visible Y range during the recovery sub-phases (RULE 10 observable motion).
    expect(phases).toContain('release');
    expect(retries).toBeGreaterThan(0);
    const movedPins = recoveryMaxY.filter((maxY, i) => maxY - recoveryMinY[i] > 0.1);
    expect(movedPins.length).toBeGreaterThan(0);

    // Hand the rack back to the dynamics and let it settle, exactly as the live
    // loop does on completion.
    for (const i of reset.landedTargets) {
      pins[i].setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      pins[i].setLinvel({ x: 0, y: 0, z: 0 }, true);
      pins[i].setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (let i = 0; i < 90; i += 1) world.step();

    // After the bounded recovery and the set-down, the rack is cleared: every pin
    // is upright on its home spot, a fresh rack (the force-clear guarantees this
    // even if the physical untangle was imperfect; the next re-rack always sets).
    for (const i of all) {
      const t = pins[i].translation();
      expect(Math.hypot(t.x - homes[i].x, t.z - homes[i].z)).toBeLessThan(0.1);
      expect(upAxisY(pins[i])).toBeGreaterThan(0.9);
    }
    world.free();
  });

  it('a clean (untangled) rack passes the verify-clear check on the first drop with no retries', () => {
    const world = makeWorld();
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    // Settle a fresh rack: nothing is snagged.
    for (let i = 0; i < 60; i += 1) world.step();

    const all = pins.map((_, i) => i);
    const settled = pins.map((b) => b.translation());
    for (const i of all) pins[i].setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    const reset = new ResetCycle(cfg);
    reset.start('rerack', all, homes, settled);

    const { phases, retries } = runRecovery(world, pins, reset);

    // The rack drops once for the hang test, the read finds it clear, and it sets
    // with no retry drops: exactly one release and zero retries.
    expect(phases).toContain('verify-clear');
    expect(phases.filter((p) => p === 'release').length).toBe(1);
    expect(retries).toBe(0);
    expect(reset.isComplete()).toBe(true);

    for (const i of reset.landedTargets) {
      pins[i].setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      pins[i].setLinvel({ x: 0, y: 0, z: 0 }, true);
      pins[i].setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (let i = 0; i < 60; i += 1) world.step();
    for (const i of all) {
      const t = pins[i].translation();
      expect(Math.hypot(t.x - homes[i].x, t.z - homes[i].z)).toBeLessThan(0.1);
      expect(upAxisY(pins[i])).toBeGreaterThan(0.9);
    }
    world.free();
  });
});
