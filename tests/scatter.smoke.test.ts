// Physics smoke for low-scatter, rare-strike duckpin behaviour (GDD REQ-030,
// pillar 1). Runs the real Rapier WASM (no renderer) against the real rack
// geometry, mass properties, and the PIN_PHYSICS contact material, throwing a
// straight ball at the rack from a sweep of lateral aim points and speeds.
//
// The point is not that any single throw lands an exact count, but that the
// tuned contact material produces the duckpin feel the GDD demands: a dead
// straight ball does not strike, the collision chain dies out fast (most frames
// leave a healthy cluster of pins), and struck pins do not rocket clear off the
// deck. Real duckpin has never recorded a 300; the record is 279, so a build
// where straight balls routinely strike is mis-tuned.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, PIN_PHYSICS } from '../src/config.js';
import { pinRackPositions, pinMassProperties } from '../src/pins.js';
import { ballSpawnPosition } from '../src/ball.js';

beforeAll(async () => {
  await RAPIER.init();
});

const FRONT_Z = LANE.headSpot.z + 0.15;
const BACK_Z = LANE.headSpot.z - LANE.pinDeckDepth;

interface ShotResult {
  // Pins still upright, at rest, and on the deck after the ball resolves.
  readonly standing: number;
  // Furthest any pin was flung sideways (lateral x) from its home spot. Lateral
  // travel is the tenpin "spray" signature; a pin sliding straight down-lane off
  // the back of the deck is just the ball clearing, not scatter, so down-lane
  // travel is deliberately excluded here.
  readonly maxLateralScatter: number;
}

// Throw one straight ball with the given lateral aim offset (metres) and
// down-lane speed at a freshly settled rack; report the standing count and the
// worst pin scatter once everything resolves.
function throwAt(aimX: number, speed: number): ShotResult {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = 1 / 60;

  // Bed and deck, mirroring the world3d / containment smokes.
  const bed = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, -LANE.length / 2),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, LANE.length / 2), bed);
  const deck = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, (FRONT_Z + BACK_Z) / 2),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, (FRONT_Z - BACK_Z) / 2), deck);

  const mass = pinMassProperties();
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  const spots = pinRackPositions();
  const pins = spots.map((spot) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(spot.x, spot.y, spot.z),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2, LANE.pinBellyRadius)
        .setMassProperties(mass.mass, mass.centerOfMass, mass.principalAngularInertia, identity)
        .setFriction(PIN_PHYSICS.friction)
        .setRestitution(PIN_PHYSICS.restitution),
      body,
    );
    return body;
  });

  // Let the rack settle before the throw.
  for (let i = 0; i < 60; i += 1) world.step();

  const spawn = ballSpawnPosition();
  const ball = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x + aimX, spawn.y, spawn.z)
      .setCcdEnabled(true)
      .setLinearDamping(LANE.ballLinearDamping)
      .setAngularDamping(LANE.ballAngularDamping),
  );
  world.createCollider(
    RAPIER.ColliderDesc.ball(LANE.ballRadius)
      .setMass(LANE.ballMass)
      .setFriction(LANE.ballFriction)
      .setRestitution(LANE.ballRestitution),
    ball,
  );
  // Straight, no spin, rolling without slip.
  ball.setLinvel({ x: 0, y: 0, z: -speed }, true);
  ball.setAngvel({ x: -speed / LANE.ballRadius, y: 0, z: 0 }, true);

  for (let i = 0; i < 360; i += 1) world.step();

  let standing = 0;
  let maxLateralScatter = 0;
  pins.forEach((body, i) => {
    const t = body.translation();
    const r = body.rotation();
    const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
    const lv = body.linvel();
    const onDeck = t.x > -LANE.width / 2 && t.x < LANE.width / 2 && t.z > BACK_Z && t.z < FRONT_Z;
    if (upY > 0.96 && onDeck && Math.hypot(lv.x, lv.y, lv.z) < 0.1) standing += 1;
    // Only count lateral travel for pins still resting near the deck surface.
    // This smoke has no back wall, so a pin knocked clean off the back of the
    // deck falls into the void and tumbles unboundedly; that is the ball
    // clearing, not lateral spray, so exclude pins that have dropped below the
    // deck. The deck top is floorY; allow a small margin for a resting pin.
    const onDeckSurface = t.y > LANE.floorY - LANE.pinHeight;
    if (onDeckSurface) {
      maxLateralScatter = Math.max(maxLateralScatter, Math.abs(t.x - spots[i].x));
    }
  });

  world.free();
  return { standing, maxLateralScatter };
}

describe('duckpin scatter is low and straight strikes are rare (REQ-030)', () => {
  // Sweep lateral aim across the pocket region and a range of throw speeds.
  // Computed in beforeAll so the Rapier WASM is initialised first.
  const aims = [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12];
  const speeds = [6, 7, 8];
  let shots: ShotResult[] = [];

  beforeAll(() => {
    shots = aims.flatMap((aimX) => speeds.map((speed) => throwAt(aimX, speed)));
  });

  it('never strikes on a dead-centre straight ball', () => {
    // The head pin sits dead centre; a straight ball into it cannot clear the
    // rack because the squat low-energy pins do not spray. This is the floor of
    // the duckpin difficulty: you cannot strike by aiming straight at the one.
    const center = throwAt(0, 8);
    expect(center.standing).toBeGreaterThan(0);
  });

  it('lands no strikes across a sweep of straight shots', () => {
    // Straight balls (no spin) should essentially never strike in duckpin; the
    // rare strike has to be worked for with spin and angle, which this smoke
    // does not apply.
    const strikes = shots.filter((s) => s.standing === 0).length;
    expect(strikes).toBe(0);
  });

  it('leaves a healthy cluster of pins on most shots (low scatter)', () => {
    // Every straight shot should leave several pins; if the chain were spraying
    // the whole rack we would see counts crashing toward zero.
    const minStanding = Math.min(...shots.map((s) => s.standing));
    expect(minStanding).toBeGreaterThanOrEqual(3);
  });

  it('does not fling pins sideways across the lane (no tenpin spray)', () => {
    // With zero restitution the chain transfers energy down-lane, not in a
    // sideways explosion. Bound the worst lateral fling to a few pin-spacings so
    // a tuning regression that re-introduces tenpin spray (for example a bump in
    // restitution) fails here.
    const worst = Math.max(...shots.map((s) => s.maxLateralScatter));
    expect(worst).toBeLessThan(3 * LANE.pinSpacing);
  });
});
