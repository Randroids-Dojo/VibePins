// The ball rack and the returning-ball travel path (REQ-039). ballRackPositions
// and ballReturnPathPoint / ballReturnTravelPos are pure layout derived from
// BALL_RACK and BALL_RETURN, so we can pin the rack collection and the kinematic
// return path without booting Three.js (mirrors tests/ball-return.test.ts). The
// rack must hold several balls nestled in the cradle, clear of the lane, and the
// return path must ride the chrome runway home and settle at the rack front.

import { describe, it, expect } from 'vitest';
import {
  LANE,
  BALL_RACK,
  BALL_RETURN,
  SHOT_CAMERA,
  ballRackPositions,
  ballReturnPathPoint,
} from '../src/config.js';
import { ballRackFront, ballReturnTravelPos } from '../src/ball.js';

// The lane playfield reaches out to the bed half-width plus a gutter on each
// side; the rack must sit clear of that (it is the return cradle, not the floor).
const PLAYFIELD_MAX_X = LANE.width / 2 + LANE.gutterWidth;

describe('ball rack collection (REQ-039)', () => {
  const rack = ballRackPositions();

  it('holds a collection of several balls', () => {
    expect(rack.length).toBe(BALL_RACK.count);
    expect(rack.length).toBeGreaterThanOrEqual(3);
  });

  it('queues the balls in a row up the runway behind the front pickup slot', () => {
    // Front (index 0) is bowler-most (+z); each later ball sits one spacing
    // further toward the pins (-z), so the row reads as a queue in the cradle.
    for (let i = 1; i < rack.length; i += 1) {
      expect(rack[i].z).toBeLessThan(rack[i - 1].z);
      expect(rack[i - 1].z - rack[i].z).toBeCloseTo(BALL_RACK.spacingZ, 6);
    }
    // A spacing of at least a ball diameter keeps the balls nestled, not fused.
    expect(BALL_RACK.spacingZ).toBeGreaterThanOrEqual(LANE.ballRadius * 2);
  });

  it('rests every ball clear of the lane on the cradle, above the floor', () => {
    for (const b of rack) {
      // Clear of the lane bed + gutter on the throwing-hand side.
      expect(b.x - LANE.ballRadius).toBeGreaterThan(0);
      expect(b.x).toBeGreaterThan(0);
      // Off the floor (in the cradle, not on the ground).
      expect(b.y - LANE.ballRadius).toBeGreaterThan(LANE.floorY);
    }
    // The front ball sits at the return delivery spot on the throwing-hand side,
    // not centred on the lane bed.
    expect(rack[0].x).toBeGreaterThan(0);
    expect(rack[0].x).toBeLessThan(PLAYFIELD_MAX_X);
  });

  it('seats the front pickup ball at the return delivery spot', () => {
    const front = ballRackFront();
    expect(front).toEqual(rack[0]);
    expect(front.x).toBeCloseTo(SHOT_CAMERA.ballReturnPos.x, 6);
    expect(front.z).toBeCloseTo(SHOT_CAMERA.ballReturnPos.z, 6);
  });
});

describe('returning-ball travel path (REQ-039)', () => {
  it('rides the runway centerline from the down-lane end toward the bowler', () => {
    const back = ballReturnPathPoint(0);
    const front = ballReturnPathPoint(1);
    // t = 0 is the down-lane (raised) end, t = 1 the bowler (low) end.
    expect(front.z).toBeGreaterThan(back.z);
    expect(front.y).toBeLessThan(back.y);
  });

  it('rests the ball just above the rail tops, never below the floor', () => {
    for (let i = 0; i <= 10; i += 1) {
      const p = ballReturnPathPoint(i / 10);
      // The ball centre sits above the rail top at that point (rides the gap).
      const railY = BALL_RETURN.railTopY + BALL_RETURN.runwayRise * (1 - i / 10);
      expect(p.y).toBeGreaterThan(railY);
      expect(p.y - LANE.ballRadius).toBeGreaterThan(LANE.floorY - 0.1);
    }
  });

  it('clamps progress outside [0, 1]', () => {
    expect(ballReturnPathPoint(-1)).toEqual(ballReturnPathPoint(0));
    expect(ballReturnPathPoint(2)).toEqual(ballReturnPathPoint(1));
  });

  it('travels home and settles exactly at the rack front', () => {
    const start = ballReturnTravelPos(0);
    const end = ballReturnTravelPos(1);
    // Starts up-lane at the runway back, ends nestled at the rack front.
    expect(start).toEqual(ballReturnPathPoint(0));
    const front = ballRackFront();
    expect(end.x).toBeCloseTo(front.x, 6);
    expect(end.y).toBeCloseTo(front.y, 6);
    expect(end.z).toBeCloseTo(front.z, 6);
  });

  it('carries the ball most of the way home toward the bowler before settling', () => {
    // Over the bulk of the travel the ball moves toward the bowler (+z); only the
    // brief final handoff eases laterally off the track front into the cradle.
    const early = ballReturnTravelPos(0.6).z;
    expect(early).toBeGreaterThan(ballReturnTravelPos(0).z);
  });

  it('clamps travel progress outside [0, 1]', () => {
    expect(ballReturnTravelPos(-1)).toEqual(ballReturnTravelPos(0));
    expect(ballReturnTravelPos(5)).toEqual(ballReturnTravelPos(1));
  });
});
