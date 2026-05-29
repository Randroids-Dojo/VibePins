import { describe, it, expect } from 'vitest';
import { RESET, LANE, PIN_REST_Y, type Vec3 } from '../src/config.js';
import { ResetCycle, pinTargetFor, type ResetConfig } from '../src/reset.js';

const restY = PIN_REST_Y;
const cfg: ResetConfig = { ...RESET, restY };
// Pin home spots (resting height) and settled positions (offset and low).
const homeSpots: Vec3[] = Array.from({ length: 10 }, (_, i) => ({ x: i * 0.1 - 0.45, y: restY, z: -18.3 }));
const settledSpots: Vec3[] = homeSpots.map((h) => ({ x: h.x + 0.4, y: 0.05, z: h.z + 0.2 }));

const stepN = (rc: ResetCycle, n: number) => {
  for (let i = 0; i < n; i += 1) rc.step();
};

describe('reset timing window', () => {
  it('totals the four phase frame counts and lands in the GDD 3-5s window', () => {
    const rc = new ResetCycle(cfg);
    expect(rc.totalFrames).toBe(
      RESET.settleHoldFrames + RESET.liftFrames + RESET.repositionFrames + RESET.lowerFrames,
    );
    const seconds = rc.totalFrames / 60;
    expect(seconds).toBeGreaterThanOrEqual(3);
    expect(seconds).toBeLessThanOrEqual(5);
  });
});

describe('reset phase ordering', () => {
  it('runs settle-hold, lift, reposition, lower in order at the frame boundaries', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    expect(rc.phase).toBe('settle-hold');
    stepN(rc, RESET.settleHoldFrames);
    expect(rc.phase).toBe('lift');
    stepN(rc, RESET.liftFrames);
    expect(rc.phase).toBe('reposition');
    stepN(rc, RESET.repositionFrames);
    expect(rc.phase).toBe('lower');
    stepN(rc, RESET.lowerFrames);
    expect(rc.phase).toBe('idle');
    expect(rc.isComplete()).toBe(true);
  });

  it('moves the carried pin in step with the phase boundaries', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    const pin = 5;
    const target = (arr: ReturnType<ResetCycle['step']>) => arr.find((t) => t.pinIndex === pin)!;

    // Mid-lift: rising off the deck, still over the settled spot.
    stepN(rc, RESET.settleHoldFrames + Math.floor(RESET.liftFrames / 2));
    const lifting = target(rc.step());
    expect(lifting.y).toBeGreaterThan(restY);
    expect(lifting.y).toBeLessThan(cfg.liftPinY);
    expect(lifting.x).toBeCloseTo(settledSpots[pin].x, 6);

    // Mid-reposition: held high, travelling between settled and home in x.
    stepN(rc, Math.floor(RESET.liftFrames / 2) + Math.floor(RESET.repositionFrames / 2));
    const carrying = target(rc.step());
    expect(carrying.y).toBeCloseTo(cfg.liftPinY, 6);
    const between = (carrying.x - homeSpots[pin].x) * (carrying.x - settledSpots[pin].x);
    expect(between).toBeLessThan(0); // strictly between home and settled x
  });
});

describe('reset target selection (REQ-019, REQ-021)', () => {
  it('between-balls carries only the fallen pins; standing pins are never moved', () => {
    const rc = new ResetCycle(cfg);
    const fallen = [0, 3, 7];
    rc.start('between-balls', fallen, homeSpots, settledSpots);
    expect([...rc.targets].sort((a, b) => a - b)).toEqual(fallen);
    const touched = new Set<number>();
    for (let i = 0; i < rc.totalFrames; i += 1) {
      for (const target of rc.step()) touched.add(target.pinIndex);
    }
    expect([...touched].sort((a, b) => a - b)).toEqual(fallen);
  });

  it('rerack carries all ten pins', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    expect(rc.targets.length).toBe(10);
  });
});

describe('pinTargetFor choreography', () => {
  const home: Vec3 = { x: 0.2, y: restY, z: -18.3 };
  const settled: Vec3 = { x: 0.6, y: 0.05, z: -18.0 };

  it('stands the pin upright at its settled spot during settle-hold', () => {
    expect(pinTargetFor('settle-hold', 0.5, home, settled, cfg)).toEqual({ x: settled.x, y: restY, z: settled.z });
  });

  it('raises the pin straight up from the deck during lift', () => {
    expect(pinTargetFor('lift', 0, home, settled, cfg)).toEqual({ x: settled.x, y: restY, z: settled.z });
    const top = pinTargetFor('lift', 1, home, settled, cfg);
    expect(top).toEqual({ x: settled.x, y: cfg.liftPinY, z: settled.z });
    expect(pinTargetFor('lift', 0.25, home, settled, cfg).y).toBeLessThan(pinTargetFor('lift', 0.75, home, settled, cfg).y);
  });

  it('carries the raised pin from over its settled spot to over home', () => {
    const begin = pinTargetFor('reposition', 0, home, settled, cfg);
    expect(begin).toEqual({ x: settled.x, y: cfg.liftPinY, z: settled.z });
    const end = pinTargetFor('reposition', 1, home, settled, cfg);
    expect(end).toEqual({ x: home.x, y: cfg.liftPinY, z: home.z });
  });

  it('lowers the pin onto its home spot during lower', () => {
    expect(pinTargetFor('lower', 0, home, settled, cfg)).toEqual({ x: home.x, y: cfg.liftPinY, z: home.z });
    expect(pinTargetFor('lower', 1, home, settled, cfg)).toEqual({ x: home.x, y: restY, z: home.z });
    expect(pinTargetFor('lower', 0.25, home, settled, cfg).y).toBeGreaterThan(pinTargetFor('lower', 0.75, home, settled, cfg).y);
  });

  it('lifts the pin clear of the standing pins (liftPinY above pinHeight)', () => {
    expect(cfg.liftPinY - LANE.pinHeight / 2).toBeGreaterThan(LANE.pinHeight);
  });
});

describe('reset lifecycle edges', () => {
  it('emits nothing and is not complete before it is started', () => {
    const rc = new ResetCycle(cfg);
    expect(rc.update(1)).toEqual([]);
    expect(rc.step()).toEqual([]);
    expect(rc.isComplete()).toBe(false);
    expect(rc.phase).toBe('idle');
  });

  it('lands every carried pin on its home spot on the final step', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    let lastTargets = rc.step();
    while (rc.isRunning) lastTargets = rc.step();
    expect(lastTargets.length).toBe(10);
    for (const target of lastTargets) {
      // The lerp clamps to its endpoints, so the final landing is exact.
      expect(target.x).toBe(homeSpots[target.pinIndex].x);
      expect(target.z).toBe(homeSpots[target.pinIndex].z);
      expect(target.y).toBe(restY);
    }
  });

  it('advances by accumulated real time through update(dt)', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    rc.update(0.5); // ~30 fixed steps
    expect(rc.phase).toBe('lift');
    expect(rc.isComplete()).toBe(false);
  });
});
