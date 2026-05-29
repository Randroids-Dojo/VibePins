import { describe, it, expect } from 'vitest';
import { FoulDetector, isOverFoulLine, type FoulConfig } from '../src/foul.js';
import { FOUL } from '../src/config.js';
import { ballSpawnPosition } from '../src/ball.js';
import { LANE } from '../src/config.js';

// The foul line sits at the origin (z = 0); the lane runs into -z. A live ball
// at or in front of the line (z >= 0) has fouled.
const cfg: FoulConfig = { foulLineZ: 0 };

describe('isOverFoulLine: the foul-line predicate (REQ-032)', () => {
  it('is false for a ball down-lane of the line (z < foulLineZ)', () => {
    expect(isOverFoulLine(-0.15, cfg)).toBe(false);
    expect(isOverFoulLine(-5, cfg)).toBe(false);
  });

  it('is true exactly on the line (z === foulLineZ)', () => {
    expect(isOverFoulLine(0, cfg)).toBe(true);
  });

  it('is true on the approach side of the line (z > foulLineZ)', () => {
    expect(isOverFoulLine(0.01, cfg)).toBe(true);
    expect(isOverFoulLine(1, cfg)).toBe(true);
  });

  it('honors a shifted foul-line plane', () => {
    const shifted: FoulConfig = { foulLineZ: -0.2 };
    expect(isOverFoulLine(-0.25, shifted)).toBe(false);
    expect(isOverFoulLine(-0.2, shifted)).toBe(true);
  });
});

describe('FoulDetector: over-the-line release latching (REQ-032)', () => {
  it('does not foul before begin() is called', () => {
    const d = new FoulDetector(cfg);
    expect(d.fouled).toBe(false);
    expect(d.step(1)).toBe(false); // over the line, but not active yet
    expect(d.fouled).toBe(false);
  });

  it('does not foul a clean ball that stays down-lane of the line', () => {
    const d = new FoulDetector(cfg);
    d.begin();
    for (const z of [-0.15, -1, -5, -10, -18.3]) {
      expect(d.step(z)).toBe(false);
    }
    expect(d.fouled).toBe(false);
  });

  it('fouls on the first step the ball reaches the line', () => {
    const d = new FoulDetector(cfg);
    d.begin();
    expect(d.step(-0.05)).toBe(false);
    expect(d.step(0)).toBe(true); // crosses the line
    expect(d.fouled).toBe(true);
  });

  it('latches: returns true only once, then stays fouled', () => {
    const d = new FoulDetector(cfg);
    d.begin();
    expect(d.step(0.5)).toBe(true);
    expect(d.step(0.6)).toBe(false); // still over the line, already latched
    // Even if the ball later rolls back down-lane, the foul stands.
    expect(d.step(-5)).toBe(false);
    expect(d.fouled).toBe(true);
  });

  it('fouls a ball that backspins or bounces back across the line', () => {
    const d = new FoulDetector(cfg);
    d.begin();
    expect(d.step(-2)).toBe(false); // rolled down-lane
    expect(d.step(-0.5)).toBe(false); // coming back toward the line
    expect(d.step(0.1)).toBe(true); // crossed back over: foul
    expect(d.fouled).toBe(true);
  });

  it('re-arms on a fresh begin() for the next shot', () => {
    const d = new FoulDetector(cfg);
    d.begin();
    d.step(1);
    expect(d.fouled).toBe(true);
    d.begin();
    expect(d.fouled).toBe(false);
    expect(d.step(-5)).toBe(false);
  });
});

describe('FOUL config matches the lane geometry', () => {
  it('places the foul line so the default ball spawn is legal (below the line)', () => {
    // The ball spawns just inside the foul line on the lane bed; a normal launch
    // must never trip the line, or every clean shot would read as a foul.
    expect(ballSpawnPosition().z).toBeLessThan(FOUL.foulLineZ);
    expect(LANE.ballSpawnZ).toBeLessThan(FOUL.foulLineZ);
  });
});
