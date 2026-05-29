import { describe, it, expect } from 'vitest';
import { VictoryRoutine, type VictoryConfig, type Rng } from '../src/victory.js';
import { VICTORY } from '../src/config.js';

const cfg: VictoryConfig = VICTORY;

// A deterministic RNG cycling through a fixed list so spawns are reproducible.
const seq = (values: number[]): Rng => {
  let i = 0;
  return () => values[i++ % values.length];
};

const origin = { x: 0, y: 0, z: -18.29 };

describe('VictoryRoutine lifecycle', () => {
  it('is inactive with no debris and no shake before it starts', () => {
    const v = new VictoryRoutine(cfg);
    expect(v.active).toBe(false);
    expect(v.debris).toHaveLength(0);
    expect(v.shakeOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('updating before start is a no-op', () => {
    const v = new VictoryRoutine(cfg);
    v.update(0.1);
    expect(v.active).toBe(false);
    expect(v.debris).toHaveLength(0);
  });

  it('spawns the configured debris count on start and becomes active', () => {
    const v = new VictoryRoutine(cfg, () => 0.5);
    v.start(origin);
    expect(v.active).toBe(true);
    expect(v.debris).toHaveLength(cfg.debrisCount);
  });

  it('ends and clears debris and shake after the duration elapses', () => {
    const v = new VictoryRoutine(cfg, () => 0.5);
    v.start(origin);
    // Step well past the duration in small frames.
    for (let i = 0; i < 200; i++) v.update(0.016);
    expect(v.active).toBe(false);
    expect(v.debris).toHaveLength(0);
    expect(v.shakeOffset).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('VictoryRoutine debris physics (REQ-044)', () => {
  it('flings every bit upward initially (positive y velocity)', () => {
    const v = new VictoryRoutine(cfg, () => 0.5);
    v.start(origin);
    // rng 0.5 -> signed 0 for sideways, up = midpoint of [upMin, upMax].
    v.update(0.001);
    for (const bit of v.debris) {
      expect(bit.velocity.y).toBeGreaterThan(0);
      expect(bit.position.y).toBeGreaterThan(cfg.originY - 0.01);
    }
  });

  it('arcs the debris back down under gravity (y velocity decreases over time)', () => {
    const v = new VictoryRoutine(cfg, () => 0.6);
    v.start(origin);
    const firstVy = v.debris[0].velocity.y;
    for (let i = 0; i < 10; i++) v.update(0.02);
    expect(v.debris[0].velocity.y).toBeLessThan(firstVy);
  });

  it('moves each bit observably from its spawn point (RULE 10 motion)', () => {
    // Asymmetric rng so sideways velocity is non-zero on at least one axis.
    const v = new VictoryRoutine(cfg, seq([0.9, 0.1, 0.8, 0.7]));
    v.start(origin);
    const before = v.debris.map((b) => ({ ...b.position }));
    for (let i = 0; i < 5; i++) v.update(0.02);
    const after = v.debris.map((b) => b.position);
    // At least one bit has measurably changed position.
    const moved = after.some((p, i) => {
      const d = before[i];
      return Math.abs(p.x - d.x) + Math.abs(p.y - d.y) + Math.abs(p.z - d.z) > 1e-3;
    });
    expect(moved).toBe(true);
  });

  it('tumbles the debris (rotation advances)', () => {
    const v = new VictoryRoutine(cfg, seq([0.9, 0.1, 0.8, 0.2]));
    v.start(origin);
    for (let i = 0; i < 5; i++) v.update(0.02);
    const spun = v.debris.some(
      (b) => Math.abs(b.rotation.x) + Math.abs(b.rotation.y) + Math.abs(b.rotation.z) > 0,
    );
    expect(spun).toBe(true);
  });

  it('alternates spark and scrap bits for the two-tone palette', () => {
    const v = new VictoryRoutine(cfg, () => 0.5);
    v.start(origin);
    expect(v.debris[0].spark).toBe(true);
    expect(v.debris[1].spark).toBe(false);
  });

  it('spawns bits spread around the origin, not all stacked', () => {
    // A varying RNG so spawn x positions differ from bit to bit.
    let n = 0;
    const v = new VictoryRoutine(cfg, () => ((n++ * 0.137) % 1));
    v.start(origin);
    const xs = new Set(v.debris.map((b) => Math.round(b.position.x * 1000)));
    expect(xs.size).toBeGreaterThan(1);
  });
});

describe('VictoryRoutine camera shake (REQ-044)', () => {
  it('produces a non-zero shake during the shake window', () => {
    const v = new VictoryRoutine(cfg, () => 0.5);
    v.start(origin);
    v.update(0.016);
    const s = v.shakeOffset;
    const magnitude = Math.abs(s.x) + Math.abs(s.y);
    expect(magnitude).toBeGreaterThan(0);
    // Z is never shaken so down-lane framing stays stable.
    expect(s.z).toBe(0);
  });

  it('keeps the shake within the configured amplitude', () => {
    const v = new VictoryRoutine(cfg, () => 0.5);
    v.start(origin);
    for (let i = 0; i < 30; i++) {
      v.update(0.01);
      expect(Math.abs(v.shakeOffset.x)).toBeLessThanOrEqual(cfg.shakeAmplitude + 1e-9);
      expect(Math.abs(v.shakeOffset.y)).toBeLessThanOrEqual(cfg.shakeAmplitude + 1e-9);
    }
  });

  it('decays the shake to zero after the shake window even while the burst plays', () => {
    const v = new VictoryRoutine(cfg, () => 0.5);
    v.start(origin);
    // Advance past shakeSeconds but stay within durationSeconds.
    const steps = Math.ceil((cfg.shakeSeconds + 0.05) / 0.01);
    for (let i = 0; i < steps; i++) v.update(0.01);
    expect(v.active).toBe(true); // burst still running (shake < duration)
    expect(v.shakeOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('restarts cleanly on a re-trigger without stacking debris', () => {
    const v = new VictoryRoutine(cfg, () => 0.5);
    v.start(origin);
    for (let i = 0; i < 5; i++) v.update(0.02);
    v.start(origin);
    expect(v.debris).toHaveLength(cfg.debrisCount);
    // The shake clock resets, so a fresh non-zero shake is available again.
    v.update(0.016);
    expect(Math.abs(v.shakeOffset.x) + Math.abs(v.shakeOffset.y)).toBeGreaterThan(0);
  });
});
