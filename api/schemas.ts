// Shared zod schemas for the serverless API wire boundary (GDD 06-reuse-and-tech
// async-backend, REQ-064: "zod-validated payloads").
//
// zod validates the SHAPE and BOUNDS of every request at the boundary: field
// types, array structure, integer ranges, string length. It is deliberately the
// outer gate, not the scoring authority. The duckpin rules (a strike ends a
// frame, a rack holds ten pins, bonus balls re-rack only as needed) stay in the
// pure scoreGame engine (src/scoring.ts) and the pure match transitions
// (src/match.ts); those remain the sole authority that ranks the board and
// accepts a turn (REQ-053, REQ-059). zod only encodes the same clamps the routes
// previously hand-checked, so a malformed, oversized, or out-of-range payload is
// rejected with a 400 before it ever reaches the scoring layer.

import { z } from 'zod';
import { FRAME_COUNT } from '../src/scoring.js';
import { MIN_SEATS, MAX_SEATS } from '../src/match.js';

const PINS = 10;

// A display name on the wire. sanitizeName (in src/match.ts / api/leaderboard.ts)
// stays the canonical authority that strips disallowed characters and clamps to
// NAME_MAX_LEN (it sanitizes rather than rejects, so a normal over-long name is
// trimmed, not 400'd). zod adds only a hard upper safety bound so an absurdly
// oversized string is rejected at the boundary before it reaches the sanitizer.
const NAME_WIRE_MAX = 256;
const nameSchema = z.string().max(NAME_WIRE_MAX);

// A single ball's pinfall: an integer in [0, 10]. The scoring engine still
// enforces the per-rack and per-frame legality (more-than-ten in a rack, balls
// after a strike); this only rejects values that can never be a pinfall.
const ballSchema = z.number().int().min(0).max(PINS);

// One frame is a non-empty array of up to three balls (duckpin allows three per
// frame, and the tenth frame's bonus balls also live in a three-element array).
const frameSchema = z.array(ballSchema).min(1).max(3);

// The leaderboard submission payload. `frames` is the full per-frame ball
// sequence; the server re-scores it with scoreGame (never trusts a claimed
// total). `name` and `source` are optional and tolerant: the route still runs
// the pure sanitizeName, and an unknown source falls back to 'solo', so a stray
// field never rejects a legitimate score. The frame count is bounded to a real
// game (1..10) so an absurdly long array is rejected at the boundary.
export const leaderboardSubmitSchema = z.object({
  name: nameSchema.optional(),
  frames: z.array(frameSchema).min(1).max(FRAME_COUNT),
  source: z.string().optional(),
});
export type LeaderboardSubmit = z.infer<typeof leaderboardSubmitSchema>;

// The leaderboard GET query. `type` selects the board; the route reads it as
// "daily" vs anything-else means all-time, so the schema keeps it a tolerant
// optional string (a stray value must not 400 a read-only board fetch, matching
// `mode`). `limit` arrives as a string on the query and is coerced to a bounded
// positive integer (the route clamps to MAX_ENTRIES; this rejects a non-numeric
// or non-positive limit so the parse stays predictable). `name` is the optional
// rank-in-context lookup. `mode` is accepted but unused, kept tolerant so a
// future client query field never 400s a board read.
export const leaderboardQuerySchema = z.object({
  type: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  name: nameSchema.optional(),
  mode: z.string().optional(),
});
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

// Match create body. `name` is optional (sanitizeName supplies a default) and
// `seatCount` is an optional integer; the route still clamps it to [MIN, MAX],
// but zod bounds it so a wildly out-of-range or fractional value is rejected at
// the boundary rather than silently clamped.
export const matchCreateSchema = z.object({
  name: nameSchema.optional(),
  seatCount: z.number().int().min(MIN_SEATS).max(MAX_SEATS).optional(),
});
export type MatchCreate = z.infer<typeof matchCreateSchema>;

// Match join body. An `id` (when present) routes the POST to join; `name` is the
// joining player's name. Both optional at the schema level because the POST
// handler resolves the id from query-or-body and create vs join from its
// presence; the schema only guards their types.
export const matchJoinSchema = z.object({
  id: z.string().optional(),
  name: nameSchema.optional(),
});
export type MatchJoin = z.infer<typeof matchJoinSchema>;

// Match PATCH (submit turn) body. `frame` must be an integer in [1, 10] (the
// model still checks it equals the match's currentFrame). `balls` is the frame's
// pinfalls, bounded like any frame; the model's frameComplete and scoreGame
// remain the authority on duckpin legality. `id` and `secret` may ride the body
// (the route prefers query/header for each) so they are optional here.
export const matchSubmitSchema = z.object({
  id: z.string().optional(),
  secret: z.string().optional(),
  frame: z.number().int().min(1).max(FRAME_COUNT),
  balls: z.array(ballSchema).min(1).max(3),
});
export type MatchSubmit = z.infer<typeof matchSubmitSchema>;

// Parse `data` against `schema`, returning a discriminated result the routes map
// to a 400 on failure. Never throws (uses safeParse) and never echoes the raw
// input back, so a parse error cannot leak an oversized or hostile payload into
// the response.
export function parse<T>(schema: z.ZodType<T>, data: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };
  const first = result.error.issues[0];
  const path = first?.path.length ? `${first.path.join('.')}: ` : '';
  return { ok: false, error: `${path}${first?.message ?? 'invalid payload'}` };
}
