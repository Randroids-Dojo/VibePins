// Physics smoke for the reset cycle. Runs the real Rapier WASM (no renderer):
// knock some pins, then run the ResetCycle carrying the fallen pins kinematically
// and confirm they are lifted clear of the deck and set back upright near their
// home spots, while standing pins are not disturbed (REQ-018 to REQ-021).

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

describe('reset cycle reels fallen pins up and respots them', () => {
  it('lifts the fallen pins off the deck and sets them upright near home, leaving standing pins alone', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    // Settle the fresh rack, then knock the three front pins down with a shove.
    for (let i = 0; i < 60; i += 1) world.step();
    for (const i of [0, 1, 2]) {
      pins[i].setLinvel({ x: 2.5, y: 0, z: 0 }, true);
      pins[i].setAngvel({ x: 0, y: 0, z: -16 }, true);
    }
    for (let i = 0; i < 180; i += 1) world.step();

    const before = classifyRack(kinematics(pins), DETECTION);
    const fallen = before.filter((p) => !p.standing).map((p) => p.pinIndex);
    const standing = before.filter((p) => p.standing).map((p) => p.pinIndex);
    expect(fallen.length).toBeGreaterThanOrEqual(3); // the three shoved pins fell
    expect(standing.length).toBeGreaterThan(0); // and some are left standing to protect
    const standingPos = new Map(standing.map((i) => [i, pins[i].translation()]));

    // Carry the fallen pins through the reset.
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
    for (const i of fallen) {
      pins[i].setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      pins[i].setLinvel({ x: 0, y: 0, z: 0 }, true);
      pins[i].setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (let i = 0; i < 60; i += 1) world.step(); // let the set-down pins settle

    // Every fallen pin was carried clear of the deck (lifted, not wiped, REQ-020).
    expect(Math.min(...fallen.map((i) => maxLift[i]))).toBeGreaterThan(LANE.pinHeight);

    // Each reeled pin came back upright on its home spot (REQ-018).
    for (const i of fallen) {
      const p = pins[i].translation();
      expect(Math.hypot(p.x - homes[i].x, p.z - homes[i].z)).toBeLessThan(0.1);
      expect(upAxisY(pins[i])).toBeGreaterThan(0.9);
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
