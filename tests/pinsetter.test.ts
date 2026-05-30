// The visible pinsetter rig geometry (GDD REQ-040). pinsetterRigParts is pure
// layout derived from the rack home spots, so we can verify the rig is staged
// correctly (above the pins, one tube and drum per pin, a frame at the cord
// anchor height, a drive unit clear of the rack) without booting Three.js or
// the physics. The world3d renderer just turns these parts into meshes, so
// pinning the geometry here is the meaningful coverage.

import { describe, it, expect } from 'vitest';
import { LANE, PINSETTER, TETHER, RESET, pinsetterRigParts } from '../src/config.js';
import { pinRackPositions } from '../src/pins.js';

const rack = pinRackPositions();
const rig = pinsetterRigParts(rack);

describe('pinsetter rig layout', () => {
  it('hangs one guide tube and one winding drum over every pin', () => {
    expect(rig.guideTubes).toHaveLength(rack.length);
    expect(rig.drums).toHaveLength(rack.length);
    for (let i = 0; i < rack.length; i += 1) {
      expect(rig.guideTubes[i].center.x).toBeCloseTo(rack[i].x);
      expect(rig.guideTubes[i].center.z).toBeCloseTo(rack[i].z);
      expect(rig.drums[i].center.x).toBeCloseTo(rack[i].x);
      expect(rig.drums[i].center.z).toBeCloseTo(rack[i].z);
    }
  });

  it('puts one cross-shaft over each distinct pin row', () => {
    const distinctRows = new Set(rack.map((p) => p.z)).size;
    expect(distinctRows).toBe(4); // standard 1-2-3-4 triangle
    expect(rig.shafts).toHaveLength(distinctRows);
  });

  it('builds two longitudinal rails plus one cross beam per row', () => {
    const rows = new Set(rack.map((p) => p.z)).size;
    expect(rig.beams).toHaveLength(2 + rows);
    // The two rails sit on opposite sides of the lane centre at the frame top.
    const rails = rig.beams.slice(0, 2);
    expect(rails[0].center.x).toBeCloseTo(-PINSETTER.railHalfX);
    expect(rails[1].center.x).toBeCloseTo(PINSETTER.railHalfX);
    for (const rail of rails) expect(rail.center.y).toBeCloseTo(PINSETTER.frameTopY);
  });

  it('sits the frame at the cord anchor height so it carries the strings', () => {
    expect(PINSETTER.frameTopY).toBe(TETHER.topY);
  });

  it('hangs the guide tubes below the frame and above the standing pins', () => {
    const standingPinTopY = LANE.floorY + LANE.pinHeight;
    for (const tube of rig.guideTubes) {
      const tubeTopY = tube.center.y + tube.length / 2;
      const tubeBottomY = tube.center.y - tube.length / 2;
      expect(tubeTopY).toBeLessThan(PINSETTER.frameTopY);
      expect(tubeBottomY).toBeGreaterThan(standingPinTopY);
    }
  });

  it('places the drive unit above the frame and clear behind the back row', () => {
    const backRowZ = Math.min(...rack.map((p) => p.z));
    expect(rig.driveUnit.center.y).toBeGreaterThan(PINSETTER.frameTopY);
    // The drive unit sits down-lane (-z) past the back pin row.
    expect(rig.driveUnit.center.z).toBeLessThan(backRowZ);
  });

  it('hangs one downward-opening centering cone over every home spot', () => {
    expect(rig.cones).toHaveLength(rack.length);
    for (let i = 0; i < rack.length; i += 1) {
      // The cone sits directly over its home spot, so a reeled-up pin head is
      // pulled up into it and the lower then comes straight down onto the spot.
      expect(rig.cones[i].center.x).toBeCloseTo(rack[i].x);
      expect(rig.cones[i].center.z).toBeCloseTo(rack[i].z);
      // A downward-opening funnel: the throat (slot) is narrower than the mouth.
      expect(rig.cones[i].slotRadius).toBeLessThan(rig.cones[i].mouthRadius);
      // The seat height is the carried clearance, the single source shared with the
      // reset's seat behaviour, so the geometry and the catch line up.
      expect(rig.cones[i].seatY).toBeCloseTo(RESET.liftPinY);
    }
  });

  it('places each cone above the seated pin head and below the guide tubes', () => {
    for (let i = 0; i < rig.cones.length; i += 1) {
      const cone = rig.cones[i];
      // A pin seated at seatY has its head (top) at seatY + pinHeight/2. The cone
      // mouth (its lowest point) sits right at that head top (the cone centre is
      // derived from seatY and the pin/cone geometry), so the head tucks up into the
      // funnel rather than the cone floating above it.
      const seatedHeadTopY = cone.seatY + LANE.pinHeight / 2;
      const coneMouthY = cone.center.y - cone.height / 2;
      expect(coneMouthY).toBeCloseTo(seatedHeadTopY, 6);
      // The cone sits below the guide tubes (which stop above the standing pins),
      // so the table reads as a distinct overhead component the pins seat up into.
      const tubeBottomY = rig.guideTubes[i].center.y - rig.guideTubes[i].length / 2;
      expect(cone.center.y).toBeLessThan(tubeBottomY);
    }
  });

  it('keeps the whole frame within the lane width (no collider, but reads clean)', () => {
    const maxOuterX = LANE.width / 2 + 0.02;
    for (const beam of rig.beams) {
      const outerX = Math.abs(beam.center.x) + beam.half.x;
      expect(outerX).toBeLessThanOrEqual(maxOuterX);
    }
  });
});
