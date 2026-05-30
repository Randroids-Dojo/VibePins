import { describe, it, expect } from 'vitest';
import {
  LANE,
  GROUP,
  PIN_PHYSICS,
  THROW_LIGHT_3D,
  MATERIALS,
  SHOT_CAMERA,
  MACHINE_ROOM,
  MACHINE_ROOM_BACK_Z,
} from '../src/config.js';

describe('LANE config', () => {
  it('places the head spot down-lane from the foul line', () => {
    // Pins sit into -z, at least most of a lane length away (GDD REQ-039).
    expect(LANE.headSpot.z).toBeLessThan(0);
    expect(Math.abs(LANE.headSpot.z)).toBeCloseTo(LANE.length, 2);
  });

  it('frames the camera behind the foul line, looking down-lane', () => {
    expect(LANE.cameraPos.z).toBeGreaterThan(0);
    expect(LANE.cameraLookAt.z).toBeLessThan(LANE.cameraPos.z);
  });

  it('uses duckpin-scaled positive dimensions and masses', () => {
    for (const v of [
      LANE.length,
      LANE.width,
      LANE.ballRadius,
      LANE.ballMass,
      LANE.pinHeight,
      LANE.pinBellyRadius,
      LANE.pinMass,
      LANE.pinSpacing,
    ]) {
      expect(v).toBeGreaterThan(0);
    }
    // A duckpin ball is smaller than the standard 12in pin spacing.
    expect(LANE.ballRadius * 2).toBeLessThan(LANE.pinSpacing);
  });

  it('pulls bodies downward', () => {
    expect(LANE.gravity).toBeLessThan(0);
  });

  it('keeps the max line-up sidestep on the lane bed (the ball never starts in the gutter)', () => {
    // The sidestep (SHOT_CAMERA.alignLimit) shifts the ball start laterally by up
    // to alignLimit. At the extreme the ball centre is alignLimit from centre, and
    // the whole ball (radius) must stay inside the lane half-width, or an extreme
    // stance would launch into the gutter. Guards the widened sidestep travel.
    expect(SHOT_CAMERA.alignLimit + LANE.ballRadius).toBeLessThan(LANE.width / 2);
  });
});

describe('PIN_PHYSICS contact material (REQ-030)', () => {
  it('barely bounces, so struck pins do not spray the rack like tenpin', () => {
    // Any non-zero restitution visibly increases scatter; duckpin keeps it at
    // zero so the collision chain dies out fast and strikes stay rare.
    expect(PIN_PHYSICS.restitution).toBe(0);
  });

  it('uses a friction high enough to shed energy into the deck and neighbours', () => {
    // Mid-high friction so a toppling pin sheds its energy rather than sliding
    // the length of the lane, while staying inside the physical [0, 1] band.
    expect(PIN_PHYSICS.friction).toBeGreaterThanOrEqual(0.4);
    expect(PIN_PHYSICS.friction).toBeLessThanOrEqual(1);
  });
});

describe('lane-end go/stop signal lamp (REQ-038)', () => {
  it('is mounted on the back wall like a clock, above the deck and clear of the rig', () => {
    const lamp = THROW_LIGHT_3D;
    // Mounted on the machine-room back-wall plane (behind the pit, -z), not buried
    // inside the pinsetter rig. The housing centre sits within its stand-off depth
    // of the wall inner face, so it reads as a signal hung on the wall.
    expect(lamp.center.z).toBeGreaterThanOrEqual(MACHINE_ROOM_BACK_Z);
    expect(lamp.center.z).toBeLessThanOrEqual(MACHINE_ROOM_BACK_Z + lamp.housingDepth + 0.05);
    // Well behind the pinsetter rig footprint: the rig sits around the head spot
    // (within frameOverhang of the pins) and the pit runs to headSpot.z minus the
    // deck plus pit length, so the back wall is metres further down-lane. This is
    // what keeps the rig, cones, and pins from occluding it (playtest follow-up).
    const rigBackZ = LANE.headSpot.z - LANE.pinDeckDepth - LANE.pitLength;
    expect(lamp.center.z).toBeLessThan(rigBackZ);
    // High on the wall like a wall clock: above the pin deck and above the
    // back-wall gauge row, so it is unobstructed and reads down the whole lane.
    expect(lamp.center.y).toBeGreaterThan(LANE.pinHeight);
    expect(lamp.center.y).toBeGreaterThan(MACHINE_ROOM.gaugeY);
    // Centred on the lane so it is plainly visible straight down-lane.
    expect(lamp.center.x).toBe(0);
    // The lens faces sit in front of the housing toward the bowler (+z), so the
    // lit lens is visible from the bowler view down-lane.
    expect(lamp.lensFrontZ).toBeGreaterThan(0);
    // A round housing disc holds the lenses; its rim is wider than a lens.
    expect(lamp.housingRadius).toBeGreaterThan(lamp.lensRadius);
    // Two stacked lenses: the offset is non-zero so red and green do not overlap.
    expect(lamp.lensOffsetY).toBeGreaterThan(lamp.lensRadius * 0.5);
  });

  it('has a lit and a dark material for each of the two lenses', () => {
    // The signal lights exactly one lens per state by swapping each lens between
    // its lit (emissive) and dark material, so the visible state observably changes
    // (RULE 10). The lit lenses carry an emissive glow; the dark ones do not.
    expect('emissive' in MATERIALS.signalGoLit).toBe(true);
    expect('emissive' in MATERIALS.signalWaitLit).toBe(true);
    expect('emissive' in MATERIALS.signalGoDark).toBe(false);
    expect('emissive' in MATERIALS.signalWaitDark).toBe(false);
  });
});

describe('GROUP bitmask', () => {
  it('assigns a distinct power-of-two bit to each physics layer', () => {
    const bits = Object.values(GROUP);
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) {
      expect(bit & (bit - 1)).toBe(0);
    }
  });
});
