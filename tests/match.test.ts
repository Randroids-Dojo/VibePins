// Unit tests for the pure match model (src/match.ts), exercised without a store.

import { describe, expect, it } from 'vitest';
import {
  createMatch,
  joinMatch,
  seatForSecret,
  submitTurn,
  toPublicMatch,
  clampSeatCount,
  sanitizeName,
  MIN_SEATS,
  MAX_SEATS,
  DEFAULT_SEATS,
  MATCH_TTL_SECONDS,
  type MatchState,
} from '../src/match.js';

// A two-seat match that has flipped to active, ready for turn submission tests.
function activeTwoSeat(): MatchState {
  const m = createMatch({ id: 'm', creatorName: 'A', creatorSecret: 's1', seatCount: 2 });
  joinMatch(m, { name: 'B', secret: 's2' });
  return m;
}

describe('sanitizeName', () => {
  it('strips disallowed characters and clamps length', () => {
    expect(sanitizeName('A<b>c!@#dEFGHIJKLMNOP')).toBe('AbcdEFGHIJKL');
  });
  it('falls back to a default when empty', () => {
    expect(sanitizeName('***')).toBe('Player');
    expect(sanitizeName(undefined)).toBe('Player');
  });
});

describe('clampSeatCount', () => {
  it('defaults when absent or not finite', () => {
    expect(clampSeatCount(undefined)).toBe(DEFAULT_SEATS);
    expect(clampSeatCount('nope')).toBe(DEFAULT_SEATS);
  });
  it('clamps to the supported range and truncates', () => {
    expect(clampSeatCount(1)).toBe(MIN_SEATS);
    expect(clampSeatCount(99)).toBe(MAX_SEATS);
    expect(clampSeatCount(3.9)).toBe(3);
  });
});

describe('createMatch', () => {
  it('claims seat 1 for the creator and leaves the rest open', () => {
    const m = createMatch({ id: 'm1', creatorName: 'Ann!!', creatorSecret: 's1', seatCount: 2, now: 'T0' });
    expect(m.id).toBe('m1');
    expect(m.status).toBe('open');
    expect(m.seatCount).toBe(2);
    expect(m.seats).toHaveLength(2);
    expect(m.seats[0]).toMatchObject({ seat: 1, name: 'Ann', secret: 's1', claimed: true });
    expect(m.seats[1]).toMatchObject({ seat: 2, name: '', secret: null, claimed: false });
    expect(m.currentSeat).toBe(1);
    expect(m.currentFrame).toBe(1);
    expect(m.createdAt).toBe('T0');
  });

  it('defaults the seat count when omitted', () => {
    const m = createMatch({ id: 'm2', creatorName: 'Bob', creatorSecret: 's' });
    expect(m.seatCount).toBe(DEFAULT_SEATS);
  });
});

describe('joinMatch', () => {
  it('claims the next open seat and reports it', () => {
    const m = createMatch({ id: 'm', creatorName: 'A', creatorSecret: 's1', seatCount: 3 });
    const r = joinMatch(m, { name: 'B', secret: 's2' });
    expect(r.ok).toBe(true);
    expect(r.seat?.seat).toBe(2);
    expect(m.seats[1]).toMatchObject({ name: 'B', secret: 's2', claimed: true });
    expect(m.status).toBe('open'); // seat 3 still open
  });

  it('flips the match to active once every seat is claimed', () => {
    const m = createMatch({ id: 'm', creatorName: 'A', creatorSecret: 's1', seatCount: 2 });
    const r = joinMatch(m, { name: 'B', secret: 's2' });
    expect(r.ok).toBe(true);
    expect(m.status).toBe('active');
  });

  it('rejects joining a full match', () => {
    const m = createMatch({ id: 'm', creatorName: 'A', creatorSecret: 's1', seatCount: 2 });
    joinMatch(m, { name: 'B', secret: 's2' });
    const r = joinMatch(m, { name: 'C', secret: 's3' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/full/);
  });

  it('rejects joining a complete match', () => {
    const m = createMatch({ id: 'm', creatorName: 'A', creatorSecret: 's1', seatCount: 2 });
    m.status = 'complete';
    const r = joinMatch(m, { name: 'B', secret: 's2' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/complete/);
  });
});

describe('seatForSecret', () => {
  it('resolves the owning seat for a known secret', () => {
    const m = createMatch({ id: 'm', creatorName: 'A', creatorSecret: 's1', seatCount: 2 });
    joinMatch(m, { name: 'B', secret: 's2' });
    expect(seatForSecret(m, 's1')).toBe(1);
    expect(seatForSecret(m, 's2')).toBe(2);
  });

  it('returns null for an unknown or absent secret', () => {
    const m = createMatch({ id: 'm', creatorName: 'A', creatorSecret: 's1', seatCount: 2 });
    expect(seatForSecret(m, 'nope')).toBeNull();
    expect(seatForSecret(m, undefined)).toBeNull();
  });
});

describe('toPublicMatch', () => {
  it('never leaks seat secrets', () => {
    const m = createMatch({ id: 'm', creatorName: 'A', creatorSecret: 'topsecret', seatCount: 2 });
    const pub = toPublicMatch(m);
    expect(JSON.stringify(pub)).not.toContain('topsecret');
    expect(pub.seats[0]).not.toHaveProperty('secret');
    expect(pub.seats[0]).toMatchObject({ seat: 1, name: 'A', claimed: true });
  });

  it('returns detached frames so mutating the public view never reaches state', () => {
    const m = createMatch({ id: 'm', creatorName: 'A', creatorSecret: 's', seatCount: 2 });
    m.seats[0].frames = [[3, 4, 0]];
    const pub = toPublicMatch(m);
    pub.seats[0].frames[0].push(99);
    pub.seats[0].frames.push([1, 2, 3]);
    expect(m.seats[0].frames).toEqual([[3, 4, 0]]);
  });
});

describe('submitTurn turn order (REQ-049)', () => {
  it('accepts the seat that is on the clock and advances to the next seat', () => {
    const m = activeTwoSeat();
    const r = submitTurn(m, { secret: 's1', frame: 1, balls: [3, 4, 0], now: 'T1' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(m.seats[0].frames).toEqual([[3, 4, 0]]);
    // Same frame, turn passes to seat 2.
    expect(m.currentSeat).toBe(2);
    expect(m.currentFrame).toBe(1);
    expect(m.updatedAt).toBe('T1');
  });

  it('advances the frame clock only after every seat has bowled the frame', () => {
    const m = activeTwoSeat();
    submitTurn(m, { secret: 's1', frame: 1, balls: [10] });
    expect(m.currentFrame).toBe(1);
    submitTurn(m, { secret: 's2', frame: 1, balls: [10] });
    // Both seats finished frame 1, clock rolls to frame 2 seat 1.
    expect(m.currentSeat).toBe(1);
    expect(m.currentFrame).toBe(2);
  });

  it('rejects a submission from a seat that is not on the clock', () => {
    const m = activeTwoSeat();
    const r = submitTurn(m, { secret: 's2', frame: 1, balls: [3, 4, 0] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toMatch(/not your turn/);
    expect(m.seats[1].frames).toEqual([]);
  });

  it('rejects a submission from a stranger with no seat', () => {
    const m = activeTwoSeat();
    const r = submitTurn(m, { secret: 'intruder', frame: 1, balls: [3, 4, 0] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it('rejects a submission for the wrong frame', () => {
    const m = activeTwoSeat();
    const r = submitTurn(m, { secret: 's1', frame: 2, balls: [3, 4, 0] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/frame 1/);
  });

  it('rejects submitting to a match that is still open', () => {
    const m = createMatch({ id: 'm', creatorName: 'A', creatorSecret: 's1', seatCount: 2 });
    const r = submitTurn(m, { secret: 's1', frame: 1, balls: [3, 4, 0] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/not started/);
  });
});

describe('submitTurn server-authoritative scoring (REQ-053)', () => {
  it('rejects an incomplete frame (turn not finished)', () => {
    const m = activeTwoSeat();
    const r = submitTurn(m, { secret: 's1', frame: 1, balls: [3, 4] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/incomplete/);
  });

  it('accepts a strike or spare as a complete frame via early-out', () => {
    const strike = activeTwoSeat();
    expect(submitTurn(strike, { secret: 's1', frame: 1, balls: [10] }).ok).toBe(true);
    const spare = activeTwoSeat();
    expect(submitTurn(spare, { secret: 's1', frame: 1, balls: [6, 4] }).ok).toBe(true);
  });

  it('rejects a frame that knocks down more than ten pins', () => {
    const m = activeTwoSeat();
    const r = submitTurn(m, { secret: 's1', frame: 1, balls: [6, 6, 0] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });

  it('rejects illegal ball values', () => {
    const m = activeTwoSeat();
    const r = submitTurn(m, { secret: 's1', frame: 1, balls: [3, -1, 0] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });

  it('requires three balls in the tenth frame', () => {
    const m = activeTwoSeat();
    for (let f = 1; f <= 9; f += 1) {
      submitTurn(m, { secret: 's1', frame: f, balls: [3, 4, 0] });
      submitTurn(m, { secret: 's2', frame: f, balls: [3, 4, 0] });
    }
    expect(m.currentFrame).toBe(10);
    // A two-ball non-clearing tenth is incomplete.
    expect(submitTurn(m, { secret: 's1', frame: 10, balls: [3, 4] }).ok).toBe(false);
    expect(submitTurn(m, { secret: 's1', frame: 10, balls: [3, 4, 0] }).ok).toBe(true);
  });
});

describe('submitTurn completion locking (REQ-056)', () => {
  it('locks the match to complete once both seats finish ten frames', () => {
    const m = activeTwoSeat();
    for (let f = 1; f <= 10; f += 1) {
      submitTurn(m, { secret: 's1', frame: f, balls: [3, 4, 0] });
      const r2 = submitTurn(m, { secret: 's2', frame: f, balls: [3, 4, 0] });
      if (f < 10) expect(m.status).toBe('active');
      else expect(r2.ok).toBe(true);
    }
    expect(m.status).toBe('complete');
    // Both lines hold ten scored frames.
    expect(m.seats[0].frames).toHaveLength(10);
    expect(m.seats[1].frames).toHaveLength(10);
  });

  it('rejects any further submission once complete', () => {
    const m = activeTwoSeat();
    m.status = 'complete';
    const r = submitTurn(m, { secret: 's1', frame: 1, balls: [3, 4, 0] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/complete/);
  });
});

describe('constants', () => {
  it('matches the GDD: 2 to a small number of seats, week-long TTL', () => {
    expect(MIN_SEATS).toBe(2);
    expect(MAX_SEATS).toBeGreaterThanOrEqual(MIN_SEATS);
    expect(MATCH_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
