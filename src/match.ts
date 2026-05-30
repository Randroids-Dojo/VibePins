// Async multiplayer match model (GDD 05-async-multiplayer, REQ-048/052/054/055).
//
// Pure, framework-free, JSON-serializable match state plus the create/join/resume
// transitions. The serverless route (api/match.ts) holds the only Redis calls; all
// of the actual state logic lives here so it can be unit tested without a store and
// reused on the client to render the scoreboard without re-simulating.
//
// This slice ships the match data model and the create/join/resume transitions.
// Turn order enforcement (REQ-049), per-ball submission and server scoring
// (REQ-053), the handoff link UI (REQ-050/051), completion locking (REQ-056), and
// posting a finished line to the leaderboard (REQ-058) are deferred to follow-on
// slices. The shape here is built to carry those without a schema break: each seat
// already owns a `frames` line and the match carries `currentSeat`/`currentFrame`.

import { FRAME_COUNT, type GameFrames } from './scoring.js';

// A match lives for roughly a week so a day-long game never expires mid-play
// (REQ-054). The route applies this as the Redis key TTL.
export const MATCH_TTL_SECONDS = 7 * 24 * 60 * 60;

// v1 targets two players but the model must not hard-code two (GDD match-model).
export const MIN_SEATS = 2;
export const MAX_SEATS = 6;
export const DEFAULT_SEATS = 2;

export const NAME_MAX_LEN = 12;
const DEFAULT_NAME = 'Player';

export type MatchStatus = 'open' | 'active' | 'complete';

export interface MatchSeat {
  // 1-based seat index, stable for the life of the match.
  readonly seat: number;
  // Display name, set when the seat is claimed. Empty while the seat is open.
  name: string;
  // Per-device secret that authorizes this seat's submissions (REQ-052). Returned
  // only to the claimer; never exposed in the public match view.
  secret: string | null;
  // True once a name and secret have been bound to the seat.
  claimed: boolean;
  // This seat's own ten-frame line, filled in by later per-ball slices (REQ-053).
  frames: number[][];
}

export interface MatchState {
  readonly id: string;
  status: MatchStatus;
  readonly seatCount: number;
  seats: MatchSeat[];
  // Whose turn it is (1-based seat), and which frame the match is on. Carried now
  // so the deferred turn-order slice (REQ-049) does not need a schema change.
  currentSeat: number;
  currentFrame: number;
  readonly createdAt: string;
  updatedAt: string;
}

// The public, secret-free projection of a seat that any device may see.
export interface PublicSeat {
  readonly seat: number;
  readonly name: string;
  readonly claimed: boolean;
  readonly frames: number[][];
}

export interface PublicMatch {
  readonly id: string;
  readonly status: MatchStatus;
  readonly seatCount: number;
  readonly seats: PublicSeat[];
  readonly currentSeat: number;
  readonly currentFrame: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function sanitizeName(name: unknown): string {
  return (
    String(name ?? DEFAULT_NAME)
      .replace(/[^A-Za-z0-9_ -]/g, '')
      .trim()
      .slice(0, NAME_MAX_LEN) || DEFAULT_NAME
  );
}

// Clamp a requested seat count to the supported range, defaulting when absent or
// not a finite integer.
export function clampSeatCount(requested: unknown): number {
  const n = Number(requested);
  if (!Number.isFinite(n)) return DEFAULT_SEATS;
  const i = Math.trunc(n);
  if (i < MIN_SEATS) return MIN_SEATS;
  if (i > MAX_SEATS) return MAX_SEATS;
  return i;
}

// Build a fresh match. Seat 1 is claimed immediately by the creator (GDD create
// flow: "a player starts a match, gets seat 1"); the rest stay open for join.
// `id`, `secret`, and `now` are injected so this stays pure and deterministic in
// tests; the route supplies crypto-strong values.
export function createMatch(opts: {
  id: string;
  creatorName: unknown;
  creatorSecret: string;
  seatCount?: unknown;
  now?: string;
}): MatchState {
  const seatCount = clampSeatCount(opts.seatCount);
  const now = opts.now ?? new Date().toISOString();
  const seats: MatchSeat[] = [];
  for (let s = 1; s <= seatCount; s += 1) {
    seats.push({ seat: s, name: '', secret: null, claimed: false, frames: [] });
  }
  // Claim seat 1 for the creator.
  seats[0].name = sanitizeName(opts.creatorName);
  seats[0].secret = opts.creatorSecret;
  seats[0].claimed = true;
  return {
    id: opts.id,
    status: seatCount === 1 ? 'active' : 'open',
    seatCount,
    seats,
    currentSeat: 1,
    currentFrame: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export interface JoinResult {
  ok: boolean;
  error?: string;
  // The claimed seat, present only on success.
  seat?: MatchSeat;
}

// Claim the next open seat for a joining player (GDD join flow). The match becomes
// `active` once every seat is claimed. `secret` is injected by the route. Mutates
// `match` in place (the route persists it) and returns the claimed seat so the
// route can hand the secret back to the new player. Joining a full or finished
// match is rejected.
export function joinMatch(match: MatchState, opts: { name: unknown; secret: string }): JoinResult {
  if (match.status === 'complete') {
    return { ok: false, error: 'match is already complete' };
  }
  const open = match.seats.find((s) => !s.claimed);
  if (!open) {
    return { ok: false, error: 'match is full' };
  }
  open.name = sanitizeName(opts.name);
  open.secret = opts.secret;
  open.claimed = true;
  if (match.seats.every((s) => s.claimed)) {
    match.status = 'active';
  }
  match.updatedAt = new Date().toISOString();
  return { ok: true, seat: open };
}

// Resolve which seat a per-device secret owns, for the resume flow (GDD resume:
// "opening a claimed match from your device drops you back into the current
// state"). Returns the 1-based seat, or null when the secret matches no seat.
export function seatForSecret(match: MatchState, secret: string | undefined): number | null {
  if (!secret) return null;
  const seat = match.seats.find((s) => s.claimed && s.secret === secret);
  return seat ? seat.seat : null;
}

// The secret-free view safe to return to any device (GDD: a per-seat secret is
// never exposed in the public match view). Used by create/join/resume responses.
export function toPublicMatch(match: MatchState): PublicMatch {
  return {
    id: match.id,
    status: match.status,
    seatCount: match.seatCount,
    seats: match.seats.map((s) => ({
      seat: s.seat,
      name: s.name,
      claimed: s.claimed,
      // Detached copy: mutating the public view must never reach the authoritative
      // in-memory match state.
      frames: s.frames.map((frame) => [...frame]),
    })),
    currentSeat: match.currentSeat,
    currentFrame: match.currentFrame,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
  };
}

// Re-exported so the (future) scoring layer can reference the same constants.
export { FRAME_COUNT, type GameFrames };
