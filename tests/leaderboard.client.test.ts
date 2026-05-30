// Client-side leaderboard module tests (REQ-057). The fetch is fully mocked so
// these never touch the network (RULE 9). They cover the payload built from a
// completed game, the happy-path submit, and the non-fatal failure modes.

import { describe, it, expect, vi } from 'vitest';
import {
  Leaderboard,
  framesFromScore,
  renderBoardRows,
  renderContextRows,
  type BoardEntry,
  type FetchLike,
  type RankContext,
} from '../src/leaderboard.js';
import { scoreGame } from '../src/scoring.js';

// A complete ten-frame game: nine open frames of [3,3,3] (9 points each) plus a
// tenth open frame of [3,3,3]. scoreGame marks it complete with a final score.
const COMPLETE_FRAMES: number[][] = Array.from({ length: 10 }, () => [3, 3, 3]);
const completeScore = scoreGame(COMPLETE_FRAMES);

// An in-progress game: only one frame thrown, so it is not complete.
const partialScore = scoreGame([[3, 3, 3]]);

// Build a fake Response with the given status and JSON body.
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('framesFromScore (REQ-057)', () => {
  it('returns the per-frame ball tape for a completed game', () => {
    expect(completeScore.complete).toBe(true);
    expect(framesFromScore(completeScore)).toEqual(COMPLETE_FRAMES);
  });

  it('returns null for an incomplete game so a half-line cannot post', () => {
    expect(partialScore.complete).toBe(false);
    expect(framesFromScore(partialScore)).toBeNull();
  });

  it('copies the ball arrays rather than aliasing the score frames', () => {
    const tape = framesFromScore(completeScore);
    expect(tape).not.toBeNull();
    // Mutating the returned tape must not reach back into the score object.
    tape![0][0] = 99;
    expect(completeScore.frames[0].balls[0]).toBe(3);
  });
});

describe('Leaderboard.submitGame (REQ-057)', () => {
  it('POSTs the per-frame line and returns the server result on success', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ success: true, name: 'ACE', score: 90, rank: 7 }),
    );
    const board = new Leaderboard(fetchMock);
    const result = await board.submitGame('ace', completeScore);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/leaderboard');
    expect(init?.method).toBe('POST');
    const sent = JSON.parse(String(init?.body));
    expect(sent).toEqual({ name: 'ace', frames: COMPLETE_FRAMES, source: 'solo' });

    expect(result).toEqual({ success: true, name: 'ACE', score: 90, rank: 7 });
    expect(board.lastResult).toEqual(result);
    expect(board.error).toBeNull();
    expect(board.loading).toBe(false);
  });

  it('sends the match source when asked', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ success: true, name: 'X', score: 90, rank: 1 }));
    await new Leaderboard(fetchMock).submitGame('x', completeScore, 'match');
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent.source).toBe('match');
  });

  it('refuses to submit an incomplete game without hitting the network', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}));
    const board = new Leaderboard(fetchMock);
    const result = await board.submitGame('ace', partialScore);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(board.error).toMatch(/completed game/i);
  });

  it('returns null and sets an error on a non-ok response', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ error: 'bad' }, false, 400));
    const board = new Leaderboard(fetchMock);
    const result = await board.submitGame('ace', completeScore);
    expect(result).toBeNull();
    expect(board.error).toBe('Could not submit score');
    expect(board.loading).toBe(false);
  });

  it('returns null and sets an error when fetch throws', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => {
      throw new Error('offline');
    });
    const board = new Leaderboard(fetchMock);
    const result = await board.submitGame('ace', completeScore);
    expect(result).toBeNull();
    expect(board.error).toBe('Could not submit score');
    expect(board.loading).toBe(false);
  });
});

const SAMPLE_ENTRIES: BoardEntry[] = [
  { name: 'ACE', score: 120, date: '2026-05-29T00:00:00.000Z', source: 'solo' },
  { name: 'BEE', score: 90, date: '2026-05-29T00:00:00.000Z', source: 'match' },
];

describe('Leaderboard.fetchBoard (REQ-060/061)', () => {
  it('requests the typed board with a limit and stores the entries', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ type: 'alltime', entries: SAMPLE_ENTRIES }));
    const board = new Leaderboard(fetchMock);
    const entries = await board.fetchBoard('alltime', 20);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/leaderboard?type=alltime&limit=20');
    expect(entries).toEqual(SAMPLE_ENTRIES);
    expect(board.allTimeEntries).toEqual(SAMPLE_ENTRIES);
    expect(board.boardError).toBeNull();
    expect(board.boardLoading).toBe(false);
  });

  it('stores daily entries on the daily slot, not the all-time slot', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ type: 'daily', entries: SAMPLE_ENTRIES }));
    const board = new Leaderboard(fetchMock);
    await board.fetchBoard('daily', 5);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/leaderboard?type=daily&limit=5');
    expect(board.dailyEntries).toEqual(SAMPLE_ENTRIES);
    expect(board.allTimeEntries).toEqual([]);
  });

  it('keeps prior entries and sets an error on a non-ok response', async () => {
    let ok = true;
    const fetchMock = vi.fn<FetchLike>(async () =>
      ok ? jsonResponse({ type: 'alltime', entries: SAMPLE_ENTRIES }) : jsonResponse({}, false, 500),
    );
    const board = new Leaderboard(fetchMock);
    await board.fetchBoard('alltime');
    ok = false;
    await board.fetchBoard('alltime');
    expect(board.allTimeEntries).toEqual(SAMPLE_ENTRIES);
    expect(board.boardError).toBe('Could not load leaderboard');
    expect(board.boardLoading).toBe(false);
  });

  it('sets an error and returns cached entries when fetch throws', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => {
      throw new Error('offline');
    });
    const board = new Leaderboard(fetchMock);
    const entries = await board.fetchBoard('daily');
    expect(entries).toEqual([]);
    expect(board.boardError).toBe('Could not load leaderboard');
  });

  it('fetchBoth loads both boards', async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) =>
      jsonResponse({ type: url.includes('daily') ? 'daily' : 'alltime', entries: SAMPLE_ENTRIES }),
    );
    const board = new Leaderboard(fetchMock);
    await board.fetchBoth(20);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(board.allTimeEntries).toEqual(SAMPLE_ENTRIES);
    expect(board.dailyEntries).toEqual(SAMPLE_ENTRIES);
  });
});

const SAMPLE_CONTEXT: RankContext = {
  name: 'ZED',
  rank: 23,
  score: 40,
  window: [
    { name: 'YOU1', score: 44, date: '', source: 'solo', rank: 21, isPlayer: false },
    { name: 'YOU2', score: 42, date: '', source: 'solo', rank: 22, isPlayer: false },
    { name: 'ZED', score: 40, date: '', source: 'solo', rank: 23, isPlayer: true },
    { name: 'YOU4', score: 38, date: '', source: 'solo', rank: 24, isPlayer: false },
  ],
};

describe('Leaderboard.fetchBoard rank-in-context (REQ-062)', () => {
  it('appends the name to the query and stores the context block', async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ type: 'alltime', entries: SAMPLE_ENTRIES, context: SAMPLE_CONTEXT }),
    );
    const board = new Leaderboard(fetchMock);
    await board.fetchBoard('alltime', 20, 'ZED');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/leaderboard?type=alltime&limit=20&name=ZED');
    expect(board.allTimeContext).toEqual(SAMPLE_CONTEXT);
  });

  it('omits the name param and clears context when no name is given', async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ type: 'daily', entries: SAMPLE_ENTRIES }));
    const board = new Leaderboard(fetchMock);
    await board.fetchBoard('daily', 5);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/leaderboard?type=daily&limit=5');
    expect(board.dailyContext).toBeNull();
  });

  it('fetchBoth forwards the name to both boards', async () => {
    const fetchMock = vi.fn<FetchLike>(async (url) =>
      jsonResponse({ type: url.includes('daily') ? 'daily' : 'alltime', entries: SAMPLE_ENTRIES, context: SAMPLE_CONTEXT }),
    );
    const board = new Leaderboard(fetchMock);
    await board.fetchBoth(20, 'ZED');
    expect(fetchMock.mock.calls.every((c) => String(c[0]).includes('name=ZED'))).toBe(true);
    expect(board.allTimeContext).toEqual(SAMPLE_CONTEXT);
    expect(board.dailyContext).toEqual(SAMPLE_CONTEXT);
  });
});

describe('renderContextRows (REQ-062, RULE 10 observable render)', () => {
  it('renders the nearby window with the player row marked when off the top slice', () => {
    const html = renderContextRows(SAMPLE_CONTEXT, 20);
    expect(html).toMatch(/your standing/i);
    expect((html.match(/vp-board-row/g) ?? []).length).toBe(4);
    expect(html).toContain('data-rank="23"');
    expect(html).toContain('data-you="true"');
    // Only the player's own row carries the marker.
    expect((html.match(/data-you="true"/g) ?? []).length).toBe(1);
  });

  it('renders nothing when the player already appears in the top slice', () => {
    const inSlice: RankContext = { ...SAMPLE_CONTEXT, rank: 5 };
    expect(renderContextRows(inSlice, 20)).toBe('');
  });

  it('renders nothing when there is no context', () => {
    expect(renderContextRows(null, 20)).toBe('');
  });

  it('escapes HTML in names', () => {
    const evil: RankContext = {
      name: '<b>',
      rank: 30,
      score: 10,
      window: [{ name: '<b>', score: 10, date: '', source: 'solo', rank: 30, isPlayer: true }],
    };
    const html = renderContextRows(evil, 20);
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('renderBoardRows (REQ-063, RULE 10 observable render)', () => {
  it('renders one ranked row per entry with name and score', () => {
    const html = renderBoardRows(SAMPLE_ENTRIES, { loading: false, error: null });
    expect((html.match(/vp-board-row/g) ?? []).length).toBe(2);
    expect(html).toContain('data-rank="1"');
    expect(html).toContain('#1');
    expect(html).toContain('ACE');
    expect(html).toContain('120');
    expect(html).toContain('data-rank="2"');
    expect(html).toContain('BEE');
  });

  it('shows a loading message when loading with no cached entries', () => {
    const html = renderBoardRows([], { loading: true, error: null });
    expect(html).toMatch(/loading/i);
    expect(html).not.toContain('vp-board-row');
  });

  it('shows an error message when errored with no cached entries', () => {
    const html = renderBoardRows([], { loading: false, error: 'Could not load leaderboard' });
    expect(html).toContain('data-state="error"');
    expect(html).toContain('Could not load leaderboard');
  });

  it('invites the first score when the board is empty', () => {
    const html = renderBoardRows([], { loading: false, error: null });
    expect(html).toMatch(/no scores yet/i);
  });

  it('still renders cached rows while a refresh is loading', () => {
    const html = renderBoardRows(SAMPLE_ENTRIES, { loading: true, error: null });
    expect((html.match(/vp-board-row/g) ?? []).length).toBe(2);
  });

  it('escapes HTML in player names so a name cannot inject markup', () => {
    const evil: BoardEntry[] = [{ name: '<img src=x>', score: 50, date: '', source: 'solo' }];
    const html = renderBoardRows(evil, { loading: false, error: null });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img');
  });
});
