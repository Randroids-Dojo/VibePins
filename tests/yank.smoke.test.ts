// Physics smoke for the emergent string behaviour (GDD 03-string-pinsetter,
// REQ-023 neighbour yank, REQ-024 crossed cords tolerated, no deadlock, cleared
// at the next re-rack). Runs the real Rapier WASM (no renderer) against the real
// config so the behaviour is proven emergent from the rope-joint constraint, not
// scripted.
//
// The slack cord (TETHER.slackLength) is tuned so it never restrains a natural
// on-deck topple (REQ-014). It only goes taut when a pin is flung far enough to
// reach the end of its slack: a hard contact that sends a pin off the deck. When
// the cord snaps taut it exerts a restoring force that pure physics would not,
// which is the emergent source of the yank: the constraint, not a script,
// reels the flung pin back toward the rack and can drag it through a neighbour.
// That outcome is chaotic and rare by design (the GDD's "can occasionally"),
// so the test pins the causal mechanism (a taut cord changes a pin's fate)
// rather than asserting a specific neighbour always topples.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER, PIN_PHYSICS } from '../src/config.js';
import { pinRackPositions, pinMassProperties, neckLocalAnchor, tetherAnchorPositions } from '../src/pins.js';
import { ResetCycle } from '../src/reset.js';
import { RESET } from '../src/config.js';

beforeAll(async () => {
  await RAPIER.init();
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const restY = LANE.floorY + LANE.pinHeight / 2;
const PIN_GROUPS = (GROUP.PIN << 16) | 0xffff;

// Rotate a local vector by a unit quaternion.
function rotate(
  v: { x: number; y: number; z: number },
  q: { x: number; y: number; z: number; w: number },
) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
function neckWorld(b: RAPIER.RigidBody) {
  const t = b.translation();
  const r = rotate(neckLocalAnchor(), b.rotation());
  return { x: t.x + r.x, y: t.y + r.y, z: t.z + r.z };
}
function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function makeWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = 1 / 60;
  return world;
}

// The pin deck the rack stands on (matches the reset smoke's deck span).
function addDeck(world: RAPIER.World): void {
  const frontZ = LANE.headSpot.z + 0.15;
  const backZ = LANE.headSpot.z - LANE.pinDeckDepth;
  const deck = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, (frontZ + backZ) / 2),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, (frontZ - backZ) / 2), deck);
}

// One tethered pin at (x,z), its anchor directly overhead (ax,az). With no
// tether the same pin is a free projectile, so any difference in outcome between
// the two runs is attributable solely to the cord constraint.
function makePin(
  world: RAPIER.World,
  x: number,
  y: number,
  z: number,
  withTether: boolean,
  ax: number,
  az: number,
): RAPIER.RigidBody {
  const mass = pinMassProperties();
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2, LANE.pinBellyRadius)
      .setMassProperties(mass.mass, mass.centerOfMass, mass.principalAngularInertia, IDENTITY)
      .setFriction(PIN_PHYSICS.friction)
      .setRestitution(PIN_PHYSICS.restitution)
      .setCollisionGroups(PIN_GROUPS),
    body,
  );
  if (withTether) {
    const anchor = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(ax, TETHER.topY, az),
    );
    world.createImpulseJoint(
      RAPIER.JointData.rope(TETHER.slackLength, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
      body,
      anchor,
      true,
    );
  }
  return body;
}

function addRack(world: RAPIER.World): RAPIER.RigidBody[] {
  const anchors = tetherAnchorPositions();
  return pinRackPositions().map((spot, i) =>
    makePin(world, spot.x, spot.y, spot.z, true, anchors[i].x, anchors[i].z),
  );
}

const upAxisY = (b: RAPIER.RigidBody): number => {
  const r = b.rotation();
  return 1 - 2 * (r.x * r.x + r.z * r.z);
};

describe('a taut cord yanks a pin emergently from the constraint sim (REQ-023)', () => {
  it('reels a hard-flung pin back toward the rack instead of letting it fly off', () => {
    // No floor: a pure projectile so the cord constraint is the only thing that
    // can change the outcome. A pin shoved hard off its home spot.
    function fling(withTether: boolean): { horiz: number; tautSeen: boolean } {
      const world = makeWorld();
      const pin = makePin(world, 0, restY, 0, withTether, 0, 0);
      pin.setLinvel({ x: 9, y: 3, z: 0 }, true);
      pin.setAngvel({ x: 0, y: 0, z: -12 }, true);
      let tautSeen = false;
      for (let i = 0; i < 240; i += 1) {
        world.step();
        if (withTether && dist(neckWorld(pin), { x: 0, y: TETHER.topY, z: 0 }) >= TETHER.slackLength - 0.02) {
          tautSeen = true;
        }
      }
      const t = pin.translation();
      world.free();
      return { horiz: Math.hypot(t.x, t.z), tautSeen };
    }

    const free = fling(false);
    const tethered = fling(true);

    // The cord reached its slack limit and went taut (the emergent trigger).
    expect(tethered.tautSeen).toBe(true);
    // The taut cord did real work: the untethered pin flies far away, the
    // tethered one is reeled back near the rack. This restoring force is what
    // drags a flung pin back through the deck and can knock or save a neighbour.
    expect(free.horiz).toBeGreaterThan(TETHER.slackLength * 2);
    expect(tethered.horiz).toBeLessThan(TETHER.slackLength);
    // And the constraint changed the fate, not a script: the two diverge sharply.
    expect(free.horiz - tethered.horiz).toBeGreaterThan(TETHER.slackLength);
  });

  it('a slack cord exerts zero influence so a natural on-deck fall is untouched (REQ-014 guard)', () => {
    // Counterpart to the yank: when the pin stays within its slack (a normal
    // topple), the cord must not act, or every fall would be a yank. Same gentle
    // topple with and without the tether must agree.
    function topple(withTether: boolean) {
      const world = makeWorld();
      // A floor under the pin so it topples onto the deck rather than free-falls.
      const floor = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, 0),
      );
      world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.05, 2), floor);
      const pin = makePin(world, 0, restY, 0, withTether, 0, 0);
      pin.setLinvel({ x: 1.2, y: 0, z: 0 }, true);
      pin.setAngvel({ x: 0, y: 0, z: -6 }, true);
      for (let i = 0; i < 180; i += 1) world.step();
      const t = pin.translation();
      world.free();
      return { x: t.x, y: t.y, z: t.z };
    }
    const free = topple(false);
    const tethered = topple(true);
    // Slack rope exerts no impulse, so the two deterministic sims agree to noise.
    expect(dist(free, tethered)).toBeLessThan(0.01);
  });
});

describe('crossed/tangled cords are tolerated and cleared by the next re-rack (REQ-024)', () => {
  it('does not deadlock the sim when cords cross, and a re-rack restores the upright rack', () => {
    const world = makeWorld();
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    // Settle the fresh rack on its slack cords.
    for (let i = 0; i < 60; i += 1) world.step();

    // Drive several pins hard across the deck and into each other so their cords
    // cross and tangle: opposing lateral shoves on the back-row outer pins fling
    // them across the centre, dragging their cords over the inner pins' cords.
    const crossed = [6, 9, 3, 1];
    const dirs = [-1, 1, 1, -1];
    crossed.forEach((idx, k) => {
      pins[idx].setLinvel({ x: dirs[k] * 8, y: 2.5, z: -2 }, true);
      pins[idx].setAngvel({ x: 0, y: 0, z: dirs[k] * -18 }, true);
    });

    // Run a long chaotic settle. The sim must not blow up (no NaN, no runaway
    // velocity) even with crossed taut cords: that is the no-deadlock guarantee.
    let maxSpeed = 0;
    for (let i = 0; i < 360; i += 1) {
      world.step();
      for (const p of pins) {
        const lv = p.linvel();
        const t = p.translation();
        expect(Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)).toBe(true);
        maxSpeed = Math.max(maxSpeed, Math.hypot(lv.x, lv.y, lv.z));
      }
    }
    // Nothing escaped to an absurd velocity: the constraint solver stayed stable.
    expect(maxSpeed).toBeLessThan(200);

    // At least some pins ended up tangled away from their home spots (the cross
    // actually happened, not a no-op).
    const displaced = pins.filter((p, i) => {
      const t = p.translation();
      return Math.hypot(t.x - homes[i].x, t.z - homes[i].z) > LANE.pinSpacing;
    });
    expect(displaced.length).toBeGreaterThan(0);

    // Now run a full re-rack: carry all ten pins kinematically back to their home
    // spots, upright. This is what clears the tangled geometry (REQ-024: there is
    // no manual untangle; the next re-rack lifts everything and resets it).
    const settled = pins.map((b) => b.translation());
    const all = pins.map((_, i) => i);
    const reset = new ResetCycle({ ...RESET, restY });
    reset.start('rerack', all, homes, settled);
    // The cord-tension lift keeps the pins dynamic and reels the cords; the carry
    // phases capture them kinematic and set them home. This test only needs the
    // tangled geometry CLEARED by a full re-rack, so the lift frames elapse and the
    // kinematic carry does the set-down (the cord reel is exercised in the reset
    // smoke). Capture the pins kinematic at the first carry phase.
    let steps = 0;
    let captured = false;
    while (reset.isRunning && steps < reset.totalFrames + 5) {
      const { targets } = reset.step();
      if (reset.phase === 'seat' && !captured) {
        for (const i of all) pins[i].setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
        captured = true;
      }
      for (const t of targets) {
        pins[t.pinIndex].setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
        pins[t.pinIndex].setNextKinematicRotation(IDENTITY);
      }
      world.step();
      steps += 1;
    }
    expect(reset.isComplete()).toBe(true);
    for (const i of all) {
      pins[i].setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      pins[i].setLinvel({ x: 0, y: 0, z: 0 }, true);
      pins[i].setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (let i = 0; i < 60; i += 1) world.step(); // let the set-down rack settle

    // The geometry is cleared: every pin is upright on its home spot again, with
    // its cord slack, exactly as a fresh rack. The tangle did not persist.
    for (const i of all) {
      const t = pins[i].translation();
      expect(Math.hypot(t.x - homes[i].x, t.z - homes[i].z)).toBeLessThan(0.1);
      expect(upAxisY(pins[i])).toBeGreaterThan(0.9);
      // Cord is not stretched past its slack limit: an upright respotted pin
      // hangs well inside the rope length, so the joint is inactive (slack).
      expect(dist(neckWorld(pins[i]), tetherAnchorPositions()[i])).toBeLessThan(TETHER.slackLength - 0.3);
    }
    world.free();
  });
});
