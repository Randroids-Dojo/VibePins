import { describe, it, expect } from 'vitest';
import { LANE, GROUP, PIN_PHYSICS } from '../src/config.js';

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

describe('GROUP bitmask', () => {
  it('assigns a distinct power-of-two bit to each physics layer', () => {
    const bits = Object.values(GROUP);
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) {
      expect(bit & (bit - 1)).toBe(0);
    }
  });
});
