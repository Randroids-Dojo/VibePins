// Route-handler tests for the leaderboard serverless function (RULE 9).
// The Redis client is fully mocked: these never touch a live store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A controllable in-memory stand-in for the Upstash Redis client. Only the
// handful of sorted-set commands the handler uses are implemented.
const store = new Map<string, { score: number; member: string }[]>();
const mockZadd = vi.fn(async (key: string, entry: { score: number; member: string }) => {
  const list = store.get(key) ?? [];
  list.push(entry);
  list.sort((a, b) => a.score - b.score);
  store.set(key, list);
  return 1;
});
const mockZrange = vi.fn(async (key: string, start: number, stop: number, opts: { rev?: boolean }) => {
  const list = [...(store.get(key) ?? [])];
  if (opts?.rev) list.reverse();
  const slice = list.slice(start, stop + 1);
  const out: (string | number)[] = [];
  for (const e of slice) {
    out.push(e.member);
    out.push(e.score);
  }
  return out;
});
const mockExpire = vi.fn(async () => 1);
const mockZcard = vi.fn(async (key: string) => (store.get(key) ?? []).length);
const mockZremrangebyrank = vi.fn(async () => 0);
const mockZrevrank = vi.fn(async (key: string, member: string) => {
  const list = [...(store.get(key) ?? [])].sort((a, b) => b.score - a.score);
  const idx = list.findIndex((e) => e.member === member);
  return idx === -1 ? null : idx;
});

vi.mock('@upstash/redis', () => ({
  Redis: class {
    zadd = mockZadd;
    zrange = mockZrange;
    expire = mockExpire;
    zcard = mockZcard;
    zremrangebyrank = mockZremrangebyrank;
    zrevrank = mockZrevrank;
  },
}));

import handler, { sanitizeName, rankContext } from '../api/leaderboard.js';

interface MockRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  ended: boolean;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
  setHeader(name: string, value: string): void;
  end(): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    headers: {},
    ended: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res;
}

// A completed, legal ten-frame line: all open frames of [3,3,0] => 60 total.
const COMPLETE_GAME = Array.from({ length: 10 }, () => [3, 3, 0]);

beforeEach(() => {
  process.env.KV_REST_API_URL = 'https://example.upstash.io';
  process.env.KV_REST_API_TOKEN = 'test-token';
  store.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
});

describe('sanitizeName', () => {
  it('strips disallowed characters and clamps length', () => {
    expect(sanitizeName('A<b>c!@#dEFGHIJKLMNOP')).toBe('AbcdEFGHIJKL');
  });

  it('falls back to a default when empty', () => {
    expect(sanitizeName('***')).toBe('AAA');
    expect(sanitizeName(undefined)).toBe('AAA');
  });
});

describe('CORS preflight', () => {
  it('answers OPTIONS with 200 and CORS headers', async () => {
    const res = makeRes();
    await handler({ method: 'OPTIONS', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

describe('GET', () => {
  it('returns the all-time board shape by default', async () => {
    const res = makeRes();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ type: 'alltime', entries: [], context: null });
  });

  it('returns the daily board when type=daily', async () => {
    const res = makeRes();
    await handler({ method: 'GET', query: { type: 'daily' } }, res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { type: string }).type).toBe('daily');
  });

  it('returns a null context by default and when no name is asked for', async () => {
    const res = makeRes();
    await handler({ method: 'GET', query: {} }, res);
    expect((res.body as { context: unknown }).context).toBeNull();
  });

  it('places the named player in context when off the top slice (REQ-062)', async () => {
    // Post 25 honest games of varying scores so the board has a tail. Frame all
    // open of [n,0,0] gives a total of 10*n, so n in 1..25 gives 10..250.
    for (let n = 1; n <= 25; n += 1) {
      const frames = Array.from({ length: 10 }, () => [n > 9 ? 9 : n, 0, 0]);
      // Cap the per-ball to 9 so the line stays legal; n>9 reuses 9 but the name
      // disambiguates each player. Score is deterministic per name.
      await handler({ method: 'POST', query: {}, body: { name: `P${n}`, frames } }, makeRes());
    }
    // P1 scored the lowest (10), so it sits at the very bottom of the board.
    const res = makeRes();
    await handler({ method: 'GET', query: { limit: '5', name: 'P1' } }, res);
    const body = res.body as { entries: unknown[]; context: { rank: number; name: string; window: unknown[] } | null };
    // Top slice is capped at the requested limit.
    expect(body.entries.length).toBe(5);
    // P1 is on the board but well below the top 5, so it gets a context block.
    expect(body.context).not.toBeNull();
    expect(body.context?.name).toBe('P1');
    expect(body.context?.window.length).toBeGreaterThan(0);
  });
});

describe('rankContext (REQ-062 pure helper)', () => {
  const ranked = [
    { name: 'AAA', score: 100, date: '', source: 'solo' },
    { name: 'BBB', score: 90, date: '', source: 'solo' },
    { name: 'CCC', score: 80, date: '', source: 'solo' },
    { name: 'DDD', score: 70, date: '', source: 'solo' },
    { name: 'EEE', score: 60, date: '', source: 'solo' },
  ];

  it('returns the player rank and a window centered on them', () => {
    const ctx = rankContext(ranked, 'CCC', 1);
    expect(ctx?.rank).toBe(3);
    expect(ctx?.score).toBe(80);
    expect(ctx?.window.map((r) => r.name)).toEqual(['BBB', 'CCC', 'DDD']);
    expect(ctx?.window.map((r) => r.rank)).toEqual([2, 3, 4]);
    expect(ctx?.window.find((r) => r.isPlayer)?.name).toBe('CCC');
  });

  it('clamps the window at the board edges', () => {
    expect(rankContext(ranked, 'AAA', 2)?.window.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rankContext(ranked, 'EEE', 2)?.window.map((r) => r.rank)).toEqual([3, 4, 5]);
  });

  it('matches case-insensitively and returns null for an unknown name', () => {
    expect(rankContext(ranked, 'ccc', 0)?.rank).toBe(3);
    expect(rankContext(ranked, 'ZZZ', 1)).toBeNull();
    expect(rankContext(ranked, '   ', 1)).toBeNull();
  });
});

describe('POST', () => {
  it('recomputes the duckpin score, sanitizes the name, and reports rank', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'Ann!!', frames: COMPLETE_GAME } }, res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { success: boolean; name: string; score: number; rank: number };
    expect(body.success).toBe(true);
    expect(body.name).toBe('Ann');
    expect(body.score).toBe(60);
    expect(body.rank).toBe(1);
    // Written to both the all-time and a daily board, with a TTL set.
    expect(mockZadd).toHaveBeenCalledTimes(2);
    expect(mockExpire).toHaveBeenCalledTimes(1);
  });

  it('ignores a client-claimed score and uses the server computation', async () => {
    const res = makeRes();
    await handler(
      { method: 'POST', query: {}, body: { name: 'Cheater', score: 9999, frames: COMPLETE_GAME } },
      res,
    );
    expect((res.body as { score: number }).score).toBe(60);
  });

  it('rejects an impossible line', async () => {
    const res = makeRes();
    const bogus = Array.from({ length: 10 }, () => [9, 9, 9]);
    await handler({ method: 'POST', query: {}, body: { name: 'X', frames: bogus } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects an incomplete game', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'X', frames: [[3, 3, 0]] } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing frames payload', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'X' } }, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('unsupported methods', () => {
  it('returns 405 for anything else', async () => {
    const res = makeRes();
    await handler({ method: 'DELETE', query: {} }, res);
    expect(res.statusCode).toBe(405);
  });
});

describe('error handling', () => {
  it('returns 500 without leaking detail when the store throws', async () => {
    mockZrange.mockRejectedValueOnce(new Error('boom: token=secret-value'));
    const res = makeRes();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
