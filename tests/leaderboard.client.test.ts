// Client-side leaderboard module tests (REQ-057). The fetch is fully mocked so
// these never touch the network (RULE 9). They cover the payload built from a
// completed game, the happy-path submit, and the non-fatal failure modes.

import { describe, it, expect, vi } from 'vitest';
import { Leaderboard, framesFromScore, type FetchLike } from '../src/leaderboard.js';
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
