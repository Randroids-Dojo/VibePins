// Physics smoke: drop the real rack onto a deck built from LANE and confirm the
// ten duckpins settle at rest instead of falling through the deck or toppling
// on spawn. Runs the actual Rapier WASM (no renderer), exercising the exported
// rack positions and belly-heavy mass properties against a real sim.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE } from '../src/config.js';
import { pinRackPositions, pinMassProperties } from '../src/pins.js';

beforeAll(async () => {
  await RAPIER.init();
});

describe('pin rack settles on the deck', () => {
  it('keeps every pin resting upright after a second of simulation', () => {
    const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
    world.timestep = 1 / 60;

    // Deck slab spanning the rack, top coplanar with floorY, mirroring world3d.
    const frontZ = LANE.headSpot.z + 0.15;
    const backZ = LANE.headSpot.z - LANE.pinDeckDepth;
    const deckBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, (frontZ + backZ) / 2),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, (frontZ - backZ) / 2),
      deckBody,
    );

    const mass = pinMassProperties();
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const spots = pinRackPositions();
    const bodies = spots.map((spot) => {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(spot.x, spot.y, spot.z),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2, LANE.pinBellyRadius).setMassProperties(
          mass.mass,
          mass.centerOfMass,
          mass.principalAngularInertia,
          identity,
        ),
        body,
      );
      return body;
    });

    for (let i = 0; i < 180; i += 1) {
      world.step();
    }

    bodies.forEach((body, i) => {
      const t = body.translation();
      const spot = spots[i];
      // Rests on the deck: did not fall through, did not launch upward.
      expect(t.y).toBeGreaterThan(spot.y - 0.05);
      expect(t.y).toBeLessThan(spot.y + 0.05);
      // Stays put: a pin set down at rest should not wander.
      expect(Math.abs(t.x - spot.x)).toBeLessThan(0.05);
      expect(Math.abs(t.z - spot.z)).toBeLessThan(0.05);
      // Stays upright: the body's local up axis is still close to world up.
      const r = body.rotation();
      const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
      expect(upY).toBeGreaterThan(0.95);
    });

    world.free();
  });
});
