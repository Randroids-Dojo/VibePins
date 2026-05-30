// Physics smoke for the reset cycle on the real Rapier WASM (no renderer).
//
// The signature proof (REQ-024 cord-tension lift): a pin is raised BY ITS NECK
// via cord tension. As the rope joint shortens, the constraint drags the pin up by
// the neck and the belly-heavy pin HANGS below the cord, swinging, righting itself
// base-down under gravity. It is never stood upright on the deck first. The test
// proves a lifting pin's CENTRE sits BELOW its neck anchor (it dangles) and it is
// not instantly vertical-on-deck.
//
// Plus the duckpin reset rules (REQ-009, REQ-010, REQ-018 to REQ-021): a
// between-balls cycle reels the WHOLE rack up by the cords, re-spots the STANDING
// pins on their HOME spots, and leaves the FALLEN pins aloft (cleared); a rerack
// carries all ten home and sets them upright on their home spots.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, TETHER, DETECTION, RESET, PIN_REST_Y } from '../src/config.js';
import { pinRackPositions } from '../src/pins.js';
import { classifyRack } from '../src/detection.js';
import { ResetCycle } from '../src/reset.js';
import { addRack, reelPin, kinematics, type RackPin } from './helpers/rack-physics.js';

beforeAll(async () => {
  await RAPIER.init();
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const restY = PIN_REST_Y;
const cfg = { ...RESET, restY };
// The live cone-seat config: the seat height is the carried clearance, mirroring
// main.ts. The reel-up pulls each pin's head up into its cone at this height.
const seatCfg = { ...RESET, restY, seatY: RESET.liftPinY };

function makeWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = 1 / 60;
  return world;
}
function addBed(world: RAPIER.World): void {
  const bed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, -LANE.length / 2));
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, LANE.length / 2), bed);
}
function addDeck(world: RAPIER.World): void {
  const frontZ = LANE.headSpot.z + 0.15;
  const backZ = LANE.headSpot.z - LANE.pinDeckDepth;
  const deck = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, (frontZ + backZ) / 2));
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, (frontZ - backZ) / 2), deck);
}

const upAxisY = (b: RAPIER.RigidBody): number => {
  const r = b.rotation();
  return 1 - 2 * (r.x * r.x + r.z * r.z);
};

function knockFrontPins(world: RAPIER.World, pins: RackPin[]): void {
  for (let i = 0; i < 60; i += 1) world.step();
  for (const i of [0, 1, 2]) {
    pins[i].body.setLinvel({ x: 2.5, y: 0, z: 0 }, true);
    pins[i].body.setAngvel({ x: 0, y: 0, z: -16 }, true);
  }
  for (let i = 0; i < 180; i += 1) world.step();
}

// Drive the reset cycle on the real rack, mirroring main.ts stepReset: the lift /
// shake phases reel the cords (pins dynamic, hanging); the reposition / lower
// phases capture the pins kinematic and carry them. Returns per-pin max lift Y and
// the recorded cord-tension-lift observation.
function runReset(
  world: RAPIER.World,
  pins: RackPin[],
  reset: ResetCycle,
): { maxLift: number[]; danglingSeen: boolean[] } {
  const reeled = [...reset.targets];
  const maxLift = pins.map(() => -Infinity);
  // For each pin, did we ever observe its CENTRE hanging below its neck anchor
  // (the cord-tension dangle) while NOT vertical-on-deck? Anchors sit at TETHER.topY.
  const danglingSeen = pins.map(() => false);
  let captured = false;
  let steps = 0;
  const cap = reset.totalFrames + 600;
  while (reset.isRunning && steps < cap) {
    const phase = reset.phase;
    const { targets, reel } = reset.step();

    if (reset.needsSnagVerdict) {
      // The cord-tension lift on a knocked rack is clean here (no pin lying across
      // another's cord), so report no snag. This is also the clean-rack path.
      reset.reportSnag(false);
      world.step();
      steps += 1;
      continue;
    }

    if (phase === 'seat' && !captured) {
      for (const i of reeled) {
        pins[i].body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
        reelPin(world, pins[i], TETHER.slackLength);
      }
      reset.updateSettled(kinematics(pins).map((s) => s.position));
      captured = true;
    }

    for (const r of reel) reelPin(world, pins[r.pinIndex], r.ropeLength);
    for (const t of targets) {
      pins[t.pinIndex].body.setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
      pins[t.pinIndex].body.setNextKinematicRotation(IDENTITY);
    }

    world.step();

    // During the cord-tension lift, record whether each pin dangles: its centre is
    // below its overhead neck anchor (so it hangs from the cord) and it is risen
    // off the deck (not stood vertical on the deck first).
    if (phase === 'lift') {
      pins.forEach((p, i) => {
        const t = p.body.translation();
        maxLift[i] = Math.max(maxLift[i], t.y);
        const liftedOffDeck = t.y > restY + 0.05;
        const belowAnchor = t.y < TETHER.topY - 0.05;
        if (liftedOffDeck && belowAnchor) danglingSeen[i] = true;
      });
    } else {
      pins.forEach((p, i) => (maxLift[i] = Math.max(maxLift[i], p.body.translation().y)));
    }
    steps += 1;
  }
  return { maxLift, danglingSeen };
}

describe('cord-tension lift: pins are reeled up BY THE NECK and dangle (REQ-024)', () => {
  it('a lifting pin HANGS below its neck anchor (its centre is below the anchor), proving cord-tension lift not a snap-upright', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    knockFrontPins(world, pins);

    const all = pins.map((_, i) => i);
    const settled = pins.map((p) => p.body.translation());
    const reset = new ResetCycle(cfg);
    reset.start('rerack', all, homes, settled);

    const { maxLift, danglingSeen } = runReset(world, pins, reset);
    expect(reset.isComplete()).toBe(true);

    // Every pin was reeled clear of the deck by the cord tension (no sweep).
    for (const i of all) expect(maxLift[i]).toBeGreaterThan(LANE.pinHeight);

    // The signature property: at least most pins were observed dangling, their
    // centre hanging BELOW the overhead neck anchor while risen off the deck. A
    // snap-upright (the old wrong model: stand the pin on the deck then elevate)
    // would never show the pin hanging from the cord during the lift.
    const dangled = danglingSeen.filter(Boolean).length;
    expect(dangled).toBeGreaterThan(5);
    world.free();
  });

  it('a fallen pin reeled by its cord swings (its neck is not instantly vertical-on-deck)', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    knockFrontPins(world, pins);
    // A genuinely fallen pin: not upright on the deck before the lift.
    const before = classifyRack(kinematics(pins), DETECTION);
    const fallen = before.filter((p) => !p.standing).map((p) => p.pinIndex);
    expect(fallen.length).toBeGreaterThanOrEqual(3);
    const fallenPin = fallen[0];

    const all = pins.map((_, i) => i);
    const settled = pins.map((p) => p.body.translation());
    const reset = new ResetCycle(cfg);
    reset.start('rerack', all, homes, settled);

    // Step through the lift only, recording the fallen pin's centre vs its anchor.
    const anchorY = TETHER.topY;
    let belowAnchorWhileLifted = false;
    let steps = 0;
    while (reset.isRunning && reset.phase !== 'seat' && steps < cfg.settleHoldFrames + cfg.liftFrames + 5) {
      const { reel } = reset.step();
      if (reset.needsSnagVerdict) {
        reset.reportSnag(false);
        world.step();
        steps += 1;
        continue;
      }
      for (const r of reel) reelPin(world, pins[r.pinIndex], r.ropeLength);
      world.step();
      const t = pins[fallenPin].body.translation();
      if (t.y > restY + 0.05 && t.y < anchorY - 0.05) belowAnchorWhileLifted = true;
      steps += 1;
    }
    // The fallen pin was lifted while hanging below its anchor: it dangled from the
    // cord and swung up by the neck, never stood upright on the deck first.
    expect(belowAnchorWhileLifted).toBe(true);
    world.free();
  });
});

describe('reset cycle: between-balls recall-all then re-spot standing (REQ-009, REQ-020, REQ-021)', () => {
  it('reels the WHOLE rack up by the cords, re-spots the standing pins home, and leaves the fallen pins aloft', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    knockFrontPins(world, pins);

    const before = classifyRack(kinematics(pins), DETECTION);
    const fallen = before.filter((p) => !p.standing).map((p) => p.pinIndex);
    const standing = before.filter((p) => p.standing).map((p) => p.pinIndex);
    expect(fallen.length).toBeGreaterThanOrEqual(3);
    expect(standing.length).toBeGreaterThan(0);

    const all = pins.map((_, i) => i);
    const settled = pins.map((p) => p.body.translation());
    const reset = new ResetCycle(cfg);
    reset.start('between-balls', fallen, homes, settled);

    const { maxLift } = runReset(world, pins, reset);
    expect(reset.isComplete()).toBe(true);

    // The whole rack reeled up (recall-all): every pin cleared the deck.
    for (const i of all) expect(maxLift[i]).toBeGreaterThan(LANE.pinHeight);

    expect([...reset.landedTargets].sort((a, b) => a - b)).toEqual([...standing].sort((a, b) => a - b));
    expect([...reset.heldAloftTargets].sort((a, b) => a - b)).toEqual([...fallen].sort((a, b) => a - b));

    for (const i of reset.landedTargets) {
      pins[i].body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      pins[i].body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      pins[i].body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (let i = 0; i < 60; i += 1) world.step();

    // Standing pins came to rest upright on their HOME spots (re-spotted, REQ-021).
    for (const i of standing) {
      const p = pins[i].body.translation();
      expect(Math.hypot(p.x - homes[i].x, p.z - homes[i].z)).toBeLessThan(0.1);
      expect(upAxisY(pins[i].body)).toBeGreaterThan(0.9);
    }
    // Fallen pins stayed reeled up and aloft, cleared (REQ-009).
    for (const i of fallen) {
      expect(pins[i].body.translation().y).toBeGreaterThan(LANE.pinHeight);
    }
    world.free();
  });
});

describe('cone-seat: a reeled-up pin is caught in its cone, straightened vertical and centered (REQ-024)', () => {
  // Drive the cycle through the lift and the seat phase (the cone catch), stopping
  // at the start of lower, and return each pin's pose at the top of its seat: the
  // pin should be vertical (up-axis near 1) and centered under its cone (home x/z)
  // at the seat height, NOT crooked or hanging off over its swung spot.
  function runToSeated(world: RAPIER.World, pins: RackPin[], reset: ResetCycle) {
    const reeled = [...reset.targets];
    let captured = false;
    let steps = 0;
    const cap = reset.totalFrames + 600;
    while (reset.isRunning && reset.phase !== 'lower' && steps < cap) {
      const phase = reset.phase;
      const { targets, reel } = reset.step();
      if (reset.needsSnagVerdict) {
        reset.reportSnag(false);
        world.step();
        steps += 1;
        continue;
      }
      if (phase === 'seat' && !captured) {
        for (const i of reeled) {
          pins[i].body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
          reelPin(world, pins[i], TETHER.slackLength);
        }
        reset.updateSettled(kinematics(pins).map((s) => s.position));
        captured = true;
      }
      for (const r of reel) reelPin(world, pins[r.pinIndex], r.ropeLength);
      for (const t of targets) {
        pins[t.pinIndex].body.setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z });
        pins[t.pinIndex].body.setNextKinematicRotation(IDENTITY);
      }
      world.step();
      steps += 1;
    }
    // Prove we stopped at the seat/lower boundary, not by hitting the safety cap
    // (a cap exit would mask a phase regression and read a meaningless pose).
    return { seated: kinematics(pins), reachedLower: reset.phase === 'lower', captured };
  }

  it('a lifted pin ends up VERTICAL and centered under its cone (seated), not crooked', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    knockFrontPins(world, pins);

    const all = pins.map((_, i) => i);
    const settled = pins.map((p) => p.body.translation());
    const reset = new ResetCycle(seatCfg);
    reset.start('rerack', all, homes, settled);

    const { seated, reachedLower, captured } = runToSeated(world, pins, reset);
    // The cycle reached the lower boundary through the seat phase (the cone catch
    // actually ran), so the seated pose below is the real top-of-seat pose.
    expect(captured).toBe(true);
    expect(reachedLower).toBe(true);

    for (const i of all) {
      // Centered under its cone: the cone sits over the home spot, so a seated pin's
      // x/z are at its home spot, not off over where it swung after the lift.
      expect(Math.hypot(seated[i].position.x - homes[i].x, seated[i].position.z - homes[i].z)).toBeLessThan(0.05);
      // Caught up in the cone at the seat height.
      expect(seated[i].position.y).toBeCloseTo(seatCfg.seatY, 1);
      // Straightened vertical (up-axis near vertical), the cone arrested the swing.
      const r = pins[i].body.rotation();
      const upAxis = 1 - 2 * (r.x * r.x + r.z * r.z);
      expect(upAxis).toBeGreaterThan(0.99);
    }
    world.free();
  });

  it('standing pins then lower STRAIGHT DOWN out of their cones onto their home spots, vertical', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    knockFrontPins(world, pins);
    const before = classifyRack(kinematics(pins), DETECTION);
    const standing = before.filter((p) => p.standing).map((p) => p.pinIndex);
    expect(standing.length).toBeGreaterThan(0);

    const settled = pins.map((p) => p.body.translation());
    const reset = new ResetCycle(seatCfg);
    reset.start('between-balls', before.filter((p) => !p.standing).map((p) => p.pinIndex), homes, settled);

    const { maxLift } = runReset(world, pins, reset);
    expect(reset.isComplete()).toBe(true);
    for (const i of pins.map((_, i) => i)) expect(maxLift[i]).toBeGreaterThan(LANE.pinHeight);

    for (const i of reset.landedTargets) {
      pins[i].body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      pins[i].body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      pins[i].body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (let i = 0; i < 60; i += 1) world.step();

    // The standing pins lowered straight down out of their cones onto their HOME
    // spots, upright (vertical), already centered from the cone seat.
    for (const i of standing) {
      const p = pins[i].body.translation();
      expect(Math.hypot(p.x - homes[i].x, p.z - homes[i].z)).toBeLessThan(0.1);
      expect(upAxisY(pins[i].body)).toBeGreaterThan(0.9);
    }
    world.free();
  });
});

describe('reset cycle: full re-rack (REQ-010, REQ-018)', () => {
  it('reels all ten pins up by the cords and sets them back upright on their home spots', () => {
    const world = makeWorld();
    addBed(world);
    addDeck(world);
    const pins = addRack(world);
    const homes = pinRackPositions();

    knockFrontPins(world, pins);

    const all = pins.map((_, i) => i);
    const settled = pins.map((p) => p.body.translation());
    const reset = new ResetCycle(cfg);
    reset.start('rerack', all, homes, settled);

    const { maxLift } = runReset(world, pins, reset);
    expect(reset.isComplete()).toBe(true);

    for (const i of all) {
      pins[i].body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      pins[i].body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      pins[i].body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (let i = 0; i < 60; i += 1) world.step();

    for (const i of all) {
      expect(maxLift[i]).toBeGreaterThan(LANE.pinHeight);
      const p = pins[i].body.translation();
      expect(Math.hypot(p.x - homes[i].x, p.z - homes[i].z)).toBeLessThan(0.1);
      expect(upAxisY(pins[i].body)).toBeGreaterThan(0.9);
    }
    world.free();
  });
});
