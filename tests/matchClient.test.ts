// Client-side async-match module tests (REQ-053/055). The fetch is fully mocked so
// these never touch the network (RULE 9). They cover the create / join / resume
// flows, per-frame submission with the secret sent via the X-Match-Secret header,
// credential persistence through the Settings store, the turn-state helpers, and
// the non-fatal failure modes.

import { describe, it, expect, vi } from 'vitest';
import { MatchClient, renderStandingsRows, type FetchLike } from '../src/matchClient.js';
import { Settings, type StorageLike } from '../src/settings.js';
import type { PublicMatch } from '../src/match.js';

// An in-memory storage so the Settings store persists credentials within a test
// without touching the real localStorage.
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

// Build a fake Response with the given status and JSON body.
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

// A minimal two-seat public match in the given status / turn position.
function publicMatch(over: Partial<PublicMatch> = {}): PublicMatch {
  return {
    id: 'm1',
    status: 'open',
    seatCount: 2,
    seats: [
      { seat: 1, name: 'Ann', claimed: true, frames: [] },
      { seat: 2, name: '', claimed: false, frames: [] },
    ],
    currentSeat: 1,
    currentFrame: 1,
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    ...over,
  };
}

describe('MatchClient.createMatch (REQ-055)', () => {
  it('POSTs to the create endpoint and persists the returned seat credential', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ match: publicMatch(), seat: 1, secret: 'sek-1' }, true, 201),
    );
    const settings = new Settings(memoryStorage());
    const client = new MatchClient(settings, fetchMock);

    const result = await client.createMatch('Ann', 2);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/match');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Ann', seatCount: 2 });

    expect(result.ok).toBe(true);
    expect(result.mySeat).toBe(1);
    expect(client.match?.id).toBe('m1');
    // The secret is stored, never surfaced on the result or held match view.
    expect(settings.matchCredential('m1')).toEqual({ seat: 1, secret: 'sek-1', name: 'Ann' });
  });

  it('omits seatCount when not given', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ match: publicMatch(), seat: 1, secret: 's' }));
    const client = new MatchClient(new Settings(memoryStorage()), fetchMock);
    await client.createMatch('Ann');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ name: 'Ann' });
  });
});

describe('MatchClient.joinMatch (REQ-055)', () => {
  it('POSTs with the id in the query and persists the joining seat credential', async () => {
    const joined = publicMatch({
      status: 'active',
      seats: [
        { seat: 1, name: 'Ann', claimed: true, frames: [] },
        { seat: 2, name: 'Bo', claimed: true, frames: [] },
      ],
    });
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ match: joined, seat: 2, secret: 'sek-2' }));
    const settings = new Settings(memoryStorage());
    const client = new MatchClient(settings, fetchMock);

    const result = await client.joinMatch('m1', 'Bo');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/match?id=m1');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(result.ok).toBe(true);
    expect(result.mySeat).toBe(2);
    expect(settings.matchCredential('m1')).toEqual({ seat: 2, secret: 'sek-2', name: 'Bo' });
  });

  it('surfaces the server error message when a match is full', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ error: 'match is full' }, false, 409));
    const client = new MatchClient(new Settings(memoryStorage()), fetchMock);
    const result = await client.joinMatch('m1', 'Cy');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('match is full');
    expect(client.error).toBe('match is full');
  });
});

describe('MatchClient.resumeMatch (REQ-055)', () => {
  it('sends the stored secret via the X-Match-Secret header and records the owned seat', async () => {
    const settings = new Settings(memoryStorage());
    settings.setMatchCredential('m1', { seat: 1, secret: 'sek-1', name: 'Ann' });
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ match: publicMatch(), mySeat: 1 }));
    const client = new MatchClient(settings, fetchMock);

    const result = await client.resumeMatch('m1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/match?id=m1');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['X-Match-Secret']).toBe('sek-1');
    expect(result.mySeat).toBe(1);
    expect(client.mySeat).toBe(1);
  });

  it('sends no secret header for a fresh recipient with no stored credential', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ match: publicMatch(), mySeat: null }));
    const client = new MatchClient(new Settings(memoryStorage()), fetchMock);

    const result = await client.resumeMatch('m1');

    expect(fetchMock.mock.calls[0][1]?.headers).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.mySeat).toBeNull();
  });

  it('is non-fatal on a 404, leaving an error string', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ error: 'match not found' }, false, 404));
    const client = new MatchClient(new Settings(memoryStorage()), fetchMock);
    const result = await client.resumeMatch('nope');
    expect(result.ok).toBe(false);
    expect(client.error).toBe('Could not load match');
  });
});

describe('MatchClient.submitFrame (REQ-053)', () => {
  it('PATCHes the per-ball pin-fall with the secret header and replaces the held view', async () => {
    const settings = new Settings(memoryStorage());
    settings.setMatchCredential('m1', { seat: 1, secret: 'sek-1', name: 'Ann' });
    const advanced = publicMatch({
      status: 'active',
      currentSeat: 2,
      seats: [
        { seat: 1, name: 'Ann', claimed: true, frames: [[3, 4, 0]] },
        { seat: 2, name: 'Bo', claimed: true, frames: [] },
      ],
    });
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ match: advanced }));
    const client = new MatchClient(settings, fetchMock);

    const result = await client.submitFrame('m1', 1, [3, 4, 0]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/match?id=m1');
    expect(init?.method).toBe('PATCH');
    expect((init?.headers as Record<string, string>)['X-Match-Secret']).toBe('sek-1');
    // The client forwards only the pin-fall, never a claimed score.
    expect(JSON.parse(String(init?.body))).toEqual({ frame: 1, balls: [3, 4, 0] });

    expect(result.ok).toBe(true);
    expect(client.match?.currentSeat).toBe(2);
    expect(client.match?.seats[0].frames).toEqual([[3, 4, 0]]);
  });

  it('fails fast without a network call when no seat is claimed', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ match: publicMatch() }));
    const client = new MatchClient(new Settings(memoryStorage()), fetchMock);
    const result = await client.submitFrame('m1', 1, [3, 4, 0]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('No seat claimed in this match');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a not-your-turn rejection from the server', async () => {
    const settings = new Settings(memoryStorage());
    settings.setMatchCredential('m1', { seat: 1, secret: 'sek-1', name: 'Ann' });
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ error: 'not your turn' }, false, 403));
    const client = new MatchClient(settings, fetchMock);
    const result = await client.submitFrame('m1', 1, [3, 4, 0]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not your turn');
  });
});

describe('MatchClient turn-state helpers (REQ-051)', () => {
  it('reports my turn only when active and the on-clock seat is mine', async () => {
    const settings = new Settings(memoryStorage());
    settings.setMatchCredential('m1', { seat: 1, secret: 'sek-1', name: 'Ann' });
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ match: publicMatch({ status: 'active', currentSeat: 1 }), mySeat: 1 }),
    );
    const client = new MatchClient(settings, fetchMock);
    await client.resumeMatch('m1');
    expect(client.isMyTurn).toBe(true);
    expect(client.currentPlayerName).toBe('Ann');
  });

  it('reports waiting when the on-clock seat is another player', async () => {
    const settings = new Settings(memoryStorage());
    settings.setMatchCredential('m1', { seat: 1, secret: 'sek-1', name: 'Ann' });
    const active = publicMatch({
      status: 'active',
      currentSeat: 2,
      seats: [
        { seat: 1, name: 'Ann', claimed: true, frames: [] },
        { seat: 2, name: 'Bo', claimed: true, frames: [] },
      ],
    });
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ match: active, mySeat: 1 }));
    const client = new MatchClient(settings, fetchMock);
    await client.resumeMatch('m1');
    expect(client.isMyTurn).toBe(false);
    expect(client.currentPlayerName).toBe('Bo');
  });

  it('is never my turn before a match is loaded', () => {
    const client = new MatchClient(new Settings(memoryStorage()));
    expect(client.isMyTurn).toBe(false);
    expect(client.currentPlayerName).toBe('');
  });
});

describe('renderStandingsRows (REQ-056)', () => {
  // A full ten-frame flat-open line: nine frames of [first, second, 0] plus a
  // three-ball tenth, so scoreGame reports it complete.
  function line(first: number, second: number): number[][] {
    const frames: number[][] = [];
    for (let f = 0; f < 9; f += 1) frames.push([first, second, 0]);
    frames.push([first, second, 0]);
    return frames;
  }

  function completed(over: Partial<PublicMatch> = {}): PublicMatch {
    return publicMatch({
      status: 'complete',
      seats: [
        { seat: 1, name: 'Ann', claimed: true, frames: line(5, 4) },
        { seat: 2, name: 'Bo', claimed: true, frames: line(3, 4) },
      ],
      currentSeat: 1,
      currentFrame: 10,
      ...over,
    });
  }

  it('renders a ranked row per seat, highest authoritative score first', () => {
    const html = renderStandingsRows(completed(), null);
    const ranks = [...html.matchAll(/data-rank="(\d+)"/g)].map((m) => m[1]);
    expect(ranks).toEqual(['1', '2']);
    // Ann (5,4 = 90) outranks Bo (3,4 = 70); winner row is tagged.
    expect(html.indexOf('Ann')).toBeLessThan(html.indexOf('Bo'));
    expect(html).toContain('data-winner="true"');
    expect(html).toContain('>90<');
    expect(html).toContain('>70<');
  });

  it('marks this device own row', () => {
    const html = renderStandingsRows(completed(), 2);
    // The data-you row is the one carrying Bo (seat 2).
    const youRow = html.split('vp-board-row').find((chunk) => chunk.includes('data-you="true"'));
    expect(youRow).toContain('Bo');
  });

  it('escapes player names at the render boundary', () => {
    const html = renderStandingsRows(
      completed({
        seats: [
          { seat: 1, name: '<img>', claimed: true, frames: line(5, 4) },
          { seat: 2, name: 'Bo', claimed: true, frames: line(3, 4) },
        ],
      }),
      null,
    );
    expect(html).toContain('&lt;img&gt;');
    expect(html).not.toContain('<img>');
  });

  it('renders nothing without a match', () => {
    expect(renderStandingsRows(null, null)).toBe('');
  });
});
