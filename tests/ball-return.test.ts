// The metal ball return layout (GDD 04-look-and-feel#environment, REQ-039 /
// REQ-041). ballReturnParts is pure layout derived from BALL_RETURN, SHOT_CAMERA,
// and LANE, so we can verify the chrome rack and return runway sit off the
// playfield (beyond the bed + gutter, on the throwing-hand side), the rack
// cradles the ball where it waits, and the runway runs down-lane, without
// booting Three.js. world3d just turns these parts into meshes, so pinning the
// geometry here is the meaningful coverage (mirrors tests/machine-room.test.ts).

import { describe, it, expect } from 'vitest';
import { LANE, SHOT_CAMERA, BALL_RETURN, ballReturnParts } from '../src/config.js';

const parts = ballReturnParts();

// The lane playfield reaches out to the bed half-width plus a gutter on each
// side; the return must stage clear of that on the throwing-hand (+x) side.
const PLAYFIELD_MAX_X = LANE.width / 2 + LANE.gutterWidth;

describe('metal ball return (REQ-039 / REQ-041)', () => {
  it('builds two runway rails, a rack, and two legs', () => {
    expect(parts.rails).toHaveLength(2);
    expect(parts.rack).toBeDefined();
    expect(parts.legs).toHaveLength(2);
  });

  it('stages every part outboard of the lane and gutters', () => {
    const all = [...parts.rails, parts.rack, ...parts.legs];
    for (const part of all) {
      // Whole part sits on the +x side, its inner edge beyond the gutter.
      const innerX = part.center.x - part.half.x;
      expect(innerX).toBeGreaterThan(PLAYFIELD_MAX_X);
    }
  });

  it('rests every part on or above the lane floor', () => {
    const all = [...parts.rails, parts.rack, ...parts.legs];
    for (const part of all) {
      expect(part.center.y - part.half.y).toBeGreaterThanOrEqual(LANE.floorY - 1e-6);
    }
  });

  it('runs the two rails parallel with a ball-width gap between them', () => {
    const [a, b] = parts.rails;
    const gap = Math.abs(a.center.x - b.center.x) - a.half.x - b.half.x;
    expect(gap).toBeCloseTo(BALL_RETURN.railGap, 6);
    // Both rails span the full runway depth (z half-extent matches).
    expect(a.half.z).toBeCloseTo(b.half.z, 6);
    expect(a.half.z * 2).toBeCloseTo(BALL_RETURN.zFront - BALL_RETURN.zBack, 6);
  });

  it('cradles the ball in the rack at the bowler-end wait spot', () => {
    // The rack is centred on where the playable ball waits (SHOT_CAMERA).
    expect(parts.rack.center.z).toBeCloseTo(SHOT_CAMERA.ballReturnPos.z, 6);
    // The rack opening is at least a ball wide so the ball reads as cradled.
    expect(parts.rack.half.x * 2).toBeGreaterThan(LANE.ballRadius * 2);
  });

  it('runs the runway down-lane from behind the bowler toward the foul line', () => {
    // zFront is nearer the camera (+z, behind the bowler); zBack toward the pins.
    expect(BALL_RETURN.zFront).toBeGreaterThan(BALL_RETURN.zBack);
    const [a] = parts.rails;
    expect(a.center.z).toBeCloseTo((BALL_RETURN.zFront + BALL_RETURN.zBack) / 2, 6);
  });
});
