// Async-match client (GDD 05-async-multiplayer, REQ-053/055). The browser half of
// the match backend: it drives the create / join / resume flows and submits each
// completed frame's pin-fall to the server, which re-scores with the shared
// duckpin engine and owns the authoritative line. The client never sends a claimed
// score, only the per-ball pin-fall the physics sim produced (REQ-053 authority).
//
// The contract with api/match.ts mirrors src/leaderboard.ts: a small class wraps
// every network call behind an injectable fetch port so the rest of the shell stays
// synchronous and tests drive it with a mocked fetch (RULE 9). Per-seat secrets ride
// the X-Match-Secret header so they stay out of URLs (browser history, proxy logs);
// the secret is persisted via the Settings store (REQ-052) so reopening a match on
// the same device resumes the same seat without re-claiming.
//
// Failures are non-fatal: every method resolves to a result object with an `ok`
// flag and an `error` string rather than throwing, so a network hiccup surfaces in
// the UI without crashing the game loop. This module holds no UI; rendering the
// your-turn / waiting states and the handoff link is a follow-on slice (REQ-050/051).

import { escapeHtml } from './html.js';
import { computeStandings, type PublicMatch, type Standing } from './match.js';
import type { MatchCredential, Settings } from './settings.js';

export type { PublicMatch, PublicSeat, Standing } from './match.js';
export { computeStandings } from './match.js';

const API_BASE = '/api/match';

// A minimal fetch port so tests can inject a stub without a real network. The
// browser's global fetch satisfies this shape (same port as src/leaderboard.ts).
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// The shape api/match.ts returns from create and join: the public match view, the
// seat this device claimed, and that seat's per-seat secret. The secret is stored
// locally and never re-sent in a URL.
interface ClaimResponse {
  match: PublicMatch;
  seat: number;
  secret: string;
}

// The shape api/match.ts returns from GET (resume / view): the public match plus
// the seat this device owns when a valid secret was sent, else null.
interface ResumeResponse {
  match: PublicMatch;
  mySeat: number | null;
}

// What every client method resolves to. `ok` gates the rest: on success `match`
// is the latest authoritative public view and `mySeat` is this device's seat (null
// when viewing without a claimed seat). On failure `error` is a human-readable
// message and `match` is null. Never throws.
export interface MatchResult {
  ok: boolean;
  error: string | null;
  match: PublicMatch | null;
  // This device's 1-based seat, or null when it owns no seat in the match.
  mySeat: number | null;
}

function failure(error: string): MatchResult {
  return { ok: false, error, match: null, mySeat: null };
}

// Build the final-standings plate's inner HTML for a finished match (REQ-056).
// Pure (match in, string out) so the shell can drop it into the standings list
// element and a test can assert the rendered rows without a DOM (RULE 10 observable
// render). Reuses the leaderboard board-row classes so the standings read in the
// same electromechanical scoreboard language. `mySeat` marks this device's own row.
// Names are HTML-escaped because they come from other players. The winner row (rank
// 1) is tagged so the shell can call it out.
export function renderStandingsRows(match: PublicMatch | null, mySeat: number | null): string {
  if (!match) return '';
  const standings: Standing[] = computeStandings(match);
  return standings
    .map((row) => {
      const you = mySeat != null && row.seat === mySeat;
      return (
        `<div class="vp-board-row" data-rank="${row.rank}"` +
        (row.rank === 1 ? ' data-winner="true"' : '') +
        (you ? ' data-you="true"' : '') +
        '>' +
        `<span class="vp-board-rank">#${row.rank}</span>` +
        `<span class="vp-board-name">${escapeHtml(row.name)}</span>` +
        `<span class="vp-board-score">${row.score}</span>` +
        '</div>'
      );
    })
    .join('');
}

export class MatchClient {
  private readonly fetchImpl: FetchLike;
  private readonly settings: Settings;

  // The latest authoritative match view, and this device's seat in it. Held so the
  // shell can render the scoreboard and turn state without re-deriving from the
  // last result; refreshed on every successful call.
  match: PublicMatch | null = null;
  mySeat: number | null = null;

  // True while any call is in flight, and the last error string, for the shell to
  // render a loading or error affordance.
  loading = false;
  error: string | null = null;

  constructor(settings: Settings, fetchImpl?: FetchLike) {
    this.settings = settings;
    // Bind to avoid `Illegal invocation` when the global fetch is detached.
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  // True when it is this device's turn to bowl: the match is active and the seat
  // this device owns is the one on the clock (GDD turn-handoff: exactly one player
  // is on the clock). False while waiting, or before a seat is claimed.
  get isMyTurn(): boolean {
    return (
      this.match != null &&
      this.match.status === 'active' &&
      this.mySeat != null &&
      this.match.currentSeat === this.mySeat
    );
  }

  // The name of the player currently on the clock, for the calm "waiting for
  // <name>" state (REQ-051). Empty when there is no active match.
  get currentPlayerName(): string {
    if (!this.match || this.match.status !== 'active') return '';
    const seat = this.match.seats.find((s) => s.seat === this.match!.currentSeat);
    return seat?.name ?? '';
  }

  // Create a new match. The creator claims seat 1; the server hands back its
  // per-seat secret, which is persisted so this device resumes seat 1 later. The
  // returned match id is what the handoff link carries (REQ-055 create).
  async createMatch(name: string, seatCount?: number): Promise<MatchResult> {
    const body: { name: string; seatCount?: number } = { name };
    if (seatCount !== undefined) body.seatCount = seatCount;
    return this.claim(API_BASE, body);
  }

  // Join an existing match by claiming its next open seat (REQ-055 join). The
  // server mints a fresh per-seat secret which is persisted under the match id.
  // A full or finished match resolves to a failure result.
  async joinMatch(matchId: string, name: string): Promise<MatchResult> {
    return this.claim(`${API_BASE}?id=${encodeURIComponent(matchId)}`, { name });
  }

  // Resume / view a match (REQ-055 resume). When this device has a stored
  // credential for the match its secret is sent (via header), so the server
  // resolves which seat it owns; otherwise it gets the public view with no seat
  // (a fresh recipient opening a handoff link before claiming).
  async resumeMatch(matchId: string): Promise<MatchResult> {
    const cred = this.settings.matchCredential(matchId);
    this.loading = true;
    this.error = null;
    try {
      const res = await this.fetchImpl(`${API_BASE}?id=${encodeURIComponent(matchId)}`, {
        method: 'GET',
        headers: cred ? { 'X-Match-Secret': cred.secret } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ResumeResponse;
      this.match = data.match;
      this.mySeat = data.mySeat;
      return { ok: true, error: null, match: data.match, mySeat: data.mySeat };
    } catch (err) {
      this.error = 'Could not load match';
      console.warn('Match resume error:', err);
      return failure(this.error);
    } finally {
      this.loading = false;
    }
  }

  // Submit one completed frame's pin-fall for this device's seat (REQ-053). The
  // server validates and re-scores; the client only forwards the per-ball counts.
  // `frame` is 1-based and must equal the match's currentFrame, and it must be this
  // device's turn, else the server rejects (the result carries the message). On
  // success the latest authoritative view replaces the held state. Sends nothing
  // and fails fast when this device holds no credential for the match.
  async submitFrame(matchId: string, frame: number, balls: number[]): Promise<MatchResult> {
    const cred = this.settings.matchCredential(matchId);
    if (!cred) {
      this.error = 'No seat claimed in this match';
      return failure(this.error);
    }
    this.loading = true;
    this.error = null;
    try {
      const res = await this.fetchImpl(`${API_BASE}?id=${encodeURIComponent(matchId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Match-Secret': cred.secret },
        body: JSON.stringify({ frame, balls }),
      });
      if (!res.ok) {
        // The server returns a structured error (not your turn, wrong frame, illegal
        // frame). Surface its message when present so the UI can explain the reject.
        const message = await this.errorMessage(res);
        this.error = message;
        return failure(message);
      }
      const data = (await res.json()) as { match: PublicMatch };
      this.match = data.match;
      this.mySeat = cred.seat;
      return { ok: true, error: null, match: data.match, mySeat: cred.seat };
    } catch (err) {
      this.error = 'Could not submit turn';
      console.warn('Match submit error:', err);
      return failure(this.error);
    } finally {
      this.loading = false;
    }
  }

  // Shared create/join POST: claims a seat, persists the returned credential, and
  // updates the held state. `url` selects create (no id) vs join (id in query).
  private async claim(url: string, body: { name: string; seatCount?: number }): Promise<MatchResult> {
    this.loading = true;
    this.error = null;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const message = await this.errorMessage(res);
        this.error = message;
        return failure(message);
      }
      const data = (await res.json()) as ClaimResponse;
      const cred: MatchCredential = { seat: data.seat, secret: data.secret, name: body.name };
      // Persist before returning so a reload mid-flow still resumes the seat.
      this.settings.setMatchCredential(data.match.id, cred);
      this.match = data.match;
      this.mySeat = data.seat;
      return { ok: true, error: null, match: data.match, mySeat: data.seat };
    } catch (err) {
      this.error = 'Could not reach the match server';
      console.warn('Match claim error:', err);
      return failure(this.error);
    } finally {
      this.loading = false;
    }
  }

  // Pull the server's error message off a non-ok response, falling back to a
  // generic line when the body is not the expected JSON shape.
  private async errorMessage(res: Response): Promise<string> {
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data.error === 'string' && data.error) return data.error;
    } catch {
      // Non-JSON body; fall through to the generic message.
    }
    return `Request failed (HTTP ${res.status})`;
  }
}
