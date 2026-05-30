// Integration smoke for the full lane physics (GDD REQ-029 roll, REQ-030 pinfall,
// REQ-031 gutters). A human playtest found three defects the pure-logic tests miss
// because they never build the whole running sim: the ball launches into the air
// off an unintended ramp and strikes pins on the lane sides, only the first pin
// ever falls, and gutter balls are impossible to get. This runs the real Rapier
// WASM against the SAME colliders world3d builds from the production config (bed,
// pin deck, gutters, pit, and the tethered rack), and asserts the running sim
// behaves:
//   (a) a centred normal-speed ball stays at bed height the whole way down (never
//       goes airborne above a small epsilon, i.e. no ramp launch),
//   (b) it reaches the pin deck,
//   (c) a solid pocket hit topples at least three pins (not just the head pin),
//   (d) a ball aimed hard into the side ends up down in the gutter channel.
//
// These failed before the gutter-lip fix (the inner lip was a raised rail over the
// outer bed that launched the ball and blocked gutter entry) and pass after it.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER, PIN_PHYSICS, gutterBoxes, pitBoxes, type Box } from '../src/config.js';
import { ballSpawnPosition, ballLaunchVelocity } from '../src/ball.js';
import { pinRackPositions, pinMassProperties, neckLocalAnchor } from '../src/pins.js';

beforeAll(async () => {
  await RAPIER.init();
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const FRONT_Z = LANE.headSpot.z + 0.15;
const BACK_Z = LANE.headSpot.z - LANE.pinDeckDepth;

function makeWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = 1 / 60;
  return world;
}

// Exactly the colliders world3d.buildLaneCollider / buildPinDeckCollider build.
function addBed(world: RAPIER.World): void {
  const bed = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, -LANE.length / 2),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, LANE.length / 2), bed);
}

function addDeck(world: RAPIER.World): void {
  const deck = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, (FRONT_Z + BACK_Z) / 2),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, (FRONT_Z - BACK_Z) / 2), deck);
}

function addStaticBox(world: RAPIER.World, box: Box): void {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(box.center.x, box.center.y, box.center.z),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(box.half.x, box.half.y, box.half.z), body);
}

function addContainment(world: RAPIER.World): void {
  for (const box of gutterBoxes()) addStaticBox(world, box);
  for (const box of pitBoxes()) addStaticBox(world, box);
}

function addBall(world: RAPIER.World, startX = 0): RAPIER.RigidBody {
  const s = ballSpawnPosition();
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(s.x + startX, s.y, s.z)
      .setCcdEnabled(true)
      .setLinearDamping(LANE.ballLinearDamping)
      .setAngularDamping(LANE.ballAngularDamping),
  );
  world.createCollider(
    RAPIER.ColliderDesc.ball(LANE.ballRadius)
      .setMass(LANE.ballMass)
      .setFriction(LANE.ballFriction)
      .setRestitution(LANE.ballRestitution)
      .setCollisionGroups((GROUP.BALL << 16) | 0xffff),
    body,
  );
  return body;
}

function launch(body: RAPIER.RigidBody, vel: { x: number; y: number; z: number }): void {
  body.setLinvel(vel, true);
  // Mirror Ball.launch(): the forward roll is LANE.ballLaunchTopspin of pure
  // rolling-without-slip, so the smoke reflects the real shot (full topspin made
  // the ball climb the head pin and fly over the rack; see carry-through.smoke).
  body.setAngvel({ x: (vel.z / LANE.ballRadius) * LANE.ballLaunchTopspin, y: 0, z: 0 }, true);
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
        .setFriction(PIN_PHYSICS.friction)
        .setRestitution(PIN_PHYSICS.restitution)
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

const upAxisY = (body: RAPIER.RigidBody): number => {
  const r = body.rotation();
  return 1 - 2 * (r.x * r.x + r.z * r.z);
};

describe('a centred ball rolls flat down the full lane without launching (REQ-029)', () => {
  it('never goes airborne off a lane-edge ramp and reaches the pin deck', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    addContainment(world); // gutters + pit, exactly as world3d builds them
    const ball = addBall(world);
    launch(ball, ballLaunchVelocity(0, 0, 0)); // centred, full power, no spin

    // The ball rides on the bed at y = floorY + ballRadius. A ramp launch would
    // pop it well above that. Allow a small epsilon for contact jitter only. Only
    // measure airborne height over the lane run (before the deck front), since at
    // the deck the empty pit can legitimately let it drop and a real rack would
    // lift it. Step enough frames for an 8 m/s ball to traverse the ~18m lane.
    const restY = LANE.floorY + LANE.ballRadius;
    const airborneEpsilon = 0.03;
    const deckFrontZ = LANE.headSpot.z + 0.15;
    let maxYOnLane = -Infinity;
    let reachedDeck = false;
    for (let i = 0; i < 240; i += 1) {
      world.step();
      const t = ball.translation();
      if (t.z > deckFrontZ) {
        maxYOnLane = Math.max(maxYOnLane, t.y);
      } else {
        reachedDeck = true;
      }
    }

    // (a) stayed flat the whole way down the lane: never launched above the bed
    expect(maxYOnLane).toBeLessThan(restY + airborneEpsilon);
    // (b) reached the pin deck
    expect(reachedDeck).toBe(true);
    world.free();
  });
});

describe('a solid pocket hit drives through the rack (REQ-030)', () => {
  it('topples at least three pins, not just the head pin', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    addContainment(world);
    const pins = addTetheredRack(world);
    for (let i = 0; i < 60; i += 1) world.step(); // settle the rack

    // A straight centred shot into the head pin: the ball must drive on through
    // and carry the pins behind it. The "only the first pin gets hit" bug left a
    // launched ball clipping one pin; a flat-rolling ball into the rack reaches
    // the rows behind the head pin and topples several.
    const ball = addBall(world, 0);
    launch(ball, ballLaunchVelocity(0, 0, 0));

    const minUpAxisY = pins.map(() => 1);
    for (let i = 0; i < 360; i += 1) {
      world.step();
      pins.forEach((pin, j) => {
        minUpAxisY[j] = Math.min(minUpAxisY[j], upAxisY(pin));
      });
    }

    // (c) at least three pins clearly toppled (tilted past ~53 degrees). A ball
    // that launches and clips only the head pin would topple one.
    const toppled = minUpAxisY.filter((m) => m < 0.6).length;
    expect(toppled).toBeGreaterThanOrEqual(3);
    world.free();
  });
});

describe('a ball aimed hard into the side becomes a gutter ball (REQ-031)', () => {
  it('ends up down in the gutter channel, not bounced back onto the lane', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    addContainment(world);
    // A realistic errant shot: full-speed down-lane with a steady drift to the
    // right, the kind of throw that should leak into the gutter.
    const ball = addBall(world);
    launch(ball, { x: 1.2, y: 0, z: -LANE.ballLaunchSpeed });

    const gutterInnerX = LANE.width / 2;
    const gutterOuterX = LANE.width / 2 + LANE.gutterWidth;
    let everInGutter = false;
    for (let i = 0; i < 240; i += 1) {
      world.step();
      const t = ball.translation();
      if (t.y < LANE.floorY && t.x > gutterInnerX && t.x < gutterOuterX + LANE.ballRadius) {
        everInGutter = true;
      }
    }

    // (d) it dropped into the recessed gutter (never bounced back up onto the
    // lane bed) and finished below bed level, carried down the channel toward the
    // pit rather than rolling into the pocket.
    const end = ball.translation();
    expect(everInGutter).toBe(true);
    expect(end.y).toBeLessThan(LANE.floorY);
    expect(end.z).toBeLessThan(ballSpawnPosition().z - 5);
    world.free();
  });
});
