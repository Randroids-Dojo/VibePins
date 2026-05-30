import { describe, it, expect } from 'vitest';
import { pinRackPositions, pinMassProperties, duckpinProfilePoints } from '../src/pins.js';
import { LANE, TETHER } from '../src/config.js';

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

describe('duckpinProfilePoints (REQ-026 squat silhouette)', () => {
  const h = LANE.pinHeight;
  const r = LANE.pinBellyRadius;
  const profile = duckpinProfilePoints(h, r);

  it('spans the full pin height from base to top, centred on the body', () => {
    const ys = profile.map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(-h / 2, 6);
    expect(Math.max(...ys)).toBeCloseTo(h / 2, 6);
  });

  it('rises monotonically up the silhouette so the lathe revolves cleanly', () => {
    for (let i = 1; i < profile.length; i += 1) {
      expect(profile[i].y).toBeGreaterThanOrEqual(profile[i - 1].y);
    }
  });

  it('caps the base and crown on the axis (closed solid, no open ends)', () => {
    expect(profile[0].x).toBe(0);
    expect(profile[profile.length - 1].x).toBe(0);
  });

  it('keeps every radius within the belly radius (belly is the widest point)', () => {
    const widest = Math.max(...profile.map((p) => p.x));
    expect(widest).toBeCloseTo(r, 6);
    for (const p of profile) {
      expect(p.x).toBeLessThanOrEqual(r + 1e-9);
      expect(p.x).toBeGreaterThanOrEqual(0);
    }
  });

  it('puts the fat belly low in the body, below the geometric centre', () => {
    const belly = profile.reduce((a, b) => (b.x > a.x ? b : a));
    expect(belly.y).toBeLessThan(0);
  });

  it('pinches in to a neck above the belly, near the cord anchor', () => {
    const belly = profile.reduce((a, b) => (b.x > a.x ? b : a));
    // The cord attaches at TETHER.neckLocalY above centre; the silhouette should
    // narrow there relative to the belly so the cord leaves a real neck.
    const neckBand = profile.filter(
      (p) => p.y > belly.y && Math.abs(p.y - TETHER.neckLocalY) < h * 0.15,
    );
    expect(neckBand.length).toBeGreaterThan(0);
    for (const p of neckBand) {
      expect(p.x).toBeLessThan(belly.x * 0.7);
    }
  });
});
