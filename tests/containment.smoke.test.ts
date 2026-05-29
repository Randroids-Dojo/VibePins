// Physics smoke for ball containment (GDD REQ-031 gutters, followup F-004 back
// pit). Runs the real Rapier WASM (no renderer) against the real shared geometry
// (gutterBoxes / pitBoxes), proving the colliders actually catch a ball:
//   - a ball thrown wide drops into a gutter and is held there (does not roll
//     off the side into the void, and cannot climb back onto the lane), and is
//     carried down-lane toward the pit;
//   - a ball that clears the rack lands in the pit behind the deck and comes to
//     rest against the back wall instead of falling forever.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, gutterBoxes, pitBoxes, type Box } from '../src/config.js';
import { ballSpawnPosition } from '../src/ball.js';

beforeAll(async () => {
  await RAPIER.init();
});

function makeWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = 1 / 60;
  return world;
}

function addStaticBox(world: RAPIER.World, box: Box): void {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(box.center.x, box.center.y, box.center.z),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(box.half.x, box.half.y, box.half.z), body);
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

function addContainment(world: RAPIER.World): void {
  for (const box of gutterBoxes()) addStaticBox(world, box);
  for (const box of pitBoxes()) addStaticBox(world, box);
}

function addBall(world: RAPIER.World, vel: { x: number; y: number; z: number }): RAPIER.RigidBody {
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
  body.setLinvel(vel, true);
  return body;
}

describe('a ball thrown wide lands in the gutter (REQ-031)', () => {
  it('drops below the bed and is held in the gutter channel, not lost off the side', () => {
    const world = makeWorld();
    addBed(world);
    addContainment(world);
    // Strong lateral push toward +x so the ball drifts off the right edge.
    const ball = addBall(world, { x: 2.6, y: 0, z: -LANE.ballLaunchSpeed });

    let everInGutter = false;
    const gutterInnerX = LANE.width / 2;
    const gutterOuterX = LANE.width / 2 + LANE.gutterWidth;
    for (let i = 0; i < 240; i += 1) {
      world.step();
      const t = ball.translation();
      // It is in the gutter when below the bed top and within the channel band.
      if (t.y < LANE.floorY && t.x > gutterInnerX && t.x < gutterOuterX + LANE.ballRadius) {
        everInGutter = true;
      }
    }

    const end = ball.translation();
    expect(everInGutter).toBe(true);
    // Contained: it dropped into the channel and did not fly off the side or
    // climb back onto the lane bed.
    expect(end.y).toBeLessThan(LANE.floorY);
    expect(end.x).toBeLessThan(gutterOuterX + LANE.ballRadius);
    expect(end.x).toBeGreaterThan(gutterInnerX - LANE.ballRadius);
    // The recessed channel carried it down-lane toward the pins/pit.
    expect(end.z).toBeLessThan(ballSpawnPosition().z - 5);
    world.free();
  });
});

describe('a ball clearing the rack lands in the pit (F-004)', () => {
  it('comes to rest in the pit behind the deck instead of falling into the void', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    addContainment(world);
    // A fast straight ball with no rack to stop it clears the deck.
    const ball = addBall(world, { x: 0, y: 0, z: -LANE.ballLaunchSpeed });

    const deckBackZ = LANE.headSpot.z - LANE.pinDeckDepth;
    let minY = Infinity;
    for (let i = 0; i < 360; i += 1) {
      world.step();
      minY = Math.min(minY, ball.translation().y);
    }

    const end = ball.translation();
    // It reached the pit (behind the back of the deck) and dropped in.
    expect(end.z).toBeLessThan(deckBackZ);
    expect(end.z).toBeGreaterThan(deckBackZ - LANE.pitLength - LANE.ballRadius);
    expect(end.y).toBeLessThan(LANE.floorY); // it fell into the recessed pit
    // The pit floor caught it: it never dropped near the bottomless void depth.
    expect(minY).toBeGreaterThan(LANE.floorY - LANE.pitDepth - LANE.ballRadius - 0.05);
    // At rest, not still careening.
    const lin = ball.linvel();
    expect(Math.hypot(lin.x, lin.y, lin.z)).toBeLessThan(0.5);
    world.free();
  });
});
