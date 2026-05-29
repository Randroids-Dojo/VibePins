// Physics smoke for the ball. Runs the real Rapier WASM (no renderer) against
// the real config: the ball rolls down-lane without tunnelling (REQ-029), rests
// on the bed under gravity, and a launched ball knocks down a tethered pin,
// proving the launch drives a real pin-fall through the physics.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER, gutterBoxes, pitBoxes, type Box } from '../src/config.js';
import { ballSpawnPosition, ballLaunchVelocity } from '../src/ball.js';
import { pinRackPositions, pinMassProperties, neckLocalAnchor } from '../src/pins.js';

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

function addBall(world: RAPIER.World): RAPIER.RigidBody {
  const s = ballSpawnPosition();
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(s.x, s.y, s.z)
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

function launch(body: RAPIER.RigidBody): void {
  const v = ballLaunchVelocity();
  body.setLinvel(v, true);
  body.setAngvel({ x: v.z / LANE.ballRadius, y: 0, z: 0 }, true);
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

// A pin's up-axis Y, from its rotation quaternion. ~1 upright, drops as it tips.
const upAxisY = (body: RAPIER.RigidBody): number => {
  const r = body.rotation();
  return 1 - 2 * (r.x * r.x + r.z * r.z);
};

describe('ball rolls down the lane (REQ-029)', () => {
  it('travels far down-lane on the bed without drifting or tunnelling', () => {
    const world = makeWorld();
    addBed(world);
    const ball = addBall(world);
    const spawn = ballSpawnPosition();
    // Defense-in-depth: the ball really starts on the bed (guards the earlier
    // spawn-behind-the-foul-line fall-through regression).
    expect(ball.translation().z).toBeCloseTo(spawn.z, 4);
    expect(ball.translation().y).toBeCloseTo(spawn.y, 4);
    launch(ball);

    let minY = Infinity;
    for (let i = 0; i < 90; i += 1) {
      world.step();
      minY = Math.min(minY, ball.translation().y);
    }

    const end = ball.translation();
    expect(end.z).toBeLessThan(spawn.z - 8); // moved many metres toward the pins
    expect(Math.abs(end.x)).toBeLessThan(0.1); // no sideways drift on a straight launch
    expect(minY).toBeGreaterThan(0); // never punched through the bed (CCD holds)
    expect(end.y).toBeGreaterThan(0.03); // still riding on the bed
    // Still rolling forward (omega_x stays strongly negative), not sliding. A
    // wrong-signed or friction-killed spin would not hold this.
    expect(ball.angvel().x).toBeLessThan(-50);
    world.free();
  });
});

describe('ball rests on the bed under gravity', () => {
  it('settles at the ball radius above the bed surface', () => {
    const world = makeWorld();
    addBed(world);
    const ball = addBall(world); // no launch
    for (let i = 0; i < 120; i += 1) world.step();

    const y = ball.translation().y;
    expect(y).toBeGreaterThan(0);
    expect(y).toBeCloseTo(LANE.floorY + LANE.ballRadius, 2);
    // Damping has brought it to rest, not left it jittering on the bed.
    const lin = ball.linvel();
    expect(Math.hypot(lin.x, lin.y, lin.z)).toBeLessThan(0.05);
    const ang = ball.angvel();
    expect(Math.hypot(ang.x, ang.y, ang.z)).toBeLessThan(0.5);
    world.free();
  });
});

describe('launched ball knocks down a tethered pin (REQ-029 integration)', () => {
  it('topples at least one pin then comes to rest contained in the pit', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    addContainment(world); // gutters + back pit, so the ball is caught, not lost
    const pins = addTetheredRack(world);
    const ball = addBall(world);
    launch(ball);

    // Track the lowest tilt each pin ever reached, so a pin that topples and
    // then swings back on its slack cord still counts (final-state-only would
    // miss it). Also track the ball's lowest point to prove it never fell into
    // the void: with the pit in place it should bottom out in the recessed pit.
    const minUpAxisY = pins.map(() => 1);
    let ballMinY = Infinity;
    for (let i = 0; i < 360; i += 1) {
      world.step();
      ballMinY = Math.min(ballMinY, ball.translation().y);
      pins.forEach((pin, j) => {
        minUpAxisY[j] = Math.min(minUpAxisY[j], upAxisY(pin));
      });
    }

    // The ball reached the pin deck.
    const end = ball.translation();
    expect(end.z).toBeLessThan(LANE.headSpot.z + 1);
    // At least one pin clearly toppled (tilted past ~53 degrees off vertical).
    // A ball that passed through untouched would topple nothing, so this also
    // proves real momentum transfer into the rack.
    const toppled = minUpAxisY.filter((m) => m < 0.6).length;
    expect(toppled).toBeGreaterThanOrEqual(1);
    // Now that the back pit exists (F-004), the launch resolves into a contained
    // end state: the ball clears the rack, drops into the recessed pit, and is
    // caught by the pit floor rather than falling forever. This closes REQ-029's
    // full launch-to-rest arc that the earlier pitless smoke could not assert.
    expect(ballMinY).toBeGreaterThan(LANE.floorY - LANE.pitDepth - LANE.ballRadius - 0.1);
    expect(end.y).toBeGreaterThan(LANE.floorY - LANE.pitDepth - LANE.ballRadius - 0.1);
    const v = ball.linvel();
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(0.6); // settled in the pit, not careening
    world.free();
  });
});
