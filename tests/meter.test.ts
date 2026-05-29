import { describe, it, expect } from 'vitest';
import { SweepMeter, meterBandSpan, type SweepMeterConfig } from '../src/meter.js';

const cfg: SweepMeterConfig = { sweepsPerSecond: 1 };
const make = () => new SweepMeter(cfg);

describe('SweepMeter sweep', () => {
  it('starts idle and only moves once started', () => {
    const m = make();
    expect(m.currentPhase).toBe('idle');
    const before = m.position;
    expect(m.update(0.5)).toBe(before); // idle does not move
    expect(m.currentPhase).toBe('idle');
  });

  it('begins at one end of the track when started', () => {
    const m = make();
    m.start();
    expect(m.currentPhase).toBe('sweeping');
    expect(m.isSweeping).toBe(true);
    expect(m.position).toBeCloseTo(1, 6); // triangle(0) = +1
  });

  it('sweeps to the far end and back, staying within [-1, 1]', () => {
    const m = make();
    m.start();
    // One sweep (end to end) takes 1 / sweepsPerSecond = 1s. Sample across it.
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) samples.push(m.update(0.1));
    for (const v of samples) {
      expect(v).toBeGreaterThanOrEqual(-1.0001);
      expect(v).toBeLessThanOrEqual(1.0001);
    }
    // It must actually reach the far end (near -1) within a full sweep.
    expect(Math.min(...samples)).toBeLessThan(-0.9);
    // And it must come back up toward +1 (the cursor reverses, not wraps).
    const min = Math.min(...samples);
    const minIdx = samples.indexOf(min);
    expect(Math.max(...samples.slice(minIdx + 1))).toBeGreaterThan(-0.5);
  });

  it('reaches the far end at the half-cycle and returns at the full cycle', () => {
    const m = make();
    m.start();
    m.update(1); // half a back-and-forth cycle (one end-to-end sweep)
    expect(m.position).toBeCloseTo(-1, 4);
    m.update(1); // back to the start end
    expect(m.position).toBeCloseTo(1, 4);
  });
});

describe('SweepMeter stop', () => {
  it('freezes the captured position and ignores further updates', () => {
    const m = make();
    m.start();
    m.update(0.25); // a quarter sweep, mid-track
    const live = m.position;
    m.stop();
    expect(m.currentPhase).toBe('stopped');
    expect(m.isSweeping).toBe(false);
    const captured = m.position;
    expect(captured).toBeCloseTo(live, 6);
    expect(m.update(0.5)).toBeCloseTo(captured, 6); // stopped does not drift
  });

  it('only stops while sweeping (a stray second confirm is a no-op)', () => {
    const m = make();
    m.stop(); // idle: no-op
    expect(m.currentPhase).toBe('idle');
    m.start();
    m.update(0.25);
    m.stop();
    const captured = m.position;
    m.stop(); // already stopped: must not recapture
    expect(m.position).toBeCloseTo(captured, 6);
  });

  it('can capture a near-centre stop, used as the straight shot', () => {
    const m = make();
    m.start();
    // A quarter cycle from +1 lands at 0 (the centre crossing).
    m.update(0.5);
    m.stop();
    expect(m.position).toBeCloseTo(0, 4);
  });
});

describe('meterBandSpan (REQ-038 gauge sweet-spot geometry)', () => {
  // A 420px track with a 20px rail inset on each end: rail span is 380px,
  // centred at 20 + 190 = 210px.
  const W = 420;
  const INSET = 20;

  it('centres the band on the rail midpoint', () => {
    const { leftPx, widthPx } = meterBandSpan(0.2, W, INSET);
    // Band spans [-0.2, +0.2] of the rail: width = 0.2 * 380 = 76px,
    // centred at 210, so left = 210 - 38 = 172.
    expect(widthPx).toBeCloseTo(76, 6);
    expect(leftPx).toBeCloseTo(172, 6);
    expect(leftPx + widthPx / 2).toBeCloseTo(210, 6); // midpoint is the rail centre
  });

  it('widens the band as the half-width grows (observable, monotonic)', () => {
    const narrow = meterBandSpan(0.1, W, INSET).widthPx;
    const wide = meterBandSpan(0.3, W, INSET).widthPx;
    expect(wide).toBeGreaterThan(narrow);
  });

  it('a zero band has no width and sits at the rail centre', () => {
    const { leftPx, widthPx } = meterBandSpan(0, W, INSET);
    expect(widthPx).toBeCloseTo(0, 6);
    expect(leftPx).toBeCloseTo(210, 6);
  });

  it('clamps a band wider than the track to the full rail span', () => {
    const { leftPx, widthPx } = meterBandSpan(5, W, INSET);
    expect(widthPx).toBeCloseTo(380, 6); // full rail span, no spill past the ends
    expect(leftPx).toBeCloseTo(20, 6); // starts at the left rail inset
  });
});
