// Physics smoke for the hanging-pin detection rule (GDD 03-string-pinsetter,
// REQ-022). The string house's signature failure mode is a cord that leaves a
// pin dangling above the deck rather than cleanly fallen or cleanly standing,
// and the house rule is "no untangling of strings": the lane plays it as-is.
// VibePins resolves a hanging pin purely through the detection rule (a pin that
// is not on the deck footprint reads fallen), with no special case.
//
// The detection unit tests already pin the classifier math for an off-deck
// pin. This smoke proves the rule holds against the REAL Rapier rope joint: a
// pin genuinely suspended by a taut cord, upright and at rest above the deck,
// is classified fallen by the production classifier AND resolves fallen through
// the authoritative SettleWindow gate. It is the physics counterpart to the
// pure detection.test.ts "hanging above the deck" cases.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, TETHER, DETECTION } from '../src/config.js';
import { pinMassProperties, neckLocalAnchor } from '../src/pins.js';
import { classifyPinStanding, SettleWindow, type PinKinematics } from '../src/detection.js';

beforeAll(async () => {
  await RAPIER.init();
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

// PinKinematics from a live body, mirroring PinSet.pinStates().
function kinematics(body: RAPIER.RigidBody): PinKinematics {
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
}

function makePin(world: RAPIER.World, x: number, y: number, z: number): RAPIER.RigidBody {
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

// A pin suspended over its home spot by an overhead anchor placed high enough
// that the slack cord, once taut, holds the pin centre above the deck footprint
// (above DETECTION.deckFootprint.maxCenterY). This recreates a real "dangling
// above the deck" hang from the rope joint itself: the anchor height is a
// test-only value chosen so the taut-cord resting height clears the deck. The
// production rig hangs lower; the point under test is the detection rule, not
// the production anchor height.
function makeHangingPin(world: RAPIER.World): RAPIER.RigidBody {
  const x = LANE.headSpot.x;
  const z = LANE.headSpot.z;
  // Resting hang height of the pin centre = anchorY - slackLength - neckLocalY.
  // Solve for an anchor height that lands the centre a comfortable margin above
  // the deck footprint ceiling, so the hung pin is unambiguously off the deck.
  const targetCenterY = DETECTION.deckFootprint.maxCenterY + 0.3;
  const anchorY = targetCenterY + TETHER.slackLength + TETHER.neckLocalY;

  const anchor = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(x, anchorY, z),
  );
  // Start the pin close under the anchor (cord slack) so it falls and the rope
  // catches it, settling into a genuine taut hang rather than being placed there.
  const pin = makePin(world, x, anchorY - 0.4, z);
  world.createImpulseJoint(
    RAPIER.JointData.rope(TETHER.slackLength, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
    pin,
    anchor,
    true,
  );
  return pin;
}

describe('hanging pin reads fallen through the real cord (REQ-022)', () => {
  it('classifies a pin suspended aloft by a taut cord as fallen', () => {
    const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
    world.timestep = 1 / 60;
    const pin = makeHangingPin(world);

    // Let the pin fall onto the cord and settle into a taut, at-rest hang.
    for (let i = 0; i < 600; i += 1) world.step();

    const k = kinematics(pin);
    // It really is hanging above the deck (off the footprint), not on it.
    expect(k.position.y).toBeGreaterThan(DETECTION.deckFootprint.maxCenterY);
    // And it has come to rest (so it is not failing detection merely by motion).
    expect(k.linSpeed).toBeLessThanOrEqual(DETECTION.atRestLinSpeed);
    expect(k.angSpeed).toBeLessThanOrEqual(DETECTION.atRestAngSpeed);
    // The detection rule reads it fallen with no special case: off the deck.
    expect(classifyPinStanding(k, DETECTION)).toBe(false);

    world.free();
  });

  it('resolves the hung pin fallen through the authoritative SettleWindow', () => {
    const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
    world.timestep = 1 / 60;
    const pin = makeHangingPin(world);

    // Drive the production settle gate over the real settling physics: a single
    // pin rack that hangs from its cord. It resolves by sustained rest.
    const win = new SettleWindow(DETECTION, DETECTION.settleAtRestFrames, DETECTION.settleMaxFrames);
    let result = win.step([kinematics(pin)]);
    for (let i = 0; i < 800 && !result.settled; i += 1) {
      world.step();
      result = win.step([kinematics(pin)]);
    }

    expect(result.settled).toBe(true);
    expect(result.pins).toHaveLength(1);
    expect(result.standingCount).toBe(0);
    expect(result.fallenCount).toBe(1);
    expect(result.pins[0].standing).toBe(false);

    world.free();
  });
});
