// Async multiplayer match model (GDD 05-async-multiplayer, REQ-048/052/054/055).
//
// Pure, framework-free, JSON-serializable match state plus the create/join/resume
// transitions. The serverless route (api/match.ts) holds the only Redis calls; all
// of the actual state logic lives here so it can be unit tested without a store and
// reused on the client to render the scoreboard without re-simulating.
//
// This module ships the match data model, the create/join/resume transitions, and
// the turn submission transition: turn-order enforcement (REQ-049), out-of-turn
// rejection, server-authoritative duckpin scoring of each submitted frame via the
// shared scoring engine (REQ-053), and locking the match to `complete` once every
// seat finishes ten frames (REQ-056 final-standings groundwork). The handoff link
// and your-turn/waiting UI (REQ-050/051) and posting a finished line to the
// leaderboard (REQ-058) remain follow-on slices.

import { FRAME_COUNT, scoreGame, type GameFrames } from './scoring.js';

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

const PINS = 10;

// A bowled frame is "complete" (the turn is over) when no more balls are owed.
// Mirrors the duckpin rules the scoring engine encodes (REQ-002 to REQ-007):
//   - First two balls clear all ten (strike or spare): two balls end the turn,
//     except the tenth frame which grants bonus balls.
//   - Otherwise the turn runs the full three balls.
// The tenth frame always takes exactly three balls: strike grants two bonus
// balls, spare grants one, flat ten / open already used all three.
function frameComplete(balls: readonly number[], frameIndex: number): boolean {
  const isTenth = frameIndex === FRAME_COUNT - 1;
  if (isTenth) return balls.length === 3;
  if (balls.length >= 1 && balls[0] === PINS) return true; // strike: early-out
  if (balls.length >= 2 && balls[0] + balls[1] === PINS) return true; // spare: early-out
  return balls.length === 3; // open or flat ten
}

export interface SubmitResult {
  ok: boolean;
  error?: string;
  // HTTP-ish status the route maps directly: 403 not-your-turn, 409 illegal move,
  // 200 accepted. Present on every result so the route never guesses.
  status: number;
}

// Submit a completed frame for the seat that owns `secret` (REQ-049 turn order,
// REQ-053 server-authoritative scoring). The server is the sole authority:
//   1. The secret must own a seat (else not-your-turn, no info leak about seats).
//   2. It must be that seat's turn (currentSeat) or the submission is rejected.
//   3. The submitted frame must be the frame the match is on (currentFrame).
//   4. The frame must be a legal, complete duckpin frame for that seat's line,
//      validated by the shared scoring engine (no client-trusted scores).
// On success the frame is appended to the seat's line and the turn advances:
// to the next seat in the same frame, or to seat 1 of the next frame once every
// seat has bowled this frame. When all seats finish ten frames the match locks
// to `complete`. `now` is injected for deterministic tests. Mutates `match` in
// place; the route persists it.
export function submitTurn(
  match: MatchState,
  opts: { secret: string | undefined; frame: number; balls: number[]; now?: string },
): SubmitResult {
  if (match.status === 'complete') {
    return { ok: false, error: 'match is already complete', status: 409 };
  }
  if (match.status !== 'active') {
    return { ok: false, error: 'match has not started', status: 409 };
  }

  const seatNumber = seatForSecret(match, opts.secret);
  if (seatNumber == null) {
    return { ok: false, error: 'not a player in this match', status: 403 };
  }
  if (seatNumber !== match.currentSeat) {
    return { ok: false, error: 'not your turn', status: 403 };
  }
  if (opts.frame !== match.currentFrame) {
    return { ok: false, error: `expected frame ${match.currentFrame}`, status: 409 };
  }

  const seat = match.seats[seatNumber - 1];
  const frameIndex = match.currentFrame - 1;

  if (!Array.isArray(opts.balls)) {
    return { ok: false, error: 'balls must be an array', status: 409 };
  }
  if (!frameComplete(opts.balls, frameIndex)) {
    return { ok: false, error: 'frame is incomplete', status: 409 };
  }

  // Validate the seat's line with the submitted frame appended. The scoring
  // engine rejects out-of-range pins, illegal ball values, and over-rack counts.
  const candidate: number[][] = [...seat.frames.map((f) => [...f]), [...opts.balls]];
  const scored = scoreGame(candidate);
  if (!scored.valid) {
    return { ok: false, error: scored.error ?? 'illegal frame', status: 409 };
  }

  seat.frames = candidate;

  // Advance the turn. Standard bowling order: every seat bowls the current frame
  // before the frame clock advances (GDD: players alternate by frame).
  if (match.currentSeat < match.seatCount) {
    match.currentSeat += 1;
  } else {
    match.currentSeat = 1;
    match.currentFrame += 1;
  }

  // The match is complete once every seat has a full ten-frame, scored line.
  if (match.seats.every((s) => scoreGame(s.frames).complete)) {
    match.status = 'complete';
  }

  match.updatedAt = opts.now ?? new Date().toISOString();
  return { ok: true, status: 200 };
}

// One row of a match's final standings (REQ-056). The seat's authoritative total
// is the duckpin score the shared engine computed from that seat's recorded line,
// so a standings row never trusts a client-claimed number. `rank` is 1-based and
// shared on a tie (two seats on the same total both rank #1, the next seat #3).
// `complete` is whether that seat's line is a full, scoreGame-complete ten frames;
// it is false only when standings are read before the match locks.
export interface Standing {
  readonly seat: number;
  readonly name: string;
  readonly score: number;
  readonly complete: boolean;
  readonly rank: number;
}

// Rank every seat by its authoritative duckpin total, highest first (REQ-056
// final standings). Pure: it re-scores each seat's recorded line with the shared
// engine (the same authority submitTurn used to accept the frames) and never reads
// a claimed score. An incomplete line scores 0 and sorts last among equal-or-lower
// totals; this matters only when standings are read before the match locks, which
// the UI does not do (it shows standings on `complete`). Ties share a rank, the
// standard-competition way (1, 1, 3). Seat order breaks an exact tie so the result
// is deterministic. Returns a fresh array; does not mutate the match.
export function computeStandings(match: MatchState | PublicMatch): Standing[] {
  const scored = match.seats.map((seat) => {
    const result = scoreGame(seat.frames);
    return {
      seat: seat.seat,
      name: seat.name,
      score: result.finalScore ?? 0,
      complete: result.complete,
    };
  });
  // Highest score first; an exact tie keeps the lower seat number ahead so the
  // order is stable and deterministic across calls.
  scored.sort((a, b) => b.score - a.score || a.seat - b.seat);
  let lastScore = Number.NaN;
  let lastRank = 0;
  return scored.map((row, index) => {
    // Standard competition ranking: equal scores share a rank, the next distinct
    // score skips to its absolute position (1, 1, 3).
    const rank = row.score === lastScore ? lastRank : index + 1;
    lastScore = row.score;
    lastRank = rank;
    return { ...row, rank };
  });
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
