// Physics smoke for the physical ball-return cradle (REQ-039). A human playtest
// found PR #66's rack balls sat on the floor (decorative meshes), not held in
// the metal cradle, and the return was a kinematic ease rather than a real roll.
// This runs the actual Rapier WASM (no renderer) against the SAME cradle
// colliders and queued-ball bodies BallRack builds from the production config,
// and asserts the running sim behaves like Pins Mechanical:
//   (a) the queued balls settle AT REST inside the cradle bounds (on the trough
//       floor between the side walls, ahead of the back stop, behind the front
//       stop), not on the lane floor and not escaping the cradle,
//   (b) once at rest the bodies are asleep (no perpetual jitter / creep),
//   (c) a returned ball dropped in from the back rolls into the queue, collides,
//       and the WHOLE queue (returned ball included) settles at rest again
//       within a bounded number of steps, still inside the cradle bounds.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  LANE,
  BALL_CRADLE,
  BALL_CRADLE_FLOOR_TOP_Y,
  BALL_RETURN,
  ballCradleBoxes,
  ballCradleRestPositions,
} from '../src/config.js';

beforeAll(async () => {
  await RAPIER.init();
});

function makeWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = 1 / 60;
  return world;
}

// Exactly the static cradle BallRack builds: trough floor, side walls, front and
// back stops, as axis-aligned cuboids.
function addCradle(world: RAPIER.World): void {
  for (const box of ballCradleBoxes()) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(box.center.x, box.center.y, box.center.z),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(box.half.x, box.half.y, box.half.z)
        .setFriction(LANE.ballFriction)
        .setRestitution(LANE.ballRestitution),
      body,
    );
  }
  // A floor far below, so a ball that somehow escaped the cradle would fall well
  // under it (the test asserts the balls stay up in the cradle, never down here).
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.2, 2.2));
  world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.05, 2), floor);
}

// A dynamic ball body, same params as the playable ball / BallRack queued balls.
function addBall(world: RAPIER.World, x: number, y: number, z: number): RAPIER.RigidBody {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setCcdEnabled(true)
      .setLinearDamping(LANE.ballLinearDamping)
      .setAngularDamping(LANE.ballAngularDamping),
  );
  world.createCollider(
    RAPIER.ColliderDesc.ball(LANE.ballRadius)
      .setMass(LANE.ballMass)
      .setFriction(LANE.ballFriction)
      .setRestitution(LANE.ballRestitution),
    body,
  );
  return body;
}

// Cradle interior bounds a settled ball centre must stay within.
const rack = ballCradleRestPositions();
const front = rack[0];
const back = rack[rack.length - 1];
const X = front.x;
const HALF_X = BALL_CRADLE.innerHalfX;
const FRONT_Z = front.z + LANE.ballRadius + BALL_CRADLE.stopGap; // front-stop inner face
const BACK_Z = back.z - LANE.ballRadius - 0.02; // back-stop inner face
const FLOOR_TOP = BALL_CRADLE_FLOOR_TOP_Y;

function expectInsideCradle(body: RAPIER.RigidBody): void {
  const t = body.translation();
  // Laterally retained by the side walls.
  expect(t.x).toBeGreaterThan(X - HALF_X);
  expect(t.x).toBeLessThan(X + HALF_X);
  // Held between the front and back stops along z (with a ball-radius margin so
  // the ball centre can sit right against either stop's inner face).
  expect(t.z).toBeGreaterThan(BACK_Z - LANE.ballRadius - 0.01);
  expect(t.z).toBeLessThan(FRONT_Z + 0.01);
  // Resting ON the trough floor (centre a ball radius above the floor top), not
  // sunk through it and not on the lane floor far below.
  expect(t.y).toBeGreaterThan(FLOOR_TOP + LANE.ballRadius - 0.03);
  expect(t.y).toBeLessThan(FLOOR_TOP + LANE.ballRadius + 0.04);
}

function atRest(body: RAPIER.RigidBody): boolean {
  const v = body.linvel();
  const w = body.angvel();
  return Math.hypot(v.x, v.y, v.z) < 0.02 && Math.hypot(w.x, w.y, w.z) < 0.5;
}

describe('physical ball-return cradle (REQ-039)', () => {
  it('holds the queued balls at rest inside the cradle, off the floor', () => {
    const world = makeWorld();
    addCradle(world);
    // Seed the queue exactly as BallRack does (the spare balls behind the front
    // pickup slot), starting at their rest positions.
    const queued = ballCradleRestPositions()
      .slice(1)
      .map((p) => addBall(world, p.x, p.y, p.z));

    for (let i = 0; i < 240; i += 1) world.step();

    for (const body of queued) {
      expectInsideCradle(body);
      expect(atRest(body)).toBe(true);
    }
    // Settled bodies have gone to sleep: no perpetual jitter / creep.
    expect(queued.every((b) => b.isSleeping())).toBe(true);

    world.free();
  });

  it('lets a returned ball roll in, bump the queue, and the whole queue settles at rest', () => {
    const world = makeWorld();
    addCradle(world);
    const queued = ballCradleRestPositions()
      .slice(1)
      .map((p) => addBall(world, p.x, p.y, p.z));

    // Let the queue settle first.
    for (let i = 0; i < 180; i += 1) world.step();
    expect(queued.every((b) => b.isSleeping())).toBe(true);

    // Drop the returned ball in behind the back of the queue, rolling toward the
    // front stop (mirrors Ball.startReturn).
    const returned = addBall(
      world,
      back.x,
      back.y + LANE.ballRadius * 0.5,
      back.z - LANE.ballRadius * 2.4,
    );
    returned.setLinvel({ x: 0, y: 0, z: BALL_RETURN.returnRollSpeed }, true);
    returned.setAngvel({ x: -BALL_RETURN.returnRollSpeed / LANE.ballRadius, y: 0, z: 0 }, true);

    // Step a bounded window; the bump-and-settle must complete within it.
    const all = [...queued, returned];
    let settledStep = -1;
    for (let i = 0; i < 300; i += 1) {
      world.step();
      if (settledStep < 0 && all.every((b) => atRest(b))) settledStep = i;
    }

    // The whole queue (returned ball included) came to rest, bounded in time.
    expect(settledStep).toBeGreaterThanOrEqual(0);
    expect(settledStep).toBeLessThan(300);
    for (const body of all) {
      expectInsideCradle(body);
      expect(atRest(body)).toBe(true);
    }
    // The returned ball pushed the queue: it actually moved toward the stop (it
    // did not pass through the queue or stay where it dropped).
    const returnedZ = returned.translation().z;
    expect(returnedZ).toBeGreaterThan(back.z - LANE.ballRadius * 2.4);

    world.free();
  });
});
