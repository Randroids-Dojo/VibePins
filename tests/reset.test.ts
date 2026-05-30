import { describe, it, expect } from 'vitest';
import { RESET, TANGLE, LANE, TETHER, PIN_REST_Y, type Vec3 } from '../src/config.js';
import { ResetCycle, pinTargetFor, ropeLengthFor, type ResetConfig, type ResetPhase } from '../src/reset.js';

const restY = PIN_REST_Y;
const cfg: ResetConfig = { ...RESET, restY };
// A cycle config WITH the genuine-snag up/down shake recovery armed (REQ-024).
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

describe('reset phase ordering (no-recovery cycle)', () => {
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
});

describe('cord-tension lift: the cord reels in, the pin is not carried (REQ-024)', () => {
  it('emits a shortening rope length during lift and NO kinematic target', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    stepN(rc, RESET.settleHoldFrames); // now at the top of settle-hold, entering lift
    expect(rc.phase).toBe('lift');

    // Early lift: cord still long (near slack), no kinematic carry target.
    const early = rc.step();
    expect(early.targets.length).toBe(0); // the pin is dynamic and hangs, not carried
    expect(early.reel.length).toBe(10);
    const earlyLen = early.reel[0].ropeLength;

    // Late lift: cord reeled much shorter, dragging the neck up.
    stepN(rc, RESET.liftFrames - 2);
    const late = rc.step();
    expect(late.targets.length).toBe(0);
    const lateLen = late.reel[0].ropeLength;
    expect(lateLen).toBeLessThan(earlyLen);
    // The reel-up ends near the short lifted rope length, well under slack.
    expect(lateLen).toBeLessThan(RESET.slackRopeLength);
    expect(lateLen).toBeCloseTo(RESET.liftRopeLength, 1);
  });

  it('ropeLengthFor shortens from slack to lifted across the lift', () => {
    expect(ropeLengthFor('lift', 0, cfg)).toBeCloseTo(RESET.slackRopeLength, 6);
    expect(ropeLengthFor('lift', 1, cfg)).toBeCloseTo(RESET.liftRopeLength, 6);
    expect(ropeLengthFor('lift', 0.25, cfg)).toBeGreaterThan(ropeLengthFor('lift', 0.75, cfg));
  });

  it('settle-hold emits neither a carry nor a reel (the rack rests on the deck)', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    const out = rc.step();
    expect(rc.phase).toBe('settle-hold');
    expect(out.targets.length).toBe(0);
    expect(out.reel.length).toBe(0);
  });
});

describe('reset target selection (REQ-009, REQ-019, REQ-021)', () => {
  const allTen = Array.from({ length: 10 }, (_, i) => i);

  it('between-balls reels the WHOLE rack up: every pin is reeled, not just the fallen ones', () => {
    const rc = new ResetCycle(cfg);
    const fallen = [0, 3, 7];
    rc.start('between-balls', fallen, homeSpots, settledSpots);
    expect([...rc.targets].sort((a, b) => a - b)).toEqual(allTen);
    const reeled = new Set<number>();
    for (let i = 0; i < rc.totalFrames; i += 1) {
      for (const r of rc.step().reel) reeled.add(r.pinIndex);
    }
    expect([...reeled].sort((a, b) => a - b)).toEqual(allTen);
  });

  it('between-balls lands the STANDING pins home and holds the FALLEN pins aloft', () => {
    const rc = new ResetCycle(cfg);
    const fallen = [0, 3, 7];
    const standing = allTen.filter((i) => !fallen.includes(i));
    rc.start('between-balls', fallen, homeSpots, settledSpots);
    expect([...rc.landedTargets].sort((a, b) => a - b)).toEqual(standing);
    expect([...rc.heldAloftTargets].sort((a, b) => a - b)).toEqual(fallen);

    // Drive to the final step and inspect each pin's end carry target. Standing
    // pins land on their home spot at deck height; fallen pins stay aloft.
    let last = rc.step();
    while (rc.isRunning) last = rc.step();
    const at = (pin: number) => last.targets.find((t) => t.pinIndex === pin)!;
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
});

describe('pinTargetFor carry choreography (reposition / lower)', () => {
  const home: Vec3 = { x: 0.2, y: restY, z: -18.3 };
  const settled: Vec3 = { x: 0.6, y: 0.05, z: -18.0 };

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

  it('holds a fallen pin aloft over its settled spot through reposition and lower', () => {
    const repos = pinTargetFor('reposition', 0.5, home, settled, cfg, true);
    expect(repos).toEqual({ x: settled.x, y: cfg.liftPinY, z: settled.z });
    const low = pinTargetFor('lower', 0.5, home, settled, cfg, true);
    expect(low).toEqual({ x: settled.x, y: cfg.liftPinY, z: settled.z });
  });

  it('lifts the pin clear of the standing pins (liftPinY above pinHeight)', () => {
    expect(cfg.liftPinY - LANE.pinHeight / 2).toBeGreaterThan(LANE.pinHeight);
  });
});

describe('reset lifecycle edges', () => {
  it('emits nothing and is not complete before it is started', () => {
    const rc = new ResetCycle(cfg);
    expect(rc.update(1)).toEqual({ targets: [], reel: [] });
    expect(rc.step()).toEqual({ targets: [], reel: [] });
    expect(rc.isComplete()).toBe(false);
    expect(rc.phase).toBe('idle');
  });

  it('lands every carried pin on its home spot on the final step', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    let last = rc.step();
    while (rc.isRunning) last = rc.step();
    expect(last.targets.length).toBe(10);
    for (const target of last.targets) {
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

// Pure, deterministic coverage of the genuine-snag up/down shake recovery
// controller (REQ-024). The snag verdict is injected via reportSnag, so the loop
// logic is testable without any physics. The KEY REGRESSION: a clean rack runs NO
// shake (it goes straight from lift to reposition). Only a genuine snag shakes.
describe('genuine-snag up/down shake recovery controller (REQ-024)', () => {
  const allTen = Array.from({ length: 10 }, (_, i) => i);

  // Run the cycle to completion, answering the snag verdict from `verdicts` (one
  // per checkpoint, defaulting to clear once the list runs out). Returns the
  // ordered list of distinct phases seen.
  function runWithVerdicts(rc: ResetCycle, verdicts: boolean[]): ResetPhase[] {
    rc.start('rerack', [], homeSpots, settledSpots);
    const phases: ResetPhase[] = [];
    let checkpoint = 0;
    let guard = 0;
    while (rc.isRunning && guard < 10_000) {
      if (rc.needsSnagVerdict) {
        const snagged = verdicts[checkpoint] ?? false;
        checkpoint += 1;
        rc.reportSnag(snagged);
        continue;
      }
      if (phases[phases.length - 1] !== rc.phase) phases.push(rc.phase);
      rc.step();
      guard += 1;
    }
    return phases;
  }

  it('KEY REGRESSION: a clean rack runs NO shake (lift goes straight to reposition)', () => {
    const rc = new ResetCycle(recoveryCfg);
    const phases = runWithVerdicts(rc, [false]);
    // The reel-up checks once (verify-lift), finds no snag, and sets the rack. No
    // shake-down or shake-up runs: this is the bug the playtester reported (an
    // up/down unwind on EVERY reset). A clean rack must NOT shake.
    expect(phases).toEqual(['settle-hold', 'lift', 'verify-lift', 'reposition', 'lower']);
    expect(phases).not.toContain('shake-down');
    expect(phases).not.toContain('shake-up');
    expect(rc.retryCount).toBe(0);
    expect(rc.isComplete()).toBe(true);
  });

  it('on a genuine snag, runs an up/down shake then re-checks, until clear', () => {
    const rc = new ResetCycle(recoveryCfg);
    // Snagged at the first two checks, clear at the third.
    const phases = runWithVerdicts(rc, [true, true, false]);
    expect(phases).toEqual([
      'settle-hold',
      'lift',
      'verify-lift',
      'shake-down',
      'shake-up',
      'verify-lift',
      'shake-down',
      'shake-up',
      'verify-lift',
      'reposition',
      'lower',
    ]);
    expect(rc.retryCount).toBe(2);
    expect(phases.filter((p) => p === 'shake-down').length).toBe(2);
    expect(rc.isComplete()).toBe(true);
  });

  it('is bounded: a rack that never clears force-clears at the retry cap', () => {
    const rc = new ResetCycle(recoveryCfg);
    const phases = runWithVerdicts(rc, Array(50).fill(true));
    expect(rc.retryCount).toBe(TANGLE.maxRetries);
    expect(phases.filter((p) => p === 'shake-down').length).toBe(TANGLE.maxRetries);
    expect(phases[phases.length - 2]).toBe('reposition');
    expect(phases[phases.length - 1]).toBe('lower');
    expect(rc.isComplete()).toBe(true);
  });

  it('a shake-down pays the cord back out, then a shake-up reels it in again', () => {
    const rc = new ResetCycle(recoveryCfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    // Drive to the first snag verdict checkpoint.
    let guard = 0;
    while (!rc.needsSnagVerdict && guard < 10_000) {
      rc.step();
      guard += 1;
    }
    expect(rc.needsSnagVerdict).toBe(true);
    rc.reportSnag(true);
    expect(rc.phase).toBe('shake-down');
    // Shake-down pays the cord out longer than the lifted length (the visible drop).
    const downEnd = rc.step();
    void downEnd;
    let downLast = rc.step();
    while (rc.phase === 'shake-down') downLast = rc.step();
    expect(downLast.reel[0].ropeLength).toBeGreaterThan(RESET.liftRopeLength);
    expect(rc.phase).toBe('shake-up');
    // Shake-up reels back in to the lifted length.
    let upLast = rc.step();
    while (rc.phase === 'shake-up') upLast = rc.step();
    expect(upLast.reel[0].ropeLength).toBeCloseTo(RESET.liftRopeLength, 1);
  });

  it('the no-recovery config (no shake tunables) never checks for a snag', () => {
    const rc = new ResetCycle(cfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    const seen = new Set<ResetPhase>();
    while (rc.isRunning) {
      seen.add(rc.phase);
      expect(rc.needsSnagVerdict).toBe(false);
      rc.step();
    }
    expect(seen.has('verify-lift')).toBe(false);
    expect(seen.has('shake-down')).toBe(false);
    expect([...seen].sort()).toEqual(['lift', 'lower', 'reposition', 'settle-hold']);
  });

  it('reportSnag is a no-op when the cycle is not at a verdict checkpoint', () => {
    const rc = new ResetCycle(recoveryCfg);
    rc.start('rerack', [], homeSpots, settledSpots);
    expect(rc.needsSnagVerdict).toBe(false);
    rc.reportSnag(true); // ignored mid-lift
    rc.step();
    expect(rc.phase).toBe('settle-hold');
    expect(rc.retryCount).toBe(0);
    expect(rc.targets.length).toBe(allTen.length);
  });
});

describe('ropeLengthFor shake choreography (REQ-024)', () => {
  it('pays the cord out from lifted to shake length on a shake-down', () => {
    expect(ropeLengthFor('shake-down', 0, recoveryCfg)).toBeCloseTo(RESET.liftRopeLength, 6);
    expect(ropeLengthFor('shake-down', 1, recoveryCfg)).toBeCloseTo(TANGLE.shakeRopeLength, 6);
    expect(ropeLengthFor('shake-down', 1, recoveryCfg)).toBeGreaterThan(ropeLengthFor('shake-down', 0, recoveryCfg));
  });

  it('reels the cord back in from shake to lifted length on a shake-up', () => {
    expect(ropeLengthFor('shake-up', 0, recoveryCfg)).toBeCloseTo(TANGLE.shakeRopeLength, 6);
    expect(ropeLengthFor('shake-up', 1, recoveryCfg)).toBeCloseTo(RESET.liftRopeLength, 6);
  });

  it('the shake pays out shorter than the full slack (the rack stays aloft)', () => {
    expect(TANGLE.shakeRopeLength).toBeLessThan(TETHER.slackLength);
    expect(TANGLE.shakeRopeLength).toBeGreaterThan(RESET.liftRopeLength);
  });
});
