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

import { escapeHtml } from './html.js';
import { scoreGame, type GameFrames, type GameScore } from './scoring.js';

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

// Which board a fetch reads (GDD 07-leaderboard "Boards", REQ-060/061).
export type BoardType = 'alltime' | 'daily';

// One standings row as the GET endpoint returns it (api/leaderboard.ts parseEntries).
// `source` is 'solo' or 'match'; the board UI does not key off it yet.
export interface BoardEntry {
  name: string;
  score: number;
  date: string;
  source: string;
}

// One row in the player's rank-in-context window (REQ-062): a board entry plus
// its 1-based rank and whether it is the player's own row. Mirrors the server's
// RankContextRow shape (api/leaderboard.ts).
export interface ContextRow extends BoardEntry {
  rank: number;
  isPlayer: boolean;
}

// The player's own standing plus the entries around it, so a player off the top
// slice still sees where they sit. Null when the player has no entry on the board
// or when no name was supplied to the fetch.
export interface RankContext {
  name: string;
  rank: number;
  score: number;
  window: ContextRow[];
}

// The GET response shape: the board it served plus its ranked entries (highest
// score first, as the server returns them) and, when a name was sent, that
// player's rank-in-context block (REQ-062).
interface BoardResponse {
  type: BoardType;
  entries: BoardEntry[];
  context?: RankContext | null;
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

// Build the standings board's inner HTML from a set of entries and a board
// state. Pure (string in, string out) so the shell can drop it into the board
// list element and so a test can assert the rendered rows without a DOM (RULE
// 10 observable render). Loading and error states render a single message row;
// an empty board reads as an invitation rather than a blank plate. Names are
// HTML-escaped because they come from other players.
export function renderBoardRows(entries: BoardEntry[], state: { loading: boolean; error: string | null }): string {
  if (state.loading && entries.length === 0) {
    return '<div class="vp-board-message">Loading standings...</div>';
  }
  if (state.error && entries.length === 0) {
    return `<div class="vp-board-message" data-state="error">${escapeHtml(state.error)}</div>`;
  }
  if (entries.length === 0) {
    return '<div class="vp-board-message">No scores yet. Be the first.</div>';
  }
  return entries
    .map(
      (entry, i) =>
        `<div class="vp-board-row" data-rank="${i + 1}">` +
        `<span class="vp-board-rank">#${i + 1}</span>` +
        `<span class="vp-board-name">${escapeHtml(entry.name)}</span>` +
        `<span class="vp-board-score">${Number(entry.score) || 0}</span>` +
        '</div>',
    )
    .join('');
}

// Build the player's rank-in-context block (REQ-062): the nearby window of rows
// around the player's own best, with the player's row marked. Pure (context in,
// string out) so the shell can drop it below the standings list and a test can
// assert it without a DOM. Returns an empty string when there is no context
// (player not on the board) or when the player already appears in the visible top
// slice (`topCount` rows), so the section only surfaces when it adds information.
// Names are HTML-escaped because they come from other players.
export function renderContextRows(context: RankContext | null, topCount: number): string {
  if (!context) return '';
  // Already visible in the top slice; the dedicated section would be redundant.
  if (context.rank <= topCount) return '';
  return (
    '<div class="vp-board-context-label">Your standing</div>' +
    context.window
      .map(
        (row) =>
          `<div class="vp-board-row" data-rank="${row.rank}"${row.isPlayer ? ' data-you="true"' : ''}>` +
          `<span class="vp-board-rank">#${row.rank}</span>` +
          `<span class="vp-board-name">${escapeHtml(row.name)}</span>` +
          `<span class="vp-board-score">${Number(row.score) || 0}</span>` +
          '</div>',
      )
      .join('')
  );
}

export class Leaderboard {
  private readonly fetchImpl: FetchLike;

  // The last submit's outcome, exposed for the shell to render. Loading is true
  // while a submit is in flight; error holds a human-readable message on
  // failure; lastResult holds the server response on success.
  loading = false;
  error: string | null = null;
  lastResult: SubmitResult | null = null;

  // The fetched standings, kept per board so the all-time/daily toggle can flip
  // between them without a refetch (GDD 07 "Boards"). boardLoading is true while
  // a board fetch is in flight; boardError holds a human-readable message on a
  // failed load (non-fatal, the overlay just shows the message).
  allTimeEntries: BoardEntry[] = [];
  dailyEntries: BoardEntry[] = [];
  boardLoading = false;
  boardError: string | null = null;

  // The player's rank-in-context block per board (REQ-062), populated when a name
  // is passed to the fetch. Null when the player is not on that board.
  allTimeContext: RankContext | null = null;
  dailyContext: RankContext | null = null;

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
    return this.submitFrames(name, frames, source);
  }

  // Submit a completed line from its raw per-frame ball tape (REQ-058). This is
  // the path the match-complete flow uses: a finished seat's ten-frame line is a
  // number[][] already, not a GameScore, so it posts directly. The tape is
  // re-scored locally only to confirm completeness before the round trip (the
  // server re-scores authoritatively and is the sole ranking authority, REQ-059).
  // Resolves to the server result on success, or null on any failure, leaving
  // `error` set. Never throws.
  async submitFrames(
    name: string,
    frames: number[][],
    source: 'solo' | 'match' = 'solo',
  ): Promise<SubmitResult | null> {
    const scored = scoreGame(frames as GameFrames);
    if (!scored.complete) {
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

  // Read one board (all-time or daily) and store its entries. Like submitGame
  // this never throws: a failed load sets `boardError` and leaves the prior
  // entries in place, because a leaderboard hiccup must not break the overlay
  // (the shell renders the error string). `limit` caps how many rows to ask for.
  // When `name` is given, the server also returns that player's rank-in-context
  // block (REQ-062) which is stored alongside the entries for the matching board.
  async fetchBoard(type: BoardType, limit = 20, name?: string): Promise<BoardEntry[]> {
    this.boardLoading = true;
    this.boardError = null;
    try {
      const params = new URLSearchParams({ type, limit: String(limit) });
      if (name) params.set('name', name);
      const res = await this.fetchImpl(`${API_BASE}?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BoardResponse;
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const context = data.context ?? null;
      if (type === 'daily') {
        this.dailyEntries = entries;
        this.dailyContext = context;
      } else {
        this.allTimeEntries = entries;
        this.allTimeContext = context;
      }
      return entries;
    } catch (err) {
      this.boardError = 'Could not load leaderboard';
      console.warn('Leaderboard fetch error:', err);
      return type === 'daily' ? this.dailyEntries : this.allTimeEntries;
    } finally {
      this.boardLoading = false;
    }
  }

  // Refresh both boards so the overlay can flip between tabs without a per-tab
  // round trip. One shared loading flag covers the pair; if either fails its own
  // entries stay as-is and `boardError` is set.
  async fetchBoth(limit = 20, name?: string): Promise<void> {
    await Promise.all([this.fetchBoard('alltime', limit, name), this.fetchBoard('daily', limit, name)]);
  }
}
