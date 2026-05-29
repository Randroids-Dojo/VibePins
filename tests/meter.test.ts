import { describe, it, expect } from 'vitest';
import { SweepMeter, type SweepMeterConfig } from '../src/meter.js';

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
