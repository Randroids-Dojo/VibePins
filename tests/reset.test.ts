import { describe, it, expect } from 'vitest';
import { RESET, TANGLE, LANE, PIN_REST_Y, type Vec3 } from '../src/config.js';
import { ResetCycle, pinTargetFor, type ResetConfig, type ResetPhase } from '../src/reset.js';

const restY = PIN_REST_Y;
const cfg: ResetConfig = { ...RESET, restY };
// A cycle config WITH the tangle drop-and-unwind recovery armed (REQ-024).
const recoveryCfg: ResetConfig = { ...RESET, ...TANGLE, restY };
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

describe('reset target selection (REQ-009, REQ-019, REQ-021)', () => {
  const allTen = Array.from({ length: 10 }, (_, i) => i);

  it('between-balls reels the WHOLE rack up: every pin is carried, not just the fallen ones', () => {
    const rc = new ResetCycle(cfg);
    const fallen = [0, 3, 7];
    rc.start('between-balls', fallen, homeSpots, settledSpots);
    // The recall-all motion: all ten pins are reeled up, not only the fallen ones.
    expect([...rc.targets].sort((a, b) => a - b)).toEqual(allTen);
    const touched = new Set<number>();
    for (let i = 0; i < rc.totalFrames; i += 1) {
      for (const target of rc.step()) touched.add(target.pinIndex);
    }
    expect([...touched].sort((a, b) => a - b)).toEqual(allTen);
  });

  it('between-balls lands the STANDING pins home and holds the FALLEN pins aloft', () => {
    const rc = new ResetCycle(cfg);
    const fallen = [0, 3, 7];
    const standing = allTen.filter((i) => !fallen.includes(i));
    rc.start('between-balls', fallen, homeSpots, settledSpots);
    expect([...rc.landedTargets].sort((a, b) => a - b)).toEqual(standing);
    expect([...rc.heldAloftTargets].sort((a, b) => a - b)).toEqual(fallen);

    // Drive to the final step and inspect each pin's end target. Standing pins
    // land on their home spot at deck height; fallen pins stay aloft at liftPinY.
    let last = rc.step();
    while (rc.isRunning) last = rc.step();
    const at = (pin: number) => last.find((t) => t.pinIndex === pin)!;
    for (const i of standing) {
      expect(at(i).x).toBe(homeSpots[i].x);
      expect(at(i).z).toBe(homeSpots[i].z);
      expect(at(i).y).toBe(restY);
    }
    for (const i of fallen) {
      expect(at(i).x).toBeCloseTo(settledSpots[i].x, 6);
      expect(at(i).z).toBeCloseTo(settledSpots[i].z, 6);
      expect(at(i).y).toBeCloseTo(cfg.liftPinY, 6);
    }
  });

  it('rerack reels all ten and lands all ten home (none held aloft)', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    expect(rc.targets.length).toBe(10);
    expect([...rc.landedTargets].sort((a, b) => a - b)).toEqual(allTen);
    expect(rc.heldAloftTargets.length).toBe(0);
  });

  it('a fallen pin lifts with the rack before holding aloft (observable rise then hold)', () => {
    const rc = new ResetCycle(cfg);
    const fallen = [4];
    rc.start('between-balls', fallen, homeSpots, settledSpots);
    const pin = 4;
    const at = (arr: ReturnType<ResetCycle['step']>) => arr.find((t) => t.pinIndex === pin)!;
    // Settle-hold: on the deck.
    expect(at(rc.step()).y).toBeCloseTo(restY, 6);
    // Mid-lift: risen off the deck.
    stepN(rc, RESET.settleHoldFrames + Math.floor(RESET.liftFrames / 2));
    expect(at(rc.step()).y).toBeGreaterThan(restY);
    // Through reposition and lower it stays aloft over its settled spot, never set
    // back down (REQ-009 cleared out of play).
    stepN(rc, RESET.liftFrames);
    const repos = at(rc.step());
    expect(repos.y).toBeCloseTo(cfg.liftPinY, 6);
    expect(repos.x).toBeCloseTo(settledSpots[pin].x, 6);
    while (rc.isRunning) rc.step();
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

// Pure, deterministic coverage of the tangle drop-and-unwind recovery controller
// (REQ-024). The "is the rack tangled?" verdict is injected via reportTangle, so
// the loop logic is testable without any physics: no-tangle fast path, tangled
// then clears after N drops, and the retry cap forcing a clear.
describe('tangle drop-and-unwind recovery controller (REQ-024)', () => {
  const allTen = Array.from({ length: 10 }, (_, i) => i);

  // Run the cycle to completion, answering the tangle verdict from `verdicts`
  // (one per checkpoint, defaulting to clear once the list runs out). Returns the
  // ordered list of distinct phases seen, so the recovery sub-phases are visible.
  function runWithVerdicts(rc: ResetCycle, verdicts: boolean[]): ResetPhase[] {
    rc.start('rerack', [], homeSpots, settledSpots);
    const phases: ResetPhase[] = [];
    let checkpoint = 0;
    let guard = 0;
    while (rc.isRunning && guard < 10_000) {
      if (rc.needsTangleVerdict) {
        const tangled = verdicts[checkpoint] ?? false;
        checkpoint += 1;
        rc.reportTangle(tangled);
        continue;
      }
      if (phases[phases.length - 1] !== rc.phase) phases.push(rc.phase);
      rc.step();
      guard += 1;
    }
    return phases;
  }

  it('always drops for a hang test, and on a clear verdict re-lifts then sets the rack', () => {
    const rc = new ResetCycle(recoveryCfg);
    const phases = runWithVerdicts(rc, [false]);
    // The rack always drops (release) for the check, then a clear verdict reels it
    // back up (re-lift) before setting. One release, no further drops.
    expect(phases).toEqual([
      'settle-hold',
      'lift',
      'release',
      'verify-clear',
      're-lift',
      'reposition',
      'lower',
    ]);
    expect(phases.filter((p) => p === 'release').length).toBe(1);
    expect(rc.retryCount).toBe(0);
    expect(rc.isComplete()).toBe(true);
  });

  it('on a tangle, drops and unwinds (release then verify) repeatedly until clear', () => {
    const rc = new ResetCycle(recoveryCfg);
    // Tangled at the first two checks, clear at the third.
    const phases = runWithVerdicts(rc, [true, true, false]);
    expect(phases).toEqual([
      'settle-hold',
      'lift',
      'release',
      'verify-clear',
      're-lift',
      'release',
      'verify-clear',
      're-lift',
      'release',
      'verify-clear',
      're-lift',
      'reposition',
      'lower',
    ]);
    expect(rc.retryCount).toBe(2);
    // Three drops total: the initial check plus the two retries.
    expect(phases.filter((p) => p === 'release').length).toBe(3);
    expect(rc.isComplete()).toBe(true);
  });

  it('is bounded: a rack that never clears force-clears at the retry cap', () => {
    const rc = new ResetCycle(recoveryCfg);
    // Always tangled. The loop must still terminate at maxRetries retries.
    const phases = runWithVerdicts(rc, Array(50).fill(true));
    expect(rc.retryCount).toBe(TANGLE.maxRetries);
    // maxRetries retry drops plus the initial check drop, then it set the rack.
    expect(phases.filter((p) => p === 'release').length).toBe(TANGLE.maxRetries + 1);
    expect(phases[phases.length - 2]).toBe('reposition');
    expect(phases[phases.length - 1]).toBe('lower');
    expect(rc.isComplete()).toBe(true);
  });

  it('a release lowers the held pins toward releaseY, then a re-lift reels them back up', () => {
    const rc = new ResetCycle(recoveryCfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    // Drive to the release that precedes the first hang test.
    let guard = 0;
    while (rc.phase !== 'release' && guard < 10_000) {
      rc.step();
      guard += 1;
    }
    expect(rc.phase).toBe('release');
    const pin = 3;
    const at = (arr: ReturnType<ResetCycle['step']>) => arr.find((t) => t.pinIndex === pin)!;
    // Mid-release the held pin is lowered below the aloft clearance (paying out).
    for (let i = 0; i < Math.floor(TANGLE.releaseFrames / 2); i += 1) rc.step();
    const dropMid = at(rc.step());
    expect(dropMid.y).toBeLessThan(recoveryCfg.liftPinY!);
    expect(dropMid.y).toBeGreaterThan(recoveryCfg.releaseY!);
    // The release runs into verify-clear; report a tangle to reel it back up.
    while (rc.phase === 'release') rc.step();
    expect(rc.phase).toBe('verify-clear');
    while (!rc.needsTangleVerdict) rc.step();
    rc.reportTangle(true);
    expect(rc.phase).toBe('re-lift');
    let last = rc.step();
    while (rc.phase === 're-lift') last = rc.step();
    // The last re-lift step reaches the aloft clearance again.
    expect(at(last).y).toBeCloseTo(recoveryCfg.liftPinY!, 6);
  });

  it('the no-recovery config (no tangle tunables) skips verify-clear entirely', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    const seen = new Set<ResetPhase>();
    while (rc.isRunning) {
      seen.add(rc.phase);
      expect(rc.needsTangleVerdict).toBe(false);
      rc.step();
    }
    expect(seen.has('verify-clear')).toBe(false);
    expect(seen.has('release')).toBe(false);
    expect([...seen].sort()).toEqual(['lift', 'lower', 'reposition', 'settle-hold']);
  });

  it('reportTangle is a no-op when the cycle is not at a verdict checkpoint', () => {
    const rc = new ResetCycle(recoveryCfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    expect(rc.needsTangleVerdict).toBe(false);
    rc.reportTangle(true); // ignored mid-lift
    rc.step();
    expect(rc.phase).toBe('settle-hold');
    expect(rc.retryCount).toBe(0);
    expect(rc.targets.length).toBe(allTen.length);
  });

  it('a recovery cycle still completes the full settle-lift-reposition-lower on a clean rack', () => {
    const rc = new ResetCycle(recoveryCfg);
    const phases = runWithVerdicts(rc, [false]);
    expect(phases[0]).toBe('settle-hold');
    expect(phases[1]).toBe('lift');
    expect(phases[phases.length - 1]).toBe('lower');
  });
});

describe('pinTargetFor recovery choreography (REQ-024)', () => {
  const home: Vec3 = { x: 0.2, y: restY, z: -18.3 };
  const settled: Vec3 = { x: 0.6, y: 0.05, z: -18.0 };

  it('holds the pin at the dropped height (releaseY) during verify-clear', () => {
    expect(pinTargetFor('verify-clear', 0.5, home, settled, recoveryCfg)).toEqual({
      x: settled.x,
      y: recoveryCfg.releaseY,
      z: settled.z,
    });
  });

  it('lowers the pin from liftPinY down toward releaseY during release', () => {
    const top = pinTargetFor('release', 0, home, settled, recoveryCfg);
    expect(top.y).toBeCloseTo(recoveryCfg.liftPinY!, 6);
    const bottom = pinTargetFor('release', 1, home, settled, recoveryCfg);
    expect(bottom.y).toBeCloseTo(recoveryCfg.releaseY!, 6);
    expect(bottom.y).toBeLessThan(top.y);
  });

  it('reels the pin from the deck back up to the clearance during re-lift', () => {
    expect(pinTargetFor('re-lift', 0, home, settled, recoveryCfg).y).toBeCloseTo(restY, 6);
    expect(pinTargetFor('re-lift', 1, home, settled, recoveryCfg).y).toBeCloseTo(recoveryCfg.liftPinY!, 6);
  });
});
