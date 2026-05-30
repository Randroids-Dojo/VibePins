// Physics smoke for the genuine-snag up/down shake recovery (GDD
// 03-string-pinsetter, REQ-024) on the real Rapier WASM (no renderer).
//
// Research + product-owner playtest: a genuine tangle is RARE and happens only
// when a downed pin lies across another pin's cord so the cords snag during the
// cord-tension reel-up and a pin cannot rise to its clearance height. The two
// behaviours proved here:
//
//   KEY REGRESSION: a CLEAN rack reels straight up and sets with NO shake. The old
//   wrong model ran an up/down unwind on EVERY reset; the fix must not.
//
//   GENUINE SNAG: a pin whose cord is held low (here, a pin pinned on the deck so
//   its neck never rises to clearance, standing in for a pin lying across its
//   cord) is detected as snagged and triggers the BOUNDED up/down shake, which
//   force-clears within the retry cap (the reset can never hang).

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER, RESET, TANGLE, PIN_REST_Y } from '../src/config.js';
import { pinRackPositions, pinMassProperties, neckLocalAnchor } from '../src/pins.js';
import { isRackSnagged, type PinKinematics } from '../src/detection.js';
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

interface RackPin {
  body: RAPIER.RigidBody;
  anchor: RAPIER.RigidBody;
  joint: RAPIER.ImpulseJoint;
  ropeLength: number;
}

function addRack(world: RAPIER.World): RackPin[] {
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
    const joint = world.createImpulseJoint(
      RAPIER.JointData.rope(TETHER.slackLength, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
      body,
      anchor,
      true,
    );
    return { body, anchor, joint, ropeLength: TETHER.slackLength };
  });
}

function reelPin(world: RAPIER.World, pin: RackPin, length: number): void {
  if (pin.ropeLength === length) return;
  world.removeImpulseJoint(pin.joint, true);
  pin.joint = world.createImpulseJoint(
    RAPIER.JointData.rope(length, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
    pin.body,
    pin.anchor,
    true,
  );
  pin.ropeLength = length;
  pin.body.wakeUp();
}

function kinematics(pins: RackPin[]): PinKinematics[] {
  return pins.map(({ body }) => {
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

// Drive the reset cycle, mirroring main.ts stepReset. `pinnedLow` are pin indices
// held kinematic on the deck so their cords cannot reel them up (the genuine snag
// the detector reads). Returns the distinct phases seen and the final retry count.
function runReset(
  world: RAPIER.World,
  pins: RackPin[],
  reset: ResetCycle,
  pinnedLow: Set<number>,
): { phases: string[]; retries: number; steps: number; minNeckY: number[]; maxNeckY: number[] } {
  const reeled = [...reset.targets];
  const phases: string[] = [];
  const minNeckY = pins.map(() => Infinity);
  const maxNeckY = pins.map(() => -Infinity);
  let captured = false;
  let steps = 0;
  const cap = reset.totalFrames + (TANGLE.shakeDownFrames + TANGLE.shakeUpFrames) * (TANGLE.maxRetries + 2) + 200;

  while (reset.isRunning && steps < cap) {
    const phase = reset.phase;
    if (phases[phases.length - 1] !== phase) phases.push(phase);
    const { targets, reel } = reset.step();

    if (reset.needsSnagVerdict) {
      const snagged = isRackSnagged(kinematics(pins), TETHER.neckLocalY, TANGLE);
      reset.reportSnag(snagged);
      world.step();
      steps += 1;
      continue;
    }

    if (phase === 'reposition' && !captured) {
      for (const i of reeled) {
        if (!pinnedLow.has(i)) pins[i].body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
        reelPin(world, pins[i], TETHER.slackLength);
      }
      reset.updateSettled(kinematics(pins).map((s) => s.position));
      captured = true;
    }

    for (const r of reel) {
      // A pinned-low pin keeps its cord (its body is held kinematic on the deck),
      // so reeling it has no effect, exactly as a pin whose cord is snagged.
      if (!pinnedLow.has(r.pinIndex)) reelPin(world, pins[r.pinIndex], r.ropeLength);
    }
    for (const t of targets) {
      if (pinnedLow.has(t.pinIndex)) continue;
      pins[t.pinIndex].body.setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
      pins[t.pinIndex].body.setNextKinematicRotation(IDENTITY);
    }

    world.step();

    pins.forEach((p, i) => {
      const t = p.body.translation();
      const neckY = t.y + TETHER.neckLocalY * upAxisY(p.body);
      minNeckY[i] = Math.min(minNeckY[i], neckY);
      maxNeckY[i] = Math.max(maxNeckY[i], neckY);
    });
    steps += 1;
  }
  return { phases, retries: reset.retryCount, steps, minNeckY, maxNeckY };
}

describe('genuine-snag shake recovery on the real cord sim (REQ-024)', () => {
  it('KEY REGRESSION: a CLEAN rack reels up and sets with NO shake', () => {
    const world = makeWorld();
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    for (let i = 0; i < 60; i += 1) world.step(); // settle a fresh, clean rack

    const all = pins.map((_, i) => i);
    const settled = pins.map((p) => p.body.translation());
    const reset = new ResetCycle(cfg);
    reset.start('rerack', all, homes, settled);

    const { phases, retries } = runReset(world, pins, reset, new Set());

    // The clean rack reeled straight up and set: it reached the verify-lift read,
    // found no snag, and ran NO shake. This is the reported regression.
    expect(phases).toContain('verify-lift');
    expect(phases).not.toContain('shake-down');
    expect(phases).not.toContain('shake-up');
    expect(retries).toBe(0);
    expect(reset.isComplete()).toBe(true);

    for (const i of reset.landedTargets) {
      pins[i].body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      pins[i].body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      pins[i].body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (let i = 0; i < 60; i += 1) world.step();
    for (const i of all) {
      const t = pins[i].body.translation();
      expect(Math.hypot(t.x - homes[i].x, t.z - homes[i].z)).toBeLessThan(0.1);
      expect(upAxisY(pins[i].body)).toBeGreaterThan(0.9);
    }
    world.free();
  });

  it('a GENUINE snag (a pin held low by a crossed cord) triggers the bounded up/down shake and clears within the cap', () => {
    const world = makeWorld();
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    for (let i = 0; i < 60; i += 1) world.step();

    // Pin one body flat on the deck and hold it kinematic so its cord can never
    // reel it up: a stand-in for a downed pin lying across this pin's cord (the
    // genuine snag). Its neck stays well below the clearance, so isRackSnagged
    // reads a real snag at the verify-lift check.
    const snagPin = 4;
    pins[snagPin].body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    const home = homes[snagPin];
    pins[snagPin].body.setNextKinematicTranslation({ x: home.x, y: restY, z: home.z });
    // Lay it on its side so its neck is low and off-vertical (a fallen, snagged pin).
    pins[snagPin].body.setNextKinematicRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) });
    world.step();

    const all = pins.map((_, i) => i);
    const settled = pins.map((p) => p.body.translation());
    const reset = new ResetCycle(cfg);
    reset.start('rerack', all, homes, settled);

    const pinnedLow = new Set([snagPin]);
    const { phases, retries, steps } = runReset(world, pins, reset, pinnedLow);

    // The snag was detected and the bounded up/down shake ran.
    expect(phases).toContain('verify-lift');
    expect(phases).toContain('shake-down');
    expect(phases).toContain('shake-up');
    expect(retries).toBeGreaterThan(0);

    // The loop is BOUNDED: it terminated within the cap and force-cleared (the
    // snagged pin never reels up, so the recovery always hits the retry cap and
    // sets anyway, so the reset can never hang).
    expect(reset.isComplete()).toBe(true);
    expect(retries).toBe(TANGLE.maxRetries);
    expect(steps).toBeLessThan(
      reset.totalFrames + (TANGLE.shakeDownFrames + TANGLE.shakeUpFrames) * (TANGLE.maxRetries + 2) + 200,
    );
    // The phases ended with the kinematic carry (reposition then lower), so the
    // rack was set despite the snag.
    expect(phases[phases.length - 2]).toBe('reposition');
    expect(phases[phases.length - 1]).toBe('lower');
    world.free();
  });
});
