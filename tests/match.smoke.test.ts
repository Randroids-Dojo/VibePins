// Smoke test for the match function: a full create -> join -> resume round trip
// against the mocked store (RULE 9). Two players claim both seats, the match goes
// active, and each device resumes to its own seat.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@upstash/redis', () => ({
  Redis: class {
    async get(key: string) {
      return store.get(key) ?? null;
    }
    async set(key: string, value: string) {
      store.set(key, value);
      return 'OK';
    }
    async expire() {
      return 1;
    }
  },
}));

import handler from '../api/match.js';

function makeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader() {},
    end() {
      return this;
    },
  };
}

beforeEach(() => {
  process.env.KV_REST_API_URL = 'https://example.upstash.io';
  process.env.KV_REST_API_TOKEN = 'test-token';
  store.clear();
});

describe('match smoke: create, join, resume', () => {
  it('runs both seats through to an active, resumable match', async () => {
    // Player one creates the match and gets seat 1.
    const createRes = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'Ann', seatCount: 2 } }, createRes);
    const created = createRes.body as { match: { id: string; status: string }; seat: number; secret: string };
    expect(createRes.statusCode).toBe(201);
    expect(created.seat).toBe(1);
    expect(created.match.status).toBe('open');
    const matchId = created.match.id;

    // Player two opens the link and claims seat 2; the match becomes active.
    const joinRes = makeRes();
    await handler({ method: 'POST', query: { id: matchId }, body: { name: 'Bob' } }, joinRes);
    const joined = joinRes.body as { match: { status: string }; seat: number; secret: string };
    expect(joinRes.statusCode).toBe(200);
    expect(joined.seat).toBe(2);
    expect(joined.match.status).toBe('active');

    // Each device resumes to its own seat.
    const resumeAnn = makeRes();
    await handler({ method: 'GET', query: { id: matchId, secret: created.secret } }, resumeAnn);
    expect((resumeAnn.body as { mySeat: number }).mySeat).toBe(1);

    const resumeBob = makeRes();
    await handler({ method: 'GET', query: { id: matchId, secret: joined.secret } }, resumeBob);
    expect((resumeBob.body as { mySeat: number }).mySeat).toBe(2);

    // The resumed view shows both claimed seats with their names.
    const view = (resumeBob.body as { match: { seats: { name: string; claimed: boolean }[] } }).match;
    expect(view.seats.map((s) => s.name)).toEqual(['Ann', 'Bob']);
    expect(view.seats.every((s) => s.claimed)).toBe(true);
  });
});
