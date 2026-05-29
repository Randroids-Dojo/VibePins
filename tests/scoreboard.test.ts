import { describe, it, expect } from 'vitest';
import { scoreboardHtml } from '../src/scoreboard.js';
import { scoreGame } from '../src/scoring.js';

describe('scoreboardHtml: live board rendering (REQ-012)', () => {
  it('renders all ten frame boxes even for an empty game', () => {
    const html = scoreboardHtml(scoreGame([]));
    const frames = html.match(/vp-frame-num/g) ?? [];
    expect(frames.length).toBe(10);
    // The tenth box is numbered 10.
    expect(html).toContain('>10<');
  });

  it('shows X for a strike on ball one', () => {
    const html = scoreboardHtml(scoreGame([[10], [3, 2, 0]]));
    expect(html).toContain('>X<');
  });

  it('shows the first ball then / for a spare', () => {
    // A spare closes the frame in two balls (the Game spine never appends more).
    const html = scoreboardHtml(scoreGame([[7, 3]]));
    expect(html).toContain('>7<');
    expect(html).toContain('>/<');
  });

  it('shows F for a flat ten cleared only on the third ball (not a spare)', () => {
    const html = scoreboardHtml(scoreGame([[4, 3, 3]]));
    expect(html).toContain('>F<');
    expect(html).not.toContain('>/<');
  });

  it('renders a dash for a gutter ball and the running cumulative total', () => {
    const score = scoreGame([[0, 5, 4]]); // open 9, no bonus pending
    const html = scoreboardHtml(score);
    expect(html).toContain('>-<'); // the leading zero shows as a dash
    expect(html).toContain('>9<'); // cumulative total for the completed frame
  });

  it('leaves the cumulative blank while a strike bonus is still pending', () => {
    // A lone strike: its score depends on the next two balls, so cumulative is null.
    const html = scoreboardHtml(scoreGame([[10]]));
    expect(html).toContain('>X<');
    // No cumulative digit is emitted for the pending frame.
    expect(html).not.toMatch(/vp-cumulative">\d/);
  });
});
