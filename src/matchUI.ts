// Async-match UI presenter (GDD 05-async-multiplayer, REQ-050/051). Pure, DOM-free
// helpers that turn a held match view into the strings and the single view-mode the
// shell renders. Keeping this pure means the your-turn / waiting / lobby / complete
// states and the handoff link are unit-testable without a browser, the same way
// renderBoardRows / renderStandingsRows are (RULE 9, RULE 10 observable render).
//
// The shell (src/main.ts) owns the overlay, the clock, and the MatchClient calls; it
// reads `matchViewMode` to pick which block to show and drops the rendered strings in.
// This module never touches the network or localStorage.

import { escapeHtml } from './html.js';
import { renderStandingsRows } from './matchClient.js';
import type { PublicMatch } from './match.js';

export type { PublicMatch } from './match.js';

// The query-string key the handoff link carries the match id under. A recipient
// opening `?match=<id>` lands in the join/resume flow (REQ-050 link, REQ-055 join).
export const MATCH_PARAM = 'match';

// The one view the match overlay shows at any moment, derived purely from the held
// match and this device's seat (GDD turn-handoff: exactly one player is on the
// clock, the not-your-turn state is a calm waiting screen, the your-turn state is
// unmistakable). The shell maps each mode to a block in the overlay.
//   none      no match loaded yet (the create / join entry).
//   loading   a match call is in flight and nothing is held yet.
//   lobby     the match is still open: waiting for seats to be claimed before play.
//   yourTurn  the match is active and this device's seat is on the clock.
//   waiting   the match is active and another seat is on the clock.
//   complete  every line is finished; the final standings show (REQ-056).
export type MatchViewMode = 'none' | 'loading' | 'lobby' | 'yourTurn' | 'waiting' | 'complete';

// Decide which block the overlay shows. Pure: match + seat + loading flag in, mode
// out. `loading` only wins before any match is held, so an in-flight refresh of an
// already-loaded match does not flash the loading state back over the live view.
// A device that has not yet claimed a seat in an open match lands on the entry
// block ('none') so it sees the Join action, not the creator's lobby; only the
// seated devices (creator and joiners) see the lobby roster + handoff link.
export function matchViewMode(
  match: PublicMatch | null,
  mySeat: number | null,
  loading: boolean,
): MatchViewMode {
  if (!match) return loading ? 'loading' : 'none';
  if (match.status === 'complete') return 'complete';
  if (match.status === 'open') return mySeat != null ? 'lobby' : 'none';
  // active: exactly one seat is on the clock.
  return mySeat != null && match.currentSeat === mySeat ? 'yourTurn' : 'waiting';
}

// Build the handoff URL a bowler shares so the next player opens this match
// (REQ-050). The match id rides a query param (never the per-seat secret, which
// stays in the header / localStorage). `origin` is injected (window.location) so
// this stays pure and testable. Returns an absolute URL string.
export function handoffLink(origin: string, matchId: string): string {
  const base = origin.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return `${base}/?${MATCH_PARAM}=${encodeURIComponent(matchId)}`;
}

// Read the match id a recipient opened from the page URL (REQ-055 join via link).
// `search` is the raw location.search (injected for testability). Returns the id,
// or null when the param is absent or empty.
export function matchIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get(MATCH_PARAM);
  return id && id.trim() ? id.trim() : null;
}

// The calm waiting headline (REQ-051: "waiting for <name>", not a spinner). Falls
// back to a neutral line when the on-clock seat has no name yet. Name is escaped
// because it comes from another player.
export function waitingHeadline(match: PublicMatch | null): string {
  if (!match || match.status !== 'active') return 'Waiting...';
  const seat = match.seats.find((s) => s.seat === match.currentSeat);
  const name = seat?.name?.trim();
  return name ? `Waiting for ${escapeHtml(name)}` : 'Waiting for the next player';
}

// The lobby roster while a match is still open (REQ-051 groundwork): one row per
// seat showing the claimed name or an open slot, so the creator can see who has
// joined before play starts. Reuses the board-row language. Names are escaped.
export function renderLobbyRows(match: PublicMatch | null, mySeat: number | null): string {
  if (!match) return '';
  return match.seats
    .map((seat) => {
      const you = mySeat != null && seat.seat === mySeat;
      const label = seat.claimed ? escapeHtml(seat.name) : 'Open seat';
      return (
        `<div class="vp-board-row" data-rank="${seat.seat}"` +
        (you ? ' data-you="true"' : '') +
        (seat.claimed ? '' : ' data-open="true"') +
        '>' +
        `<span class="vp-board-rank">P${seat.seat}</span>` +
        `<span class="vp-board-name">${label}</span>` +
        `<span class="vp-board-score">${seat.claimed ? 'IN' : '...'}</span>` +
        '</div>'
      );
    })
    .join('');
}

// The live scoreboard the waiting state shows (REQ-051: the live scoreboard, not a
// spinner). Re-uses the final-standings rows: every seat's authoritative running
// total ranked, so a waiting player sees where everyone stands mid-match. This is
// the same renderer the complete state uses; the difference is only the headline.
export function renderMatchScoreboard(match: PublicMatch | null, mySeat: number | null): string {
  return renderStandingsRows(match, mySeat);
}
