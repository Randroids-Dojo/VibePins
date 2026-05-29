import { describe, it, expect } from 'vitest';
import { LANE } from '../src/config.js';
import { ballSpawnPosition, ballLaunchVelocity } from '../src/ball.js';

describe('ballSpawnPosition', () => {
  const spawn = ballSpawnPosition();

  it('rests the ball on the lane bed at the centre line', () => {
    expect(spawn.x).toBe(LANE.headSpot.x);
    expect(spawn.y).toBeCloseTo(LANE.floorY + LANE.ballRadius, 6);
  });

  it('sits on the lane bed near the foul line, in view of the camera', () => {
    // The bed runs from the foul line (z=0) to the head pin, so the ball must
    // start on it (z <= 0), at the near end and in front of the camera.
    expect(spawn.z).toBeLessThanOrEqual(0);
    expect(spawn.z).toBeLessThan(LANE.cameraPos.z);
    // Fully on the bed, not hanging over the front edge.
    expect(spawn.z - LANE.ballRadius).toBeLessThan(0);
  });

  it('sits down-lane of the pins so the ball rolls toward -z to reach them', () => {
    expect(spawn.z).toBeGreaterThan(LANE.headSpot.z);
  });
});

describe('ballLaunchVelocity', () => {
  const velocity = ballLaunchVelocity();

  it('launches straight down-lane at the configured speed', () => {
    expect(velocity.x).toBe(0);
    expect(velocity.y).toBe(0);
    expect(velocity.z).toBe(-LANE.ballLaunchSpeed);
  });

  it('is dominated by its down-lane component (no lateral aim this slice)', () => {
    expect(Math.abs(velocity.z)).toBeGreaterThan(Math.abs(velocity.x));
    expect(Math.abs(velocity.z)).toBeGreaterThan(Math.abs(velocity.y));
  });

  it('reaches the pins in a few seconds, guarding against speed typos', () => {
    const distance = Math.abs(ballSpawnPosition().z - LANE.headSpot.z);
    const arrivalSeconds = distance / LANE.ballLaunchSpeed;
    expect(arrivalSeconds).toBeGreaterThan(1);
    expect(arrivalSeconds).toBeLessThan(5);
  });
});

describe('ball config tunables', () => {
  it('are present, finite, and physically sane', () => {
    expect(Number.isFinite(LANE.ballSpawnZ)).toBe(true);
    expect(LANE.ballLaunchSpeed).toBeGreaterThan(0);
    for (const v of [LANE.ballFriction, LANE.ballRestitution]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(LANE.ballLinearDamping).toBeGreaterThanOrEqual(0);
    expect(LANE.ballAngularDamping).toBeGreaterThanOrEqual(0);
  });
});
