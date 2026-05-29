// The visible pinsetter rig geometry (GDD REQ-040). pinsetterRigParts is pure
// layout derived from the rack home spots, so we can verify the rig is staged
// correctly (above the pins, one tube and drum per pin, a frame at the cord
// anchor height, a drive unit clear of the rack) without booting Three.js or
// the physics. The world3d renderer just turns these parts into meshes, so
// pinning the geometry here is the meaningful coverage.

import { describe, it, expect } from 'vitest';
import { LANE, PINSETTER, TETHER, pinsetterRigParts } from '../src/config.js';
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

  it('keeps the whole frame within the lane width (no collider, but reads clean)', () => {
    const maxOuterX = LANE.width / 2 + 0.02;
    for (const beam of rig.beams) {
      const outerX = Math.abs(beam.center.x) + beam.half.x;
      expect(outerX).toBeLessThanOrEqual(maxOuterX);
    }
  });
});
