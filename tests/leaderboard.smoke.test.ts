// Smoke test for the leaderboard function: a fresh board accepts a completed
// solo game and then serves it back at the top of the all-time list, exercising
// the POST -> GET round trip against the mocked store (RULE 9).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, { score: number; member: string }[]>();
vi.mock('@upstash/redis', () => ({
  Redis: class {
    async zadd(key: string, entry: { score: number; member: string }) {
      const list = store.get(key) ?? [];
      list.push(entry);
      store.set(key, list);
      return 1;
    }
    async zrange(key: string, start: number, stop: number, opts: { rev?: boolean }) {
      const list = [...(store.get(key) ?? [])].sort((a, b) => a.score - b.score);
      if (opts?.rev) list.reverse();
      const out: (string | number)[] = [];
      for (const e of list.slice(start, stop + 1)) {
        out.push(e.member, e.score);
      }
      return out;
    }
    async expire() {
      return 1;
    }
    async zcard(key: string) {
      return (store.get(key) ?? []).length;
    }
    async zremrangebyrank() {
      return 0;
    }
    async zrevrank() {
      return 0;
    }
  },
}));

import handler from '../api/leaderboard.js';

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

describe('leaderboard smoke: submit then read back', () => {
  it('posts a completed game and serves it at the top of the all-time board', async () => {
    const frames = Array.from({ length: 10 }, () => [4, 5, 0]); // 90 total.

    const postRes = makeRes();
    await handler({ method: 'POST', query: {}, body: { name: 'Pinny', frames } }, postRes);
    expect(postRes.statusCode).toBe(200);
    expect((postRes.body as { score: number }).score).toBe(90);

    const getRes = makeRes();
    await handler({ method: 'GET', query: { limit: '5' } }, getRes);
    expect(getRes.statusCode).toBe(200);
    const entries = (getRes.body as { entries: { name: string; score: number }[] }).entries;
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ name: 'Pinny', score: 90 });
  });
});
