// Leaderboard client (GDD 07-leaderboard, REQ-057). The browser half of the
// global board: it turns a completed game into the wire payload the serverless
// backend expects and POSTs it, then surfaces the server-assigned rank.
//
// The contract with api/leaderboard.ts is deliberately thin: the client never
// sends a claimed total. It sends the per-frame ball sequence (the same
// GameFrames tape src/scoring.ts consumes) plus a display name, and the server
// re-scores with the shared engine and rejects an impossible or incomplete line
// (REQ-059). So the only score that can rank is the one the server computed.
//
// Network code is isolated here behind a small class so the rest of the shell
// stays synchronous and so tests can drive it with a mocked fetch (RULE 9). A
// failed submit is non-fatal: it sets an error string and resolves to null
// rather than throwing, because a leaderboard hiccup must never break the
// end-of-game flow.

import type { GameScore } from './scoring.js';

const API_BASE = '/api/leaderboard';

// The POST payload. `frames` is the per-frame ball sequence in throw order, the
// exact shape scoreGame validates; `source` marks a solo game versus a match
// line (REQ-057 is solo, the match path lands with the multiplayer cluster).
export interface SubmitPayload {
  name: string;
  frames: number[][];
  source: 'solo' | 'match';
}

// What the backend returns on a successful submit: the sanitized name it stored,
// the score it computed (authoritative), and the 1-based all-time rank.
export interface SubmitResult {
  success: boolean;
  name: string;
  score: number;
  rank: number | null;
}

// Build the wire payload from a finished game's score. The score engine already
// exposes each frame's thrown balls in order, so the tape is just those arrays.
// Returns null when the game is not actually complete, so a caller cannot post a
// half-played line (the server would reject it anyway, but this avoids the round
// trip and keeps the UI honest).
export function framesFromScore(score: GameScore): number[][] | null {
  if (!score.complete || score.finalScore === null) return null;
  return score.frames.map((frame) => [...frame.balls]);
}

// A minimal fetch port so tests can inject a stub without a real network. The
// browser's global fetch satisfies this shape.
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class Leaderboard {
  private readonly fetchImpl: FetchLike;

  // The last submit's outcome, exposed for the shell to render. Loading is true
  // while a submit is in flight; error holds a human-readable message on
  // failure; lastResult holds the server response on success.
  loading = false;
  error: string | null = null;
  lastResult: SubmitResult | null = null;

  constructor(fetchImpl?: FetchLike) {
    // Bind to avoid `Illegal invocation` when the global fetch is detached.
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  // Submit a completed solo game under the given display name. Resolves to the
  // server result on success, or null on any failure (network, validation,
  // incomplete game), leaving `error` set. Never throws.
  async submitGame(name: string, score: GameScore, source: 'solo' | 'match' = 'solo'): Promise<SubmitResult | null> {
    const frames = framesFromScore(score);
    if (!frames) {
      this.error = 'Only a completed game can post a score';
      this.lastResult = null;
      return null;
    }

    const payload: SubmitPayload = { name, frames, source };
    this.loading = true;
    this.error = null;
    this.lastResult = null;
    try {
      const res = await this.fetchImpl(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SubmitResult;
      this.lastResult = data;
      return data;
    } catch (err) {
      this.error = 'Could not submit score';
      // Log for the dev console without leaking anything sensitive.
      console.warn('Leaderboard submit error:', err);
      return null;
    } finally {
      this.loading = false;
    }
  }
}
