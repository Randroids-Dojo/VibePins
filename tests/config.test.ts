import { describe, it, expect } from 'vitest';
import {
  LANE,
  GROUP,
  PIN_PHYSICS,
  THROW_LIGHT_3D,
  MATERIALS,
  SHOT_CAMERA,
  MACHINE_ROOM,
  PINSETTER_RIG_FRONT_Z,
  PINSETTER,
  pinsetterRigParts,
} from '../src/config.js';
import { pinRackPositions } from '../src/pins.js';

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
  it('is mounted on the masking header in front of the rig, above the deck, unobstructed from the bowler', () => {
    const lamp = THROW_LIGHT_3D;
    // The bowler sits at large +z and looks down-lane toward -z (the machinery is
    // at the most negative z). For the signal to be unobstructed, every part of the
    // rig, cones, and pins must be further down-lane (more negative z) than the
    // signal: the signal's whole housing disc (its front lens included) sits in
    // FRONT of the rig front edge along the sight line. This is the fix for PR #65,
    // where a back-wall signal sat behind the rig and the rig/cones occluded it.
    const rig = pinsetterRigParts(pinRackPositions());
    // Frontmost z of every rig part (beams, tubes, drums, shafts, cones, drive
    // unit): a box's front face is center.z + half.z, a y-axis cylinder's is just
    // its center.z, an x-axis cylinder's is center.z + radius, a cone's front is
    // center.z + mouthRadius. The largest of these is the closest machinery to the
    // bowler. The signal must be strictly in front of all of it.
    const rigFrontZ = Math.max(
      ...rig.beams.map((b) => b.center.z + b.half.z),
      rig.driveUnit.center.z + rig.driveUnit.half.z,
      ...rig.guideTubes.map((c) => c.center.z + (c.axis === 'z' ? c.length / 2 : c.radius)),
      ...rig.drums.map((c) => c.center.z + (c.axis === 'z' ? c.length / 2 : c.radius)),
      ...rig.shafts.map((c) => c.center.z + (c.axis === 'z' ? c.length / 2 : c.radius)),
      ...rig.cones.map((c) => c.center.z + c.mouthRadius),
      // Standing pins sit at the rack spots with belly radius footprint.
      ...pinRackPositions().map((p) => p.z + LANE.pinBellyRadius),
    );
    // The shared rig front edge and the measured rig front agree (one source of
    // truth, so the placement constant tracks the geometry).
    expect(PINSETTER_RIG_FRONT_Z).toBeGreaterThanOrEqual(rigFrontZ);
    // The signal centre is in front of the rig front edge.
    expect(lamp.center.z).toBeGreaterThan(PINSETTER_RIG_FRONT_Z);
    // Even the lens face, the closest point of the signal to the bowler, stays
    // clear of the machinery (it only moves further toward the bowler, +z).
    const lensFaceZ = lamp.center.z + lamp.housingDepth + lamp.lensFrontZ;
    expect(lensFaceZ).toBeGreaterThan(rigFrontZ);
    // And the back of the housing disc is still in front of the rig, so the whole
    // signal body is unobstructed, not just its face.
    expect(lamp.center.z).toBeGreaterThan(rigFrontZ);
    // High on the masking header: above the pin deck and above the back-wall gauge
    // row, but below the ceiling so it stays inside the room.
    expect(lamp.center.y).toBeGreaterThan(LANE.pinHeight);
    expect(lamp.center.y).toBeGreaterThan(MACHINE_ROOM.gaugeY);
    expect(lamp.center.y).toBeLessThan(MACHINE_ROOM.ceilingY);
    // Sanity: PINSETTER still uses the shared overhang the rig front is derived from.
    expect(PINSETTER.frameOverhang).toBeGreaterThan(0);
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
