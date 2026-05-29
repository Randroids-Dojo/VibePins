import { describe, it, expect } from 'vitest';
import { LANE, GROUP } from '../src/config.js';

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

describe('GROUP bitmask', () => {
  it('assigns a distinct power-of-two bit to each physics layer', () => {
    const bits = Object.values(GROUP);
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) {
      expect(bit & (bit - 1)).toBe(0);
    }
  });
});
