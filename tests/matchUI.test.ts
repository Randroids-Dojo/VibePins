// Async-match UI presenter tests (REQ-050/051). Pure: no DOM, no network. They
// pin the view-mode derivation, the handoff link build / parse, the calm waiting
// headline, and the lobby / scoreboard row rendering (HTML-escaped, own-seat and
// open-seat marked) so the shell can trust these strings (RULE 10 observable).

import { describe, it, expect } from 'vitest';
import {
  matchViewMode,
  handoffLink,
  handoffShareData,
  matchIdFromSearch,
  waitingHeadline,
  renderLobbyRows,
  renderMatchScoreboard,
  MATCH_PARAM,
  type PublicMatch,
} from '../src/matchUI.js';

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

describe('matchViewMode (REQ-051)', () => {
  it('is none with no match, or loading when a call is in flight', () => {
    expect(matchViewMode(null, null, false)).toBe('none');
    expect(matchViewMode(null, null, true)).toBe('loading');
  });

  it('shows the lobby to a seated device while the match is open', () => {
    expect(matchViewMode(publicMatch(), 1, false)).toBe('lobby');
  });

  it('keeps an unseated device on the entry block for an open match (join path)', () => {
    expect(matchViewMode(publicMatch(), null, false)).toBe('none');
  });

  it('never flashes loading back over a match already held (in-flight refresh)', () => {
    // loading only wins before any match is held; once one is loaded an in-flight
    // refresh must keep showing the live view, not the loading block.
    expect(matchViewMode(publicMatch(), 1, true)).toBe('lobby');
    const active = publicMatch({ status: 'active', currentSeat: 1 });
    expect(matchViewMode(active, 1, true)).toBe('yourTurn');
    expect(matchViewMode(active, 2, true)).toBe('waiting');
    expect(matchViewMode(publicMatch({ status: 'complete' }), 1, true)).toBe('complete');
  });

  it('is your-turn when this seat is on the clock, waiting otherwise', () => {
    const active = publicMatch({ status: 'active', currentSeat: 1 });
    expect(matchViewMode(active, 1, false)).toBe('yourTurn');
    expect(matchViewMode(active, 2, false)).toBe('waiting');
    // A spectator (no seat) of an active match still sees the waiting scoreboard.
    expect(matchViewMode(active, null, false)).toBe('waiting');
  });

  it('shows complete once the match locks regardless of seat', () => {
    const done = publicMatch({ status: 'complete' });
    expect(matchViewMode(done, 1, false)).toBe('complete');
    expect(matchViewMode(done, null, false)).toBe('complete');
  });
});

describe('handoffLink and matchIdFromSearch (REQ-050/055)', () => {
  it('builds an absolute link carrying the match id on the query param', () => {
    expect(handoffLink('https://vibepins.app/', 'abc123')).toBe(
      `https://vibepins.app/?${MATCH_PARAM}=abc123`,
    );
  });

  it('strips any existing query / hash and trailing slashes from the origin', () => {
    expect(handoffLink('https://vibepins.app/?match=old#x', 'new')).toBe(
      `https://vibepins.app/?${MATCH_PARAM}=new`,
    );
    expect(handoffLink('https://vibepins.app///', 'id')).toBe(`https://vibepins.app/?${MATCH_PARAM}=id`);
  });

  it('encodes an id with reserved characters', () => {
    expect(handoffLink('https://x.app', 'a b/c')).toBe(`https://x.app/?${MATCH_PARAM}=a%20b%2Fc`);
  });

  it('round-trips the id back out of a search string', () => {
    expect(matchIdFromSearch(`?${MATCH_PARAM}=abc123`)).toBe('abc123');
    expect(matchIdFromSearch(`?${MATCH_PARAM}=a%20b`)).toBe('a b');
  });

  it('returns null when the param is absent or empty', () => {
    expect(matchIdFromSearch('')).toBeNull();
    expect(matchIdFromSearch('?other=1')).toBeNull();
    expect(matchIdFromSearch(`?${MATCH_PARAM}=`)).toBeNull();
    expect(matchIdFromSearch(`?${MATCH_PARAM}=%20%20`)).toBeNull();
  });
});

describe('handoffShareData (REQ-050, F-009)', () => {
  it('builds a navigator.share-shaped payload carrying the link as the url', () => {
    const link = `https://vibepins.app/?${MATCH_PARAM}=abc123`;
    const data = handoffShareData(link);
    expect(data.url).toBe(link);
    expect(typeof data.title).toBe('string');
    expect(data.title.length).toBeGreaterThan(0);
    expect(typeof data.text).toBe('string');
    expect(data.text.length).toBeGreaterThan(0);
  });

  it('never leaks a secret: only the passed link appears in the url field', () => {
    const link = `https://vibepins.app/?${MATCH_PARAM}=onlyid`;
    expect(handoffShareData(link).url).toBe(link);
  });
});

describe('waitingHeadline (REQ-051)', () => {
  it('names the player on the clock', () => {
    const active = publicMatch({ status: 'active', currentSeat: 2, seats: [
      { seat: 1, name: 'Ann', claimed: true, frames: [] },
      { seat: 2, name: 'Bob', claimed: true, frames: [] },
    ] });
    expect(waitingHeadline(active)).toBe('Waiting for Bob');
  });

  it('escapes a name with HTML so it cannot inject markup', () => {
    const active = publicMatch({ status: 'active', currentSeat: 1, seats: [
      { seat: 1, name: '<b>x', claimed: true, frames: [] },
      { seat: 2, name: 'Bob', claimed: true, frames: [] },
    ] });
    expect(waitingHeadline(active)).toBe('Waiting for &lt;b&gt;x');
  });

  it('falls back to a neutral line off an active match', () => {
    expect(waitingHeadline(null)).toBe('Waiting...');
    expect(waitingHeadline(publicMatch({ status: 'open' }))).toBe('Waiting...');
  });
});

describe('renderLobbyRows (REQ-051)', () => {
  it('renders one row per seat, marking open seats and this device', () => {
    const html = renderLobbyRows(publicMatch(), 1);
    expect(html).toContain('data-rank="1"');
    expect(html).toContain('data-you="true"');
    expect(html).toContain('Ann');
    expect(html).toContain('data-open="true"');
    expect(html).toContain('Open seat');
  });

  it('escapes a claimed name', () => {
    const m = publicMatch({ seats: [
      { seat: 1, name: '<i>z', claimed: true, frames: [] },
      { seat: 2, name: '', claimed: false, frames: [] },
    ] });
    expect(renderLobbyRows(m, 1)).toContain('&lt;i&gt;z');
  });

  it('is empty for a null match', () => {
    expect(renderLobbyRows(null, null)).toBe('');
  });
});

describe('renderMatchScoreboard (REQ-051)', () => {
  it('renders the ranked standings rows for the live / final board', () => {
    const m = publicMatch({ status: 'active', seats: [
      { seat: 1, name: 'Ann', claimed: true, frames: [[10], [3, 4]] },
      { seat: 2, name: 'Bob', claimed: true, frames: [[1, 2]] },
    ] });
    const html = renderMatchScoreboard(m, 2);
    expect(html).toContain('Ann');
    expect(html).toContain('Bob');
    expect(html).toContain('data-rank="1"');
    // This device's row is marked.
    expect(html).toContain('data-you="true"');
  });
});
