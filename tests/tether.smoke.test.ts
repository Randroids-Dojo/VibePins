// Physics smoke for the string tether. Runs the real Rapier WASM (no renderer)
// against the real config: proves a struck pin falls freely while the cord is
// slack (REQ-014), and that the rope is finite and goes taut at slackLength so a
// later reset can lift a pin (REQ-015 hook).

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, TETHER } from '../src/config.js';
import { pinMassProperties, neckLocalAnchor } from '../src/pins.js';

beforeAll(async () => {
  await RAPIER.init();
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

// Rotate a local vector by a unit quaternion (v + 2q_w(q x v) + 2 q x (q x v)).
function rotate(v: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

function neckWorld(body: RAPIER.RigidBody) {
  const t = body.translation();
  const r = rotate(neckLocalAnchor(), body.rotation());
  return { x: t.x + r.x, y: t.y + r.y, z: t.z + r.z };
}

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function makePin(world: RAPIER.World, x: number, y: number, z: number) {
  const mass = pinMassProperties();
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2, LANE.pinBellyRadius).setMassProperties(
      mass.mass,
      mass.centerOfMass,
      mass.principalAngularInertia,
      IDENTITY,
    ),
    body,
  );
  return body;
}

function makeDeck(world: RAPIER.World) {
  const frontZ = LANE.headSpot.z + 0.15;
  const backZ = LANE.headSpot.z - LANE.pinDeckDepth;
  const deck = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, (frontZ + backZ) / 2),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, (frontZ - backZ) / 2), deck);
}

describe('struck pin falls freely while the cord stays slack (REQ-014)', () => {
  // Same strike on the head pin, simulated with and without the tether. If the
  // cord never goes taut, the two falls must be effectively identical.
  function simulate(withTether: boolean) {
    const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
    world.timestep = 1 / 60;
    makeDeck(world);

    const x = LANE.headSpot.x;
    const z = LANE.headSpot.z;
    const restY = LANE.floorY + LANE.pinHeight / 2;
    const pin = makePin(world, x, restY, z);

    const anchorPos = { x, y: TETHER.topY, z };
    if (withTether) {
      const anchor = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(anchorPos.x, anchorPos.y, anchorPos.z),
      );
      world.createImpulseJoint(
        RAPIER.JointData.rope(TETHER.slackLength, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
        pin,
        anchor,
        true,
      );
    }

    // A glancing strike: sideways shove plus a tip about z.
    pin.setLinvel({ x: 1.5, y: 0, z: 0 }, true);
    pin.setAngvel({ x: 0, y: 0, z: -8 }, true);

    let maxDist = 0;
    for (let i = 0; i < 180; i += 1) {
      world.step();
      maxDist = Math.max(maxDist, dist(neckWorld(pin), anchorPos));
    }
    const result = { pos: pin.translation(), maxDist };
    world.free();
    return result;
  }

  it('never goes taut and matches the untethered fall', () => {
    const free = simulate(false);
    const tethered = simulate(true);

    const restDist = TETHER.topY - (LANE.floorY + LANE.pinHeight / 2 + TETHER.neckLocalY);
    // The pin actually moved: the neck swung well clear of its rest distance.
    // Without this lower bound a frozen pin (e.g. a rope joint that rigidly
    // locked it) would also satisfy the slack upper bound below.
    expect(tethered.maxDist).toBeGreaterThan(restDist + 0.1);
    // The cord stayed slack the whole fall.
    expect(tethered.maxDist).toBeLessThan(TETHER.slackLength);
    // The pin toppled onto the deck (centre dropped below the upright rest height).
    expect(tethered.pos.y).toBeLessThan(LANE.floorY + LANE.pinHeight / 2);
    // Tethered and untethered resting positions agree: the slack cord did not
    // restrain the fall (REQ-014). A slack rope exerts zero impulse, so the two
    // deterministic sims should differ only by solver float noise (sub-mm); 1cm
    // is a tight bound that a genuinely restraining cord would blow past.
    expect(dist(tethered.pos, free.pos)).toBeLessThan(0.01);
  });
});

describe('the rope is finite and goes taut at slackLength (REQ-015 hook)', () => {
  it('catches a freely dropped pin at the slack length', () => {
    const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
    world.timestep = 1 / 60;

    // No deck: the pin hangs in space from a fixed overhead anchor and falls
    // until the rope goes taut.
    const anchorPos = { x: 0, y: TETHER.topY, z: 0 };
    const anchor = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(anchorPos.x, anchorPos.y, anchorPos.z),
    );
    // Start near the anchor (cord slack) so it must fall to engage the rope.
    const pin = makePin(world, 0, TETHER.topY - 0.3, 0);
    world.createImpulseJoint(
      RAPIER.JointData.rope(TETHER.slackLength, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
      pin,
      anchor,
      true,
    );

    let maxDist = 0;
    for (let i = 0; i < 360; i += 1) {
      world.step();
      maxDist = Math.max(maxDist, dist(neckWorld(pin), anchorPos));
    }

    const finalDist = dist(neckWorld(pin), anchorPos);
    // Hangs at the rope limit: taut, not stretched past it.
    expect(finalDist).toBeCloseTo(TETHER.slackLength, 1);
    expect(maxDist).toBeLessThan(TETHER.slackLength + 0.1);
    // The pin is left hanging well below the anchor, proving the rope is finite.
    expect(neckWorld(pin).y).toBeLessThan(0);

    world.free();
  });
});
