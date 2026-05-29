// Physics smoke for pin detection. Runs the real Rapier WASM (no renderer): a
// freshly racked, settled rack reads all ten standing, and after a launched ball
// strikes the rack the knocked pins read fallen. Exercises the real classifier
// against real post-strike physics (REQ-016).

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER, DETECTION } from '../src/config.js';
import { ballSpawnPosition, ballLaunchVelocity } from '../src/ball.js';
import { pinRackPositions, pinMassProperties, neckLocalAnchor } from '../src/pins.js';
import { classifyRack, SettleWindow, type PinKinematics } from '../src/detection.js';

beforeAll(async () => {
  await RAPIER.init();
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function makeWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = 1 / 60;
  return world;
}
function addBed(world: RAPIER.World): void {
  const bed = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, -LANE.length / 2),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, LANE.length / 2), bed);
}
function addDeck(world: RAPIER.World): void {
  const frontZ = LANE.headSpot.z + 0.15;
  const backZ = LANE.headSpot.z - LANE.pinDeckDepth;
  const deck = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, (frontZ + backZ) / 2),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, (frontZ - backZ) / 2), deck);
}
function addTetheredRack(world: RAPIER.World): RAPIER.RigidBody[] {
  const mass = pinMassProperties();
  return pinRackPositions().map((spot) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(spot.x, spot.y, spot.z),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2, LANE.pinBellyRadius)
        .setMassProperties(mass.mass, mass.centerOfMass, mass.principalAngularInertia, IDENTITY)
        .setCollisionGroups((GROUP.PIN << 16) | 0xffff),
      body,
    );
    const anchor = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(spot.x, TETHER.topY, spot.z),
    );
    world.createImpulseJoint(
      RAPIER.JointData.rope(TETHER.slackLength, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
      body,
      anchor,
      true,
    );
    return body;
  });
}
function addBall(world: RAPIER.World): RAPIER.RigidBody {
  const s = ballSpawnPosition();
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(s.x, s.y, s.z).setCcdEnabled(true)
      .setLinearDamping(LANE.ballLinearDamping).setAngularDamping(LANE.ballAngularDamping),
  );
  world.createCollider(
    RAPIER.ColliderDesc.ball(LANE.ballRadius).setMass(LANE.ballMass)
      .setFriction(LANE.ballFriction).setRestitution(LANE.ballRestitution)
      .setCollisionGroups((GROUP.BALL << 16) | 0xffff),
    body,
  );
  return body;
}
function launch(body: RAPIER.RigidBody): void {
  const v = ballLaunchVelocity();
  body.setLinvel(v, true);
  body.setAngvel({ x: v.z / LANE.ballRadius, y: 0, z: 0 }, true);
}

// PinKinematics from a live body, mirroring PinSet.pinStates().
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

describe('detection on a real rack', () => {
  it('reads all ten pins standing once a fresh rack has settled', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addTetheredRack(world);
    for (let i = 0; i < 180; i += 1) world.step();

    const result = classifyRack(kinematics(pins), DETECTION);
    expect(result.filter((p) => p.standing).length).toBe(10);
    world.free();
  });

  it('reads knocked pins as fallen after a ball strike', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addTetheredRack(world);
    for (let i = 0; i < 60; i += 1) world.step(); // let the rack settle first
    expect(classifyRack(kinematics(pins), DETECTION).filter((p) => p.standing).length).toBe(10);

    const ball = addBall(world);
    launch(ball);
    for (let i = 0; i < 400; i += 1) world.step(); // ball arrives, pins fall and settle

    const after = classifyRack(kinematics(pins), DETECTION);
    expect(after.filter((p) => p.standing).length).toBeLessThan(10);
    expect(after.filter((p) => !p.standing).length).toBeGreaterThanOrEqual(1);
    world.free();
  });

  it('SettleWindow resolves on real post-strike physics and reads pins fallen', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addTetheredRack(world);
    for (let i = 0; i < 60; i += 1) world.step(); // settle the rack
    const ball = addBall(world);
    launch(ball);
    for (let i = 0; i < 160; i += 1) world.step(); // ball strikes, pins fly

    // Drive the authoritative settle gate over the real settling kinematics with
    // the production thresholds; it resolves by sustained rest or the timeout.
    const win = new SettleWindow(DETECTION, DETECTION.settleAtRestFrames, DETECTION.settleMaxFrames);
    let result = win.step(kinematics(pins));
    for (let i = 0; i < 600 && !result.settled; i += 1) {
      world.step();
      result = win.step(kinematics(pins));
    }

    expect(result.settled).toBe(true);
    expect(result.standingCount + result.fallenCount).toBe(10);
    expect(result.fallenCount).toBeGreaterThanOrEqual(1);
    world.free();
  });
});
