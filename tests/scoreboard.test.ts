import { describe, it, expect } from 'vitest';
import { scoreboardHtml, cellGlyphs, changedCellKeys } from '../src/scoreboard.js';
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
    // No cumulative digit is emitted: the first-frame cumulative flap is empty.
    const cumulativeCard = html.match(/data-cell="f0c"[\s\S]*?<\/span><\/span>/)?.[0] ?? '';
    expect(cumulativeCard).not.toMatch(/>\d/);
  });
});

describe('split-flap skin markup (REQ-042)', () => {
  it('wraps every glyph in a two-leaf split-flap card', () => {
    const html = scoreboardHtml(scoreGame([[7, 3]]));
    // Each cell is a .vp-flap card with a top and bottom leaf.
    expect(html).toContain('class="vp-flap vp-ball" data-cell="f0b0"');
    expect(html).toContain('vp-flap-leaf vp-flap-top');
    expect(html).toContain('vp-flap-leaf vp-flap-bottom');
  });

  it('gives every ball and cumulative slot a stable data-cell key', () => {
    const html = scoreboardHtml(scoreGame([[7, 3]]));
    expect(html).toContain('data-cell="f0b0"');
    expect(html).toContain('data-cell="f0b1"');
    expect(html).toContain('data-cell="f0b2"');
    expect(html).toContain('data-cell="f0c"');
    expect(html).toContain('data-cell="f9c"');
  });

  it('repeats the glyph on both leaves so each clips to its half', () => {
    const html = scoreboardHtml(scoreGame([[10]]));
    // The strike glyph appears on both the top and bottom leaf of its card.
    const card = html.match(/data-cell="f0b0"[\s\S]*?<\/span><\/span>/)?.[0] ?? '';
    expect((card.match(/>X</g) ?? []).length).toBe(2);
  });
});

describe('cellGlyphs: flat cell model (REQ-042 flip diff)', () => {
  it('emits three ball cells plus one cumulative cell per frame', () => {
    const cells = cellGlyphs(scoreGame([]));
    // 10 frames * (3 ball slots + 1 cumulative) = 40 cells for an empty board.
    expect(cells.length).toBe(40);
    expect(cells[0].key).toBe('f0b0');
    expect(cells[3].key).toBe('f0c');
  });

  it('carries the displayed glyph for a played frame', () => {
    const cells = cellGlyphs(scoreGame([[10]]));
    expect(cells.find((c) => c.key === 'f0b0')?.glyph).toBe('X');
    expect(cells.find((c) => c.key === 'f0c')?.glyph).toBe(''); // bonus pending
  });
});

describe('changedCellKeys: flip targeting (REQ-042)', () => {
  it('flips only the cells whose glyph changed between two boards', () => {
    const before = cellGlyphs(scoreGame([[7]]));
    const after = cellGlyphs(scoreGame([[7, 2, 0]])); // open 9
    const changed = changedCellKeys(before, after);
    // The second and third balls and the now-resolved cumulative changed; the
    // first ball did not.
    expect(changed).toContain('f0b1');
    expect(changed).toContain('f0c');
    expect(changed).not.toContain('f0b0');
  });

  it('reports nothing changed for identical boards', () => {
    const a = cellGlyphs(scoreGame([[7, 3]]));
    const b = cellGlyphs(scoreGame([[7, 3]]));
    expect(changedCellKeys(a, b)).toEqual([]);
  });

  it('treats a new ball slot in the tenth frame as a changed cell', () => {
    const before = cellGlyphs(scoreGame([[3, 4, 0]]));
    const after = cellGlyphs(scoreGame([[3, 4, 0], [5]]));
    const changed = changedCellKeys(before, after);
    expect(changed).toContain('f1b0');
  });
});
