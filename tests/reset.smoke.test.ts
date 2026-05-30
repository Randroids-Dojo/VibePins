// Physics smoke for the reset cycle. Runs the real Rapier WASM (no renderer).
//
// Two shapes, matching the duckpin rules (REQ-009, REQ-010, REQ-018 to REQ-021):
//   between-balls: knock some pins, then carry the FALLEN pins through the cycle
//   and confirm they are lifted clear of the deck and LEFT held aloft (cleared,
//   never set back down), while standing pins are not disturbed.
//   rerack: carry all ten pins through the full cycle and confirm each is set
//   back upright on its home spot, a fresh rack.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER, DETECTION, RESET } from '../src/config.js';
import { pinRackPositions, pinMassProperties, neckLocalAnchor } from '../src/pins.js';
import { classifyRack, type PinKinematics } from '../src/detection.js';
import { ResetCycle } from '../src/reset.js';

beforeAll(async () => {
  await RAPIER.init();
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const restY = LANE.floorY + LANE.pinHeight / 2;
const cfg = { ...RESET, restY };

function makeWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = 1 / 60;
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
const upAxisY = (b: RAPIER.RigidBody): number => {
  const r = b.rotation();
  return 1 - 2 * (r.x * r.x + r.z * r.z);
};

// Shove the three front pins so they topple, then settle the rack.
function knockFrontPins(world: RAPIER.World, pins: RAPIER.RigidBody[]): void {
  for (let i = 0; i < 60; i += 1) world.step();
  for (const i of [0, 1, 2]) {
    pins[i].setLinvel({ x: 2.5, y: 0, z: 0 }, true);
    pins[i].setAngvel({ x: 0, y: 0, z: -16 }, true);
  }
  for (let i = 0; i < 180; i += 1) world.step();
}

describe('reset cycle: between-balls lift (REQ-009, REQ-020, REQ-021)', () => {
  it('lifts the fallen pins clear of the deck and leaves them aloft, never setting them back down, and never touches standing pins', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    knockFrontPins(world, pins);

    const before = classifyRack(kinematics(pins), DETECTION);
    const fallen = before.filter((p) => !p.standing).map((p) => p.pinIndex);
    const standing = before.filter((p) => p.standing).map((p) => p.pinIndex);
    expect(fallen.length).toBeGreaterThanOrEqual(3); // the three shoved pins fell
    expect(standing.length).toBeGreaterThan(0); // and some are left standing to protect
    const standingPos = new Map(standing.map((i) => [i, pins[i].translation()]));

    // Carry the fallen pins through the between-balls reset.
    const settled = pins.map((b) => b.translation());
    for (const i of fallen) pins[i].setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    const reset = new ResetCycle(cfg);
    reset.start('between-balls', fallen, homes, settled);
    const maxLift = pins.map(() => -Infinity); // track every pin, fallen and standing
    let steps = 0;
    while (reset.isRunning && steps < reset.totalFrames + 5) {
      for (const t of reset.step()) {
        pins[t.pinIndex].setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
        pins[t.pinIndex].setNextKinematicRotation(IDENTITY);
      }
      world.step();
      pins.forEach((b, i) => (maxLift[i] = Math.max(maxLift[i], b.translation().y)));
      steps += 1;
    }
    expect(reset.isComplete()).toBe(true);

    // A between-balls cycle stops after the lift: it never runs reposition/lower.
    expect(steps).toBeLessThan(reset.totalFrames);

    // The lifted pins stay kinematic and aloft (cleared off the deck). They are
    // NOT handed back to the dynamics between balls, so they hold their height
    // rather than dropping back onto the deck.
    for (let i = 0; i < 30; i += 1) world.step();

    // Every fallen pin was carried clear of the deck (lifted, not wiped, REQ-020)
    // and is still up there (cleared, not set back down): only standing pins
    // remain on the deck for the next ball (REQ-009).
    for (const i of fallen) {
      expect(maxLift[i]).toBeGreaterThan(LANE.pinHeight); // carried up off the deck
      expect(pins[i].translation().y).toBeGreaterThan(LANE.pinHeight); // still aloft
    }

    // Standing pins were never lifted and did not move (REQ-021).
    for (const i of standing) {
      expect(maxLift[i]).toBeLessThan(LANE.pinHeight); // never carried up
      const a = standingPos.get(i)!;
      const b = pins[i].translation();
      expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeLessThan(0.05);
    }
    world.free();
  });
});

describe('reset cycle: full re-rack (REQ-010, REQ-018)', () => {
  it('carries all ten pins home and sets them back upright on their home spots', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    knockFrontPins(world, pins);

    // A re-rack reels all ten, wherever they came to rest.
    const all = pins.map((_, i) => i);
    const settled = pins.map((b) => b.translation());
    for (const i of all) pins[i].setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    const reset = new ResetCycle(cfg);
    reset.start('rerack', all, homes, settled);
    const maxLift = pins.map(() => -Infinity);
    let steps = 0;
    while (reset.isRunning && steps < reset.totalFrames + 5) {
      for (const t of reset.step()) {
        pins[t.pinIndex].setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
        pins[t.pinIndex].setNextKinematicRotation(IDENTITY);
      }
      world.step();
      pins.forEach((b, i) => (maxLift[i] = Math.max(maxLift[i], b.translation().y)));
      steps += 1;
    }
    expect(reset.isComplete()).toBe(true);
    // A re-rack runs the full settle-lift-reposition-lower.
    expect(steps).toBe(reset.totalFrames);

    // Hand every pin back to the dynamics and let it settle on its home spot.
    for (const i of all) {
      pins[i].setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      pins[i].setLinvel({ x: 0, y: 0, z: 0 }, true);
      pins[i].setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (let i = 0; i < 60; i += 1) world.step();

    // Every pin was carried clear of the deck during the lift (no sweep, REQ-020)
    // and ended upright on its home spot: a clean fresh rack (REQ-010).
    for (const i of all) {
      expect(maxLift[i]).toBeGreaterThan(LANE.pinHeight);
      const p = pins[i].translation();
      expect(Math.hypot(p.x - homes[i].x, p.z - homes[i].z)).toBeLessThan(0.1);
      expect(upAxisY(pins[i])).toBeGreaterThan(0.9);
    }
    world.free();
  });
});
