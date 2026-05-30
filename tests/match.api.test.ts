// Route-handler tests for the match serverless function (RULE 9). The Redis client
// is fully mocked; these never touch a live store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// An in-memory stand-in for the string get/set/expire commands the handler uses.
const store = new Map<string, string>();
const mockGet = vi.fn(async (key: string) => store.get(key) ?? null);
const mockSet = vi.fn(async (key: string, value: string) => {
  store.set(key, value);
  return 'OK';
});
const mockExpire = vi.fn(async () => 1);

vi.mock('@upstash/redis', () => ({
  Redis: class {
    get = mockGet;
    set = mockSet;
    expire = mockExpire;
  },
}));

import handler from '../api/match.js';

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
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res;
}

interface CreateBody {
  match: { id: string; status: string; seatCount: number; seats: { claimed: boolean }[] };
  seat: number;
  secret: string;
}

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

describe('CORS preflight', () => {
  it('answers OPTIONS with 200 and CORS headers', async () => {
    const res = makeRes();
    await handler({ method: 'OPTIONS', query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

describe('POST create', () => {
  it('creates a two-seat match, claims seat 1, and returns the seat secret', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'Ann' } }, res);
    expect(res.statusCode).toBe(201);
    const body = res.body as CreateBody;
    expect(body.seat).toBe(1);
    expect(typeof body.secret).toBe('string');
    expect(body.secret.length).toBeGreaterThan(0);
    expect(body.match.status).toBe('open');
    expect(body.match.seatCount).toBe(2);
    expect(body.match.seats[0].claimed).toBe(true);
    expect(body.match.seats[1].claimed).toBe(false);
    // The secret is never echoed inside the public match view.
    expect(JSON.stringify(body.match)).not.toContain(body.secret);
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  it('honors a requested seat count clamped to range', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'Ann', seatCount: 4 } }, res);
    expect((res.body as CreateBody).match.seatCount).toBe(4);
  });
});

describe('POST join', () => {
  it('claims the next open seat with a fresh secret and activates a full match', async () => {
    const createRes = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'Ann' } }, createRes);
    const created = createRes.body as CreateBody;

    const joinRes = makeRes();
    await handler({ method: 'POST', query: { id: created.match.id }, body: { name: 'Bob' } }, joinRes);
    expect(joinRes.statusCode).toBe(200);
    const joined = joinRes.body as CreateBody;
    expect(joined.seat).toBe(2);
    expect(joined.secret).not.toBe(created.secret);
    expect(joined.match.status).toBe('active');
  });

  it('accepts the id from the request body too', async () => {
    const createRes = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'Ann' } }, createRes);
    const id = (createRes.body as CreateBody).match.id;

    const joinRes = makeRes();
    await handler({ method: 'POST', query: {}, body: { id, name: 'Bob' } }, joinRes);
    expect(joinRes.statusCode).toBe(200);
    expect((joinRes.body as CreateBody).seat).toBe(2);
  });

  it('404s joining an unknown match', async () => {
    const res = makeRes();
    await handler({ method: 'POST', query: { id: 'does-not-exist' }, body: { name: 'Bob' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('409s joining a full match', async () => {
    const createRes = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'Ann' } }, createRes);
    const id = (createRes.body as CreateBody).match.id;
    await handler({ method: 'POST', query: { id }, body: { name: 'Bob' } }, makeRes());
    const res = makeRes();
    await handler({ method: 'POST', query: { id }, body: { name: 'Cara' } }, res);
    expect(res.statusCode).toBe(409);
  });
});

describe('GET resume', () => {
  it('400s without an id', async () => {
    const res = makeRes();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown match', async () => {
    const res = makeRes();
    await handler({ method: 'GET', query: { id: 'nope' } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('returns the public match plus the seat that owns the secret', async () => {
    const createRes = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'Ann' } }, createRes);
    const created = createRes.body as CreateBody;

    const withSecret = makeRes();
    await handler({ method: 'GET', query: { id: created.match.id, secret: created.secret } }, withSecret);
    expect(withSecret.statusCode).toBe(200);
    expect((withSecret.body as { mySeat: number }).mySeat).toBe(1);

    // A fresh recipient (no secret yet) sees the public view but owns no seat.
    const noSecret = makeRes();
    await handler({ method: 'GET', query: { id: created.match.id } }, noSecret);
    expect((noSecret.body as { mySeat: number | null }).mySeat).toBeNull();
    expect((noSecret.body as { match: { id: string } }).match.id).toBe(created.match.id);
  });
});

describe('unsupported methods and errors', () => {
  it('returns 405 for anything else', async () => {
    const res = makeRes();
    await handler({ method: 'DELETE', query: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 500 without leaking detail when the store throws', async () => {
    mockSet.mockRejectedValueOnce(new Error('boom: token=secret-value'));
    const res = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'Ann' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
