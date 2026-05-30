// VibePins global leaderboard backend (GDD 07-leaderboard, REQ-059/060/061/064).
//
// A Vercel serverless function backed by Upstash Redis sorted sets, mirroring
// the proven Hoops pattern (see GDD 06-reuse-and-tech) but with two VibePins
// specifics:
//   1. Keyspace is prefixed `vibepins:` so it never collides with a sibling.
//   2. A submission carries the full per-frame ball sequence, and the server
//      recomputes the duckpin score with the shared scoring engine. An
//      impossible line is rejected and the server score (not a client-claimed
//      number) is what ranks the board (REQ-059).
//
// Two boards, both ranked by final score descending: an all-time board capped
// at the top 100, and a daily board that resets each UTC day with a 25-hour TTL
// (REQ-060, REQ-061). The in-game UI (submit form, board display, player-rank
// context) is deferred to later slices.

import { Redis } from '@upstash/redis';
import { scoreGame, type GameFrames } from '../src/scoring.js';

// Minimal shapes for the Vercel Node request/response so this file type-checks
// without pulling in @vercel/node (not a project dependency).
interface LeaderboardRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface LeaderboardResponse {
  status(code: number): LeaderboardResponse;
  json(body: unknown): LeaderboardResponse;
  setHeader(name: string, value: string): void;
  end(): LeaderboardResponse;
}

const ALLTIME_KEY = 'vibepins:leaderboard';
const DAILY_PREFIX = 'vibepins:daily:';
const MAX_ENTRIES = 100;
const MAX_DAILY = 50;
const NAME_MAX_LEN = 12;
const DEFAULT_NAME = 'AAA';
const DAILY_TTL_SECONDS = 25 * 60 * 60;
// A perfect duckpin game caps at 300, so any honest score is in [1, 300].
const MAX_SCORE = 300;

// Lazily construct the client so the module imports cleanly (and unit tests can
// run) without live credentials. The handler reads the legacy KV aliases that
// the provisioned Upstash store exposes, falling back to the canonical names.
let client: Redis | null = null;
function redis(): Redis {
  if (client) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Leaderboard store is not configured');
  }
  client = new Redis({ url, token });
  return client;
}

function setCors(res: LeaderboardResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function todayKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${DAILY_PREFIX}${yyyy}-${mm}-${dd}`;
}

export function sanitizeName(name: unknown): string {
  return (
    String(name ?? DEFAULT_NAME)
      .replace(/[^A-Za-z0-9_ -]/g, '')
      .trim()
      .slice(0, NAME_MAX_LEN) || DEFAULT_NAME
  );
}

interface StoredEntry {
  name: string;
  score: number;
  date: string;
  id: string;
  source: 'solo' | 'match';
}

interface BoardEntry {
  name: string;
  score: number;
  date: string;
  source: string;
}

// The player's own standing plus the entries immediately around it, so a player
// off the top slice still sees where they sit (REQ-062). `rank` is 1-based;
// `window` is the nearby slice (the player's row included), each row carrying
// its own 1-based `rank` so the client can render a contiguous neighbourhood.
interface RankContextRow extends BoardEntry {
  rank: number;
  isPlayer: boolean;
}
interface RankContext {
  name: string;
  rank: number;
  score: number;
  window: RankContextRow[];
}

// From the full ranked board (highest first), find the named player's best
// standing and the `radius` entries on each side of it. Pure so the route can
// stay thin and a test can assert the window without Redis. Matching is
// case-insensitive on the sanitized name. Returns null when the player is not on
// the board. When the player sits inside the top slice the client already shows
// them, but returning the context regardless keeps the contract simple (RULE 7);
// the client decides whether to surface it.
export function rankContext(ranked: BoardEntry[], name: string, radius = 2): RankContext | null {
  const target = name.trim().toLowerCase();
  if (!target) return null;
  // The board is score-descending, so the first match is the player's best.
  const idx = ranked.findIndex((e) => e.name.trim().toLowerCase() === target);
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(ranked.length, idx + radius + 1);
  const window: RankContextRow[] = ranked.slice(start, end).map((e, i) => ({
    ...e,
    rank: start + i + 1,
    isPlayer: start + i === idx,
  }));
  return { name: ranked[idx].name, rank: idx + 1, score: ranked[idx].score, window };
}

// Parse a zrange-with-scores reply ([member, score, member, score, ...]) into
// board entries. Upstash may auto-deserialize JSON members, so handle both a
// parsed object and a raw string defensively.
function parseEntries(raw: unknown[]): BoardEntry[] {
  const out: BoardEntry[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const memberRaw = raw[i];
    const score = Number(raw[i + 1]);
    let data: Partial<StoredEntry>;
    try {
      data = typeof memberRaw === 'string' ? (JSON.parse(memberRaw) as StoredEntry) : (memberRaw as StoredEntry);
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    out.push({
      name: typeof data.name === 'string' ? data.name : DEFAULT_NAME,
      score: Number.isFinite(score) ? score : Number(data.score) || 0,
      date: typeof data.date === 'string' ? data.date : '',
      source: data.source === 'match' ? 'match' : 'solo',
    });
  }
  return out;
}

async function handleGet(req: LeaderboardRequest, res: LeaderboardResponse): Promise<LeaderboardResponse> {
  const type = firstParam(req.query.type) === 'daily' ? 'daily' : 'alltime';
  const limitParam = parseInt(firstParam(req.query.limit) ?? '20', 10);
  const count = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20, MAX_ENTRIES);
  const key = type === 'daily' ? todayKey() : ALLTIME_KEY;
  const name = firstParam(req.query.name);

  // Without a name we only need the top slice. With one we read the whole capped
  // board so we can place the player in context (REQ-062); the board is capped at
  // MAX_ENTRIES so this stays a single bounded read.
  const fetchCount = name ? MAX_ENTRIES : count;
  const raw = (await redis().zrange(key, 0, fetchCount - 1, { rev: true, withScores: true })) as unknown[];
  const ranked = parseEntries(raw);
  const entries = ranked.slice(0, count);

  const context = name ? rankContext(ranked, name) : null;
  return res.status(200).json({ type, entries, context });
}

async function handlePost(req: LeaderboardRequest, res: LeaderboardResponse): Promise<LeaderboardResponse> {
  const body = (req.body ?? {}) as { name?: unknown; frames?: unknown; source?: unknown };

  // The wire format is the per-frame ball sequence, never a client-claimed
  // total. The server recomputes the duckpin score and rejects an impossible
  // or incomplete line (REQ-059).
  if (!Array.isArray(body.frames)) {
    return res.status(400).json({ error: 'frames must be an array of per-frame ball counts' });
  }
  const result = scoreGame(body.frames as GameFrames);
  if (!result.valid) {
    return res.status(400).json({ error: result.error ?? 'invalid game' });
  }
  if (!result.complete || result.finalScore === null) {
    return res.status(400).json({ error: 'only a completed game can post a score' });
  }
  const score = result.finalScore;
  if (score <= 0 || score > MAX_SCORE) {
    return res.status(400).json({ error: 'score out of range' });
  }

  const cleanName = sanitizeName(body.name);
  const source: StoredEntry['source'] = body.source === 'match' ? 'match' : 'solo';
  const date = new Date().toISOString();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const member = JSON.stringify({ name: cleanName, score, date, id, source });

  const kv = redis();
  await kv.zadd(ALLTIME_KEY, { score, member });

  const dailyKey = todayKey();
  await kv.zadd(dailyKey, { score, member });
  await kv.expire(dailyKey, DAILY_TTL_SECONDS);

  // Trim each board to its cap, dropping the lowest scores (rank 0 is lowest in
  // ascending order, so trim from the bottom).
  const total = await kv.zcard(ALLTIME_KEY);
  if (total > MAX_ENTRIES) {
    await kv.zremrangebyrank(ALLTIME_KEY, 0, total - MAX_ENTRIES - 1);
  }
  const dailyCount = await kv.zcard(dailyKey);
  if (dailyCount > MAX_DAILY) {
    await kv.zremrangebyrank(dailyKey, 0, dailyCount - MAX_DAILY - 1);
  }

  const rank = await kv.zrevrank(ALLTIME_KEY, member);
  return res.status(200).json({
    success: true,
    name: cleanName,
    score,
    rank: rank !== null && rank !== undefined ? rank + 1 : null,
  });
}

export default async function handler(req: LeaderboardRequest, res: LeaderboardResponse): Promise<LeaderboardResponse> {
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
    console.error('Leaderboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
