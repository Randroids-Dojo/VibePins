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

import handler, { sanitizeName } from '../api/leaderboard.js';

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
    expect(res.body).toEqual({ type: 'alltime', entries: [] });
  });

  it('returns the daily board when type=daily', async () => {
    const res = makeRes();
    await handler({ method: 'GET', query: { type: 'daily' } }, res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { type: string }).type).toBe('daily');
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
