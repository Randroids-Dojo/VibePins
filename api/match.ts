// Async multiplayer match backend (GDD 05-async-multiplayer, REQ-048/052/054/055,
// REQ-064).
//
// A Vercel serverless function backed by the same Upstash Redis store as the
// leaderboard, in a distinct `vibepins:match:` keyspace (RULE 11: one store, never
// shared with a sibling project, namespaced per feature). All state transitions
// live in the pure src/match.ts model; this file only routes, validates the wire
// boundary, and reads/writes Redis.
//
// This slice ships create / join / resume and the persisted match data model.
// Turn-order enforcement (REQ-049), per-ball submission and server scoring
// (REQ-053), the handoff and waiting UI (REQ-050/051), completion locking
// (REQ-056), and posting a finished line to the leaderboard (REQ-058) are deferred
// to follow-on slices and tracked as dots.

import { Redis } from '@upstash/redis';
import {
  createMatch,
  joinMatch,
  seatForSecret,
  toPublicMatch,
  MATCH_TTL_SECONDS,
  type MatchState,
} from '../src/match.js';

// Minimal Vercel Node request/response shapes so this type-checks without pulling
// in @vercel/node (not a project dependency), matching api/leaderboard.ts.
interface MatchRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
  const body = (req.body ?? {}) as { name?: unknown; seatCount?: unknown };
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
  const body = (req.body ?? {}) as { name?: unknown };
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
  const secret = firstParam(req.query.secret);
  const mySeat = seatForSecret(state, secret);
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

export default async function handler(req: MatchRequest, res: MatchResponse): Promise<MatchResponse> {
  setCors(res);
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  try {
    if (req.method === 'GET') return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // Never leak the error detail (could contain connection strings).
    console.error('Match error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
