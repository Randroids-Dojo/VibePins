// Async multiplayer match backend (GDD 05-async-multiplayer, REQ-048/052/054/055,
// REQ-064).
//
// A Vercel serverless function backed by the same Upstash Redis store as the
// leaderboard, in a distinct `vibepins:match:` keyspace (RULE 11: one store, never
// shared with a sibling project, namespaced per feature). All state transitions
// live in the pure src/match.ts model; this file only routes, validates the wire
// boundary, and reads/writes Redis.
//
// This route ships create / join / resume, the persisted match data model, and
// turn submission (PATCH): turn-order enforcement and out-of-turn rejection
// (REQ-049), server-authoritative duckpin scoring of each frame (REQ-053), and
// locking the match to `complete` once every seat finishes ten frames (REQ-056).
// The handoff and waiting UI (REQ-050/051) and posting a finished line to the
// leaderboard (REQ-058) remain follow-on slices tracked as dots.

import { Redis } from '@upstash/redis';
import { matchCreateSchema, matchJoinSchema, matchSubmitSchema, parse } from './schemas.js';
import {
  createMatch,
  joinMatch,
  seatForSecret,
  submitTurn,
  toPublicMatch,
  MATCH_TTL_SECONDS,
  type MatchState,
} from '../src/match.js';

// Minimal Vercel Node request/response shapes so this type-checks without pulling
// in @vercel/node (not a project dependency), matching api/leaderboard.ts.
interface MatchRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface MatchResponse {
  status(code: number): MatchResponse;
  json(body: unknown): MatchResponse;
  setHeader(name: string, value: string): void;
  end(): MatchResponse;
}

const MATCH_PREFIX = 'vibepins:match:';

let client: Redis | null = null;
function redis(): Redis {
  if (client) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Match store is not configured');
  }
  client = new Redis({ url, token });
  return client;
}

function setCors(res: MatchResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Match-Secret');
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Read the caller's per-seat secret. Prefer the X-Match-Secret header so the
// secret stays out of URLs (browser history, proxy/CDN logs, referrers); fall
// back to the query param for clients that cannot set a header.
function seatSecret(req: MatchRequest): string | undefined {
  const header = req.headers ? firstParam(req.headers['x-match-secret']) : undefined;
  return header ?? firstParam(req.query.secret);
}

function matchKey(id: string): string {
  return `${MATCH_PREFIX}${id}`;
}

// Generate a per-device seat secret. crypto.randomUUID is browser-native and
// available in the Node serverless runtime, so it is not a new dependency (RULE 3).
function newSecret(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

// Load a match, refreshing its TTL on read so an actively-played match never ages
// out mid-game (REQ-054). Upstash may auto-deserialize the JSON value, so handle
// both an object and a raw string defensively (matching the leaderboard parser).
async function loadMatch(id: string): Promise<MatchState | null> {
  const kv = redis();
  const raw = await kv.get(matchKey(id));
  if (raw == null) return null;
  let state: MatchState;
  try {
    state = typeof raw === 'string' ? (JSON.parse(raw) as MatchState) : (raw as MatchState);
  } catch {
    return null;
  }
  if (!state || typeof state !== 'object' || !Array.isArray(state.seats)) return null;
  await kv.expire(matchKey(id), MATCH_TTL_SECONDS);
  return state;
}

async function saveMatch(state: MatchState): Promise<void> {
  const kv = redis();
  await kv.set(matchKey(state.id), JSON.stringify(state), { ex: MATCH_TTL_SECONDS });
}

// POST with no id: create a match. The creator claims seat 1 and gets their
// per-seat secret back so this device can resume the seat (GDD create flow).
async function handleCreate(req: MatchRequest, res: MatchResponse): Promise<MatchResponse> {
  // zod validates the body shape and bounds (name optional string, seatCount an
  // integer in [MIN_SEATS, MAX_SEATS]); clampSeatCount in the pure model still
  // applies the final clamp, so behaviour is unchanged for in-range input.
  const parsed = parse(matchCreateSchema, req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const body = parsed.data;
  const id = globalThis.crypto.randomUUID();
  const creatorSecret = newSecret();
  const state = createMatch({
    id,
    creatorName: body.name,
    creatorSecret,
    seatCount: body.seatCount,
  });
  await saveMatch(state);
  return res.status(201).json({
    match: toPublicMatch(state),
    // The caller persists this locally; it authorizes seat 1's future submissions.
    seat: 1,
    secret: creatorSecret,
  });
}

// POST with an id: join the match by claiming the next open seat (GDD join flow).
async function handleJoin(req: MatchRequest, id: string, res: MatchResponse): Promise<MatchResponse> {
  // zod validates the join body shape (id/name optional strings); the id used to
  // route here was already resolved by the caller from query-or-body.
  const parsed = parse(matchJoinSchema, req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const body = parsed.data;
  const state = await loadMatch(id);
  if (!state) {
    return res.status(404).json({ error: 'match not found' });
  }
  const secret = newSecret();
  const result = joinMatch(state, { name: body.name, secret });
  if (!result.ok || !result.seat) {
    return res.status(409).json({ error: result.error ?? 'cannot join match' });
  }
  await saveMatch(state);
  return res.status(200).json({
    match: toPublicMatch(state),
    seat: result.seat.seat,
    secret,
  });
}

// GET ?id=...: resume / view a match. A device that passes its per-seat secret
// gets told which seat it owns (GDD resume flow); without one it gets the public
// view only (a fresh recipient opening the link before claiming a seat).
async function handleGet(req: MatchRequest, res: MatchResponse): Promise<MatchResponse> {
  const id = firstParam(req.query.id);
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }
  const state = await loadMatch(id);
  if (!state) {
    return res.status(404).json({ error: 'match not found' });
  }
  const mySeat = seatForSecret(state, seatSecret(req));
  return res.status(200).json({ match: toPublicMatch(state), mySeat });
}

async function handlePost(req: MatchRequest, res: MatchResponse): Promise<MatchResponse> {
  // An id selects join; its absence selects create. The id can ride the query
  // string or the body so the client can use either.
  const body = (req.body ?? {}) as { id?: unknown };
  const id = firstParam(req.query.id) ?? (typeof body.id === 'string' ? body.id : undefined);
  if (id) {
    return handleJoin(req, id, res);
  }
  return handleCreate(req, res);
}

// PATCH ?id=...: submit the current player's completed frame (REQ-049/053). The
// seat secret rides the X-Match-Secret header; the body carries the frame number
// and the frame's ball pinfalls. All turn-order and scoring authority lives in
// the pure model, so this only loads, applies, and persists.
async function handleSubmit(req: MatchRequest, res: MatchResponse): Promise<MatchResponse> {
  const id = firstParam(req.query.id) ?? (() => {
    const body = (req.body ?? {}) as { id?: unknown };
    return typeof body.id === 'string' ? body.id : undefined;
  })();
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }
  // zod validates the submit body shape and bounds (frame an integer in [1,10],
  // balls a 1..3 array of pinfalls in [0,10]). The pure submitTurn keeps every
  // authority: turn order, the frame matching currentFrame, and duckpin legality
  // via scoreGame (REQ-049, REQ-053). A malformed or out-of-range body is
  // rejected here before any of that runs.
  const parsed = parse(matchSubmitSchema, req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const body = parsed.data;
  const state = await loadMatch(id);
  if (!state) {
    return res.status(404).json({ error: 'match not found' });
  }
  const result = submitTurn(state, {
    secret: seatSecret(req),
    frame: body.frame,
    balls: body.balls,
  });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error ?? 'cannot submit turn' });
  }
  await saveMatch(state);
  // The caller re-renders from the authoritative public view (status, whose turn,
  // every seat's scored line).
  return res.status(200).json({ match: toPublicMatch(state) });
}

export default async function handler(req: MatchRequest, res: MatchResponse): Promise<MatchResponse> {
  setCors(res);
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res);
    if (req.method === 'PATCH') return await handleSubmit(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // Never leak the error detail (could contain connection strings): log only the
    // message, never the full error object.
    const message = err instanceof Error ? err.message : 'unknown';
    console.error('Match error:', message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
