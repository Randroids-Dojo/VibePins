// In-match frame accumulation tests (REQ-053). The shot loop feeds each settled
// ball's pin-fall (a dead ball is a zero) into the accumulator; these assert the
// frame array it builds and when it reports the turn over, mirroring the duckpin
// turn-end rules the server validates. No DOM, no physics (RULE 9).

import { describe, it, expect } from 'vitest';
import { MatchFrameAccumulator, matchFrameComplete } from '../src/matchFrame.js';

describe('matchFrameComplete (REQ-053 turn-end)', () => {
  it('ends a normal frame on a first-ball strike', () => {
    expect(matchFrameComplete([10], 0)).toBe(true);
  });

  it('ends a normal frame on a two-ball spare', () => {
    expect(matchFrameComplete([6, 4], 3)).toBe(true);
    expect(matchFrameComplete([6, 3], 3)).toBe(false);
  });

  it('runs a normal open frame the full three balls', () => {
    expect(matchFrameComplete([3, 2], 5)).toBe(false);
    expect(matchFrameComplete([3, 2, 1], 5)).toBe(true);
  });

  it('always takes three balls in the tenth frame, even on a strike', () => {
    expect(matchFrameComplete([10], 9)).toBe(false);
    expect(matchFrameComplete([10, 10], 9)).toBe(false);
    expect(matchFrameComplete([10, 10, 10], 9)).toBe(true);
    // A spared tenth still owes its bonus ball.
    expect(matchFrameComplete([6, 4], 9)).toBe(false);
    expect(matchFrameComplete([6, 4, 5], 9)).toBe(true);
  });
});

describe('MatchFrameAccumulator (REQ-053 pin-fall to balls)', () => {
  it('collects per-ball pin-fall in throw order for an open frame', () => {
    const acc = new MatchFrameAccumulator(0);
    expect(acc.record(3)).toBe(false);
    expect(acc.record(2)).toBe(false);
    expect(acc.record(1)).toBe(true);
    expect(acc.balls).toEqual([3, 2, 1]);
    expect(acc.isComplete).toBe(true);
  });

  it('reports complete after a first-ball strike with a single ball', () => {
    const acc = new MatchFrameAccumulator(2);
    expect(acc.record(10)).toBe(true);
    expect(acc.balls).toEqual([10]);
  });

  it('reports complete on a spare after two balls', () => {
    const acc = new MatchFrameAccumulator(4);
    expect(acc.record(7)).toBe(false);
    expect(acc.record(3)).toBe(true);
    expect(acc.balls).toEqual([7, 3]);
  });

  it('records a dead-ball zero like any other count', () => {
    const acc = new MatchFrameAccumulator(0);
    acc.record(0); // foul / gutter, zero pin-fall, rack kept
    acc.record(4);
    acc.record(0); // another dead ball
    expect(acc.balls).toEqual([0, 4, 0]);
    expect(acc.isComplete).toBe(true);
  });

  it('takes three balls for a tenth-frame strike with bonus balls', () => {
    const acc = new MatchFrameAccumulator(9);
    expect(acc.record(10)).toBe(false); // strike
    expect(acc.record(10)).toBe(false); // bonus 1 on a fresh rack
    expect(acc.record(7)).toBe(true); // bonus 2
    expect(acc.balls).toEqual([10, 10, 7]);
  });

  it('rounds and floors a noisy reading to a legal non-negative integer', () => {
    const acc = new MatchFrameAccumulator(0);
    acc.record(2.6);
    acc.record(-1);
    expect(acc.balls).toEqual([3, 0]);
  });

  it('ignores a late settle once the turn is already over', () => {
    const acc = new MatchFrameAccumulator(0);
    acc.record(10); // strike ends the turn
    expect(acc.record(5)).toBe(true); // no-op, already complete
    expect(acc.balls).toEqual([10]);
  });
});
