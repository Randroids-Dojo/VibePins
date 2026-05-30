// The metal ball return layout (GDD 04-look-and-feel#environment, REQ-039 /
// REQ-041). ballReturnParts is pure layout derived from BALL_RETURN, SHOT_CAMERA,
// and LANE, so we can verify the curved chrome tubular track sits off the
// playfield (beyond the bed + gutter, on the throwing-hand side), the two round
// rails run parallel and curve home toward the bowler, and the whole rig stays
// inboard of the machine-room side wall, without booting Three.js. world3d just
// turns these parts into TubeGeometry meshes, so pinning the geometry here is the
// meaningful coverage (mirrors tests/machine-room.test.ts).

import { describe, it, expect } from 'vitest';
import { LANE, SHOT_CAMERA, BALL_RETURN, MACHINE_ROOM, ballReturnParts } from '../src/config.js';

const parts = ballReturnParts();

// The lane playfield reaches out to the bed half-width plus a gutter on each
// side; the return must stage clear of that on the throwing-hand (+x) side.
const PLAYFIELD_MAX_X = LANE.width / 2 + LANE.gutterWidth;

// The machine-room side wall's inner (lane-facing) face. The return must stay
// inboard of it, or the rig would be buried in / occluded by the wall.
const WALL_INNER_X = MACHINE_ROOM.wallHalfX - MACHINE_ROOM.wallThickness;

describe('metal ball return (REQ-039 / REQ-041)', () => {
  it('builds two curved tubular rails, a cross frame, and support posts', () => {
    expect(parts.rails).toHaveLength(2);
    expect(parts.frame).toBeDefined();
    expect(parts.posts.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps every tube and post within the band between the gutter and side wall', () => {
    // Each rail/frame tube: every centerline point, widened by the tube radius,
    // must sit inside the band so the chrome never crosses the gutter or pokes
    // through the side wall (PR #58 occlusion fix, kept here).
    for (const tube of [...parts.rails, parts.frame]) {
      for (const p of tube.points) {
        expect(p.x - tube.radius).toBeGreaterThan(PLAYFIELD_MAX_X);
        expect(p.x + tube.radius).toBeLessThanOrEqual(WALL_INNER_X);
      }
    }
    // Each upright post (a cylinder) likewise sits in the band.
    for (const post of parts.posts) {
      expect(post.center.x - post.radius).toBeGreaterThan(PLAYFIELD_MAX_X);
      expect(post.center.x + post.radius).toBeLessThanOrEqual(WALL_INNER_X);
    }
  });

  it('rests every tube and post on or above the lane floor', () => {
    for (const tube of [...parts.rails, parts.frame]) {
      for (const p of tube.points) {
        expect(p.y - tube.radius).toBeGreaterThanOrEqual(LANE.floorY - 1e-6);
      }
    }
    for (const post of parts.posts) {
      expect(post.center.y - post.length / 2).toBeGreaterThanOrEqual(LANE.floorY - 1e-6);
    }
  });

  it('runs the two rails parallel with a ball-width gap between them', () => {
    const [a, b] = parts.rails;
    expect(a.points).toHaveLength(b.points.length);
    expect(a.radius).toBeCloseTo(b.radius, 6);
    // At every sample the two rail centerlines stay a constant gap apart in x,
    // at matching y and z, so the rails read as parallel runners.
    for (let i = 0; i < a.points.length; i += 1) {
      expect(Math.abs(a.points[i].x - b.points[i].x)).toBeCloseTo(BALL_RETURN.railGap, 6);
      expect(a.points[i].y).toBeCloseTo(b.points[i].y, 6);
      expect(a.points[i].z).toBeCloseTo(b.points[i].z, 6);
    }
    // The gap clears a ball so it reads as a track the ball rides between.
    expect(BALL_RETURN.railGap).toBeGreaterThan(0);
  });

  it('ties the rails with a cross frame at the bowler-end wait spot', () => {
    // The frame is a short bar at the runway front (zFront), near where the ball
    // waits, spanning at least the rail gap.
    expect(parts.frame.points).toHaveLength(2);
    for (const p of parts.frame.points) {
      expect(p.z).toBeCloseTo(BALL_RETURN.zFront, 6);
    }
    const span = Math.abs(parts.frame.points[0].x - parts.frame.points[1].x);
    expect(span).toBeGreaterThanOrEqual(BALL_RETURN.railGap);
  });

  it('curves the runway home: lower toward the bowler, raised down-lane', () => {
    // zFront is nearer the camera (+z, the bowler end); zBack toward the pins.
    expect(BALL_RETURN.zFront).toBeGreaterThan(BALL_RETURN.zBack);
    expect(BALL_RETURN.zFront).toBeGreaterThan(SHOT_CAMERA.ballReturnPos.z);
    const [rail] = parts.rails;
    const back = rail.points[0];
    const front = rail.points[rail.points.length - 1];
    // The runway eases down toward the bowler end so the ball would roll home.
    expect(front.z).toBeGreaterThan(back.z);
    expect(front.y).toBeLessThan(back.y);
  });

  it('bends the runway laterally so the rails read as a curved track', () => {
    // The centerline swings outboard through the middle and back in at the ends,
    // so the rail x is not constant (a straight chute would be flat in x).
    const [rail] = parts.rails;
    const xs = rail.points.map((p) => p.x);
    const spread = Math.max(...xs) - Math.min(...xs);
    expect(spread).toBeGreaterThan(0.02);
  });
});
