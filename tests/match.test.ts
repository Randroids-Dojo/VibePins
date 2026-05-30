// Unit tests for the pure match model (src/match.ts), exercised without a store.

import { describe, expect, it } from 'vitest';
import {
  createMatch,
  joinMatch,
  seatForSecret,
  toPublicMatch,
  clampSeatCount,
  sanitizeName,
  MIN_SEATS,
  MAX_SEATS,
  DEFAULT_SEATS,
  MATCH_TTL_SECONDS,
} from '../src/match.js';

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

describe('constants', () => {
  it('matches the GDD: 2 to a small number of seats, week-long TTL', () => {
    expect(MIN_SEATS).toBe(2);
    expect(MAX_SEATS).toBeGreaterThanOrEqual(MIN_SEATS);
    expect(MATCH_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
