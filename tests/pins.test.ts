import { describe, it, expect } from 'vitest';
import { pinRackPositions, pinMassProperties } from '../src/pins.js';
import { LANE } from '../src/config.js';

const ROW_GAP = LANE.pinSpacing * (Math.sqrt(3) / 2);

describe('pinRackPositions', () => {
  const rack = pinRackPositions();

  it('racks exactly ten pins (GDD REQ-027)', () => {
    expect(rack).toHaveLength(10);
  });

  it('puts the head pin on the head spot', () => {
    const head = rack[0];
    expect(head.x).toBeCloseTo(LANE.headSpot.x, 6);
    expect(head.z).toBeCloseTo(LANE.headSpot.z, 6);
  });

  it('rests every pin base on the deck surface', () => {
    for (const p of rack) {
      expect(p.y).toBeCloseTo(LANE.floorY + LANE.pinHeight / 2, 6);
    }
  });

  it('forms the standard 1-2-3-4 triangle receding down-lane', () => {
    const rows = [0, 1, 2, 3].map((row) =>
      rack.filter((p) => Math.abs(p.z - (LANE.headSpot.z - row * ROW_GAP)) < 1e-6),
    );
    expect(rows.map((r) => r.length)).toEqual([1, 2, 3, 4]);
  });

  it('centres each row on the lane and spaces neighbours by pinSpacing', () => {
    for (let row = 0; row < 4; row += 1) {
      const xs = rack
        .filter((p) => Math.abs(p.z - (LANE.headSpot.z - row * ROW_GAP)) < 1e-6)
        .map((p) => p.x - LANE.headSpot.x)
        .sort((a, b) => a - b);
      const sum = xs.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(0, 6);
      for (let i = 1; i < xs.length; i += 1) {
        expect(xs[i] - xs[i - 1]).toBeCloseTo(LANE.pinSpacing, 6);
      }
    }
  });

  it('keeps the whole rack on the modeled deck', () => {
    const deepest = Math.min(...rack.map((p) => p.z));
    expect(deepest).toBeGreaterThan(LANE.headSpot.z - LANE.pinDeckDepth);
  });
});

describe('pinMassProperties', () => {
  const props = pinMassProperties();

  it('uses the configured pin mass', () => {
    expect(props.mass).toBe(LANE.pinMass);
  });

  it('drops the centre of mass below the geometric centre (belly-heavy, REQ-026)', () => {
    expect(props.centerOfMass.y).toBeLessThan(0);
  });

  it('gives positive principal angular inertia about every axis', () => {
    expect(props.principalAngularInertia.x).toBeGreaterThan(0);
    expect(props.principalAngularInertia.y).toBeGreaterThan(0);
    expect(props.principalAngularInertia.z).toBeGreaterThan(0);
  });

  it('spins more freely about the upright axis than it tips (Iy < Ix)', () => {
    // The pin is taller than it is wide, so the tipping inertia about a
    // horizontal axis exceeds the spin inertia about the upright axis.
    expect(props.principalAngularInertia.y).toBeLessThan(props.principalAngularInertia.x);
  });
});
