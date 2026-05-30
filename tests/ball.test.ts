import { describe, it, expect } from 'vitest';
import { LANE, SPIN, POWER, AIM, SHOT_CAMERA } from '../src/config.js';
import {
  ballSpawnPosition,
  ballLaunchVelocity,
  spinFraction,
  powerSpeed,
  baseAimLateralSpeed,
  aimGuideEndpoints,
} from '../src/ball.js';

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

  it('launches straight down-lane at the configured speed by default', () => {
    expect(velocity.x).toBe(0);
    expect(velocity.y).toBe(0);
    expect(velocity.z).toBe(-LANE.ballLaunchSpeed);
  });

  it('is dominated by its down-lane component (lateral nudge stays small)', () => {
    const right = ballLaunchVelocity(1);
    expect(Math.abs(right.z)).toBeGreaterThan(Math.abs(right.x));
    expect(Math.abs(right.z)).toBeGreaterThan(Math.abs(right.y));
  });

  it('reaches the pins in a few seconds, guarding against speed typos', () => {
    const distance = Math.abs(ballSpawnPosition().z - LANE.headSpot.z);
    const arrivalSeconds = distance / LANE.ballLaunchSpeed;
    expect(arrivalSeconds).toBeGreaterThan(1);
    expect(arrivalSeconds).toBeLessThan(5);
  });
});

describe('spinFraction (REQ-034, REQ-036)', () => {
  it('reads a centred stop as straight, with no spin', () => {
    expect(spinFraction(0)).toBe(0);
    expect(spinFraction(SPIN.straightBand)).toBe(0);
    expect(spinFraction(-SPIN.straightBand)).toBe(0);
  });

  it('ramps from 0 at the band edge to full at the extreme', () => {
    expect(spinFraction(1)).toBeCloseTo(1, 6);
    expect(spinFraction(-1)).toBeCloseTo(-1, 6);
    // Just outside the band is a small fraction, not a jump to full.
    const justOut = spinFraction(SPIN.straightBand + 0.001);
    expect(justOut).toBeGreaterThan(0);
    expect(justOut).toBeLessThan(0.05);
  });

  it('keeps the sign of the stop (positive is right) and is monotonic', () => {
    expect(spinFraction(0.5)).toBeGreaterThan(0);
    expect(spinFraction(-0.5)).toBeLessThan(0);
    expect(spinFraction(0.9)).toBeGreaterThan(spinFraction(0.5));
  });

  it('clamps stops beyond the track', () => {
    expect(spinFraction(2)).toBeCloseTo(1, 6);
    expect(spinFraction(-2)).toBeCloseTo(-1, 6);
  });
});

describe('ballLaunchVelocity with spin (REQ-036)', () => {
  it('nudges a full-side stop laterally toward that side, down-lane unchanged', () => {
    const right = ballLaunchVelocity(1);
    expect(right.x).toBeCloseTo(SPIN.maxLateralSpeed, 6);
    expect(right.z).toBe(-LANE.ballLaunchSpeed);
    const left = ballLaunchVelocity(-1);
    expect(left.x).toBeCloseTo(-SPIN.maxLateralSpeed, 6);
  });

  it('leaves a straight stop with no lateral component', () => {
    expect(ballLaunchVelocity(0).x).toBe(0);
    expect(ballLaunchVelocity(SPIN.straightBand).x).toBe(0);
  });
});

describe('spin config tunables', () => {
  it('are present, finite, and sane for the playtest gate', () => {
    expect(SPIN.sweepsPerSecond).toBeGreaterThan(0);
    expect(SPIN.straightBand).toBeGreaterThan(0);
    expect(SPIN.straightBand).toBeLessThan(1);
    expect(SPIN.maxLateralSpeed).toBeGreaterThan(0);
    // The lateral nudge must not overwhelm the down-lane throw.
    expect(SPIN.maxLateralSpeed).toBeLessThan(LANE.ballLaunchSpeed);
    expect(SPIN.maxSpinYaw).toBeGreaterThan(0);
  });
});

describe('powerSpeed (REQ-035)', () => {
  it('gives full power across the centred sweet-spot band', () => {
    expect(powerSpeed(0)).toBe(POWER.maxSpeed);
    expect(powerSpeed(POWER.sweetSpotBand)).toBe(POWER.maxSpeed);
    expect(powerSpeed(-POWER.sweetSpotBand)).toBe(POWER.maxSpeed);
  });

  it('ramps down to the minimum at the track extremes', () => {
    expect(powerSpeed(1)).toBeCloseTo(POWER.minSpeed, 6);
    expect(powerSpeed(-1)).toBeCloseTo(POWER.minSpeed, 6);
  });

  it('is symmetric in the stop sign (only distance from centre matters)', () => {
    expect(powerSpeed(0.6)).toBeCloseTo(powerSpeed(-0.6), 6);
  });

  it('falls off monotonically from the band edge to the extreme', () => {
    expect(powerSpeed(0.3)).toBeGreaterThan(powerSpeed(0.6));
    expect(powerSpeed(0.6)).toBeGreaterThan(powerSpeed(0.9));
  });

  it('stays between the min and max for any stop, never stalling', () => {
    for (const stop of [-2, -1, -0.5, 0, 0.5, 1, 2]) {
      const v = powerSpeed(stop);
      expect(v).toBeGreaterThanOrEqual(POWER.minSpeed);
      expect(v).toBeLessThanOrEqual(POWER.maxSpeed);
    }
  });
});

describe('ballLaunchVelocity with power (REQ-035, REQ-036)', () => {
  it('drives the down-lane speed from the power stop', () => {
    expect(ballLaunchVelocity(0, 0).z).toBeCloseTo(-POWER.maxSpeed, 6);
    expect(ballLaunchVelocity(0, 1).z).toBeCloseTo(-POWER.minSpeed, 6);
  });

  it('falls back to the legacy fixed speed when no power stop is given', () => {
    expect(ballLaunchVelocity(0).z).toBe(-LANE.ballLaunchSpeed);
    expect(ballLaunchVelocity(1).z).toBe(-LANE.ballLaunchSpeed);
  });

  it('scales the spin nudge with speed so the launch angle tracks the spin', () => {
    // A weak (slow) full-side shot leans less sideways in absolute terms than a
    // full-power one, but the lateral-to-downlane ratio (the angle) holds.
    const fast = ballLaunchVelocity(1, 0);
    const slow = ballLaunchVelocity(1, 1);
    expect(Math.abs(slow.x)).toBeLessThan(Math.abs(fast.x));
    expect(Math.abs(fast.x / fast.z)).toBeCloseTo(Math.abs(slow.x / slow.z), 6);
  });
});

describe('power config tunables', () => {
  it('are present, finite, and sane for the playtest gate', () => {
    expect(POWER.sweepsPerSecond).toBeGreaterThan(0);
    expect(POWER.sweetSpotBand).toBeGreaterThan(0);
    expect(POWER.sweetSpotBand).toBeLessThan(1);
    // A mistimed stop is weaker than the sweet spot but still moves the ball.
    expect(POWER.minSpeed).toBeGreaterThan(0);
    expect(POWER.minSpeed).toBeLessThan(POWER.maxSpeed);
  });
});

describe('baseAimLateralSpeed (REQ-033 base aim)', () => {
  const speed = LANE.ballLaunchSpeed;

  it('is zero for a centred stance (a straight shot stays straight)', () => {
    expect(baseAimLateralSpeed(0, speed)).toBe(0);
  });

  it('points a right (+x) stance back toward centre with a negative x velocity', () => {
    expect(baseAimLateralSpeed(SHOT_CAMERA.alignLimit, speed)).toBeLessThan(0);
  });

  it('points a left (-x) stance back toward centre with a positive x velocity', () => {
    expect(baseAimLateralSpeed(-SHOT_CAMERA.alignLimit, speed)).toBeGreaterThan(0);
  });

  it('is symmetric in the stance sign (mirror stances mirror the aim)', () => {
    const right = baseAimLateralSpeed(SHOT_CAMERA.alignLimit, speed);
    const left = baseAimLateralSpeed(-SHOT_CAMERA.alignLimit, speed);
    expect(left).toBeCloseTo(-right, 6);
  });

  it('grows with the stance offset (further off centre aims back harder)', () => {
    const near = Math.abs(baseAimLateralSpeed(SHOT_CAMERA.alignLimit * 0.5, speed));
    const far = Math.abs(baseAimLateralSpeed(SHOT_CAMERA.alignLimit, speed));
    expect(far).toBeGreaterThan(near);
  });

  it('scales with down-lane speed so the aim angle is preserved, not the absolute drift', () => {
    const fast = baseAimLateralSpeed(SHOT_CAMERA.alignLimit, speed);
    const slow = baseAimLateralSpeed(SHOT_CAMERA.alignLimit, speed * 0.5);
    expect(Math.abs(slow)).toBeLessThan(Math.abs(fast));
    // The aim angle (lateral / down-lane) is the same at both speeds: it points
    // the ball at the same spot, it just covers it slower at a weaker throw.
    expect(slow / (speed * 0.5)).toBeCloseTo(fast / speed, 6);
  });

  it('stays a gentle correction at full stance, never overwhelming the roll', () => {
    // The base-aim drift over a full shot is small relative to the down-lane
    // speed: it points the ball at the pins, it does not throw it sideways.
    expect(Math.abs(baseAimLateralSpeed(SHOT_CAMERA.alignLimit, speed))).toBeLessThan(speed);
  });
});

describe('ballLaunchVelocity with base aim (REQ-033, REQ-036)', () => {
  it('adds the stance aim to a centred-spin launch so an off-centre line points back', () => {
    const rightStance = ballLaunchVelocity(0, undefined, SHOT_CAMERA.alignLimit);
    expect(rightStance.x).toBeCloseTo(baseAimLateralSpeed(SHOT_CAMERA.alignLimit, LANE.ballLaunchSpeed), 6);
    expect(rightStance.x).toBeLessThan(0);
    expect(rightStance.z).toBe(-LANE.ballLaunchSpeed);
  });

  it('combines spin and base aim additively', () => {
    const stance = SHOT_CAMERA.alignLimit;
    const combined = ballLaunchVelocity(1, undefined, stance);
    const spinOnly = ballLaunchVelocity(1, undefined, 0).x;
    const aimOnly = baseAimLateralSpeed(stance, LANE.ballLaunchSpeed);
    expect(combined.x).toBeCloseTo(spinOnly + aimOnly, 6);
  });

  it('leaves a centred stance with the spin-only lateral component', () => {
    expect(ballLaunchVelocity(0, undefined, 0).x).toBe(0);
    expect(ballLaunchVelocity(1, undefined, 0).x).toBeCloseTo(SPIN.maxLateralSpeed, 6);
  });
});

describe('aimGuideEndpoints (REQ-033 line-up aim guide)', () => {
  it('starts the guide at the release point shifted by the stance', () => {
    const stance = 0.3;
    const guide = aimGuideEndpoints(stance);
    expect(guide.start.x).toBeCloseTo(LANE.headSpot.x + stance, 6);
    expect(guide.start.z).toBeCloseTo(LANE.ballSpawnZ, 6);
    expect(guide.start.y).toBe(LANE.floorY);
  });

  it('ends the guide at the base-aim target depth (the pin deck)', () => {
    const guide = aimGuideEndpoints(0.2);
    expect(guide.end.z).toBeCloseTo(AIM.targetZ, 6);
    expect(guide.end.y).toBe(LANE.floorY);
  });

  it('tracks the stance: the start x moves one-for-one with the stance', () => {
    const left = aimGuideEndpoints(-0.4).start.x;
    const centre = aimGuideEndpoints(0).start.x;
    const right = aimGuideEndpoints(0.4).start.x;
    expect(centre).toBeCloseTo(LANE.headSpot.x, 6);
    expect(right - centre).toBeCloseTo(0.4, 6);
    expect(centre - left).toBeCloseTo(0.4, 6);
  });

  it('runs straight down-lane for a centred stance (start and end share x)', () => {
    const guide = aimGuideEndpoints(0);
    expect(guide.end.x).toBeCloseTo(guide.start.x, 6);
  });

  it('angles an off-centre guide back toward the pocket (the end is inboard of the start)', () => {
    const right = aimGuideEndpoints(0.4);
    // A right (+x) stance aims back toward centre, so the down-lane end sits left
    // of (less than) the release point.
    expect(right.end.x).toBeLessThan(right.start.x);
    const left = aimGuideEndpoints(-0.4);
    expect(left.end.x).toBeGreaterThan(left.start.x);
  });

  it('aims the guide end exactly at the launch base-aim heading (matches the physics)', () => {
    // The guide slope is the base-aim x-velocity over the down-lane speed, so the
    // end x is the start x plus that slope times the down-lane travel. This ties the
    // visible guide to the same base aim ballLaunchVelocity resolves at launch.
    const stance = 0.35;
    const guide = aimGuideEndpoints(stance);
    const v = ballLaunchVelocity(0, undefined, stance);
    const travel = LANE.ballSpawnZ - AIM.targetZ; // positive
    const expectedEndX = guide.start.x + (v.x / LANE.ballLaunchSpeed) * travel;
    expect(guide.end.x).toBeCloseTo(expectedEndX, 6);
  });

  it('lands the end on the head spot at full aim strength (a centred attack)', () => {
    // Independent of AIM.strength's tuned value: at strength 1 the base aim cancels
    // the lateral start, so the guide end x reaches headSpot.x. We verify the slope
    // identity holds by reconstructing the strength-1 end from the helper output.
    const stance = 0.35;
    const guide = aimGuideEndpoints(stance);
    const travel = LANE.ballSpawnZ - AIM.targetZ;
    const slope = (guide.end.x - guide.start.x) / travel;
    // The realized correction is AIM.strength of the full (headSpot.x - startX)/travel.
    const fullSlope = slope / AIM.strength;
    const endAtFullStrength = guide.start.x + fullSlope * travel;
    expect(endAtFullStrength).toBeCloseTo(LANE.headSpot.x, 6);
  });
});

describe('aim config tunables', () => {
  it('are present, finite, and sane for the playtest gate', () => {
    expect(Number.isFinite(AIM.targetZ)).toBe(true);
    expect(AIM.targetZ).toBeLessThan(LANE.ballSpawnZ);
    expect(AIM.strength).toBeGreaterThan(0);
    expect(AIM.strength).toBeLessThanOrEqual(1);
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
