// Scoreboard overlay (GDD 02-core-loop REQ-012; look-and-feel REQ-042). Renders
// the live game score over the 3D lane: all ten frames, the per-ball counts, the
// frame mark (strike X, spare /, flat ten F, open digits), and the running
// cumulative total. It is a thin DOM view over the pure GameScore from
// src/scoring.ts.
//
// Look and feel (REQ-042): the board is skinned as an electromechanical
// split-flap display. Each ball glyph and each running total renders on a
// split-flap card (a top and bottom leaf with a centre hinge gap), and when a
// cell's glyph changes between renders it flips into place. The flip is driven
// by adding a `vp-flip` class to just the changed cells; the class triggers a
// short CSS keyframe in index.html, and it is honoured only when the user has
// not asked to reduce motion. The which-cells-changed decision is a pure diff
// (cellGlyphs + changedCellKeys) so it is unit tested without a DOM.
//
// Marks render in the duckpin convention: a strike on ball one shows X in the
// first box, a spare shows the first ball then / in the second, a flat ten (all
// ten only on ball three) shows F in the third box, and an open frame shows the
// plain digits. The tenth frame can hold three scoring balls plus bonuses.

import type { GameScore, FrameScore } from './scoring.js';
import { FRAME_COUNT } from './scoring.js';

// How long the flip class stays on a cell before it is cleared, in ms. Kept a
// touch longer than the CSS keyframe so the animation always completes before
// the class is removed.
const FLIP_DURATION_MS = 420;

// One ball's display glyph in its frame. Strikes and spares get their marks;
// a gutter/zero shows as a dash, every other count as its digit.
function ballGlyph(balls: readonly number[], index: number, mark: FrameScore['mark']): string {
  const value = balls[index];
  if (value === undefined) return '';
  // Strike: ball one cleared all ten (only the first ball of a strike frame).
  if (index === 0 && value === 10) return 'X';
  // Spare: the ball that completes ten across the first two balls.
  if (index === 1 && mark === 'spare') return '/';
  // Flat ten: the third ball clears the last pins (candlepin-style, no bonus).
  if (index === 2 && mark === 'flat_ten') return 'F';
  return value === 0 ? '-' : String(value);
}

// One addressable cell on the board: a stable key plus the glyph it shows. The
// key encodes the frame and which slot (ball 0..2 or the cumulative total) so
// the same physical cell keeps its identity across renders and the flip diff
// can tell which leaves actually changed.
export interface BoardCell {
  readonly key: string;
  readonly glyph: string;
}

// Flatten a score into the ordered list of every cell on the board: three ball
// slots and one cumulative slot per frame, for all ten frames. Frames not yet
// played contribute empty glyphs so the whole board is always present. Pure (no
// DOM) so both the renderer and the flip diff share one source of truth.
export function cellGlyphs(score: GameScore): BoardCell[] {
  const cells: BoardCell[] = [];
  for (let f = 0; f < FRAME_COUNT; f += 1) {
    const frame = score.frames[f];
    const ballSlots = frame ? Math.max(3, frame.balls.length) : 3;
    for (let b = 0; b < ballSlots; b += 1) {
      cells.push({
        key: `f${f}b${b}`,
        glyph: frame ? ballGlyph(frame.balls, b, frame.mark) : '',
      });
    }
    cells.push({
      key: `f${f}c`,
      glyph: frame && frame.cumulative !== null ? String(frame.cumulative) : '',
    });
  }
  return cells;
}

// The keys of cells whose glyph differs between two boards. A cell appearing in
// only one board (a frame that gained a third ball, say) counts as changed.
// Pure, so the flip targeting is unit tested without a DOM. Used to flip only
// the leaves that actually moved, the way a real split-flap board does.
export function changedCellKeys(prev: BoardCell[], next: BoardCell[]): string[] {
  const prevByKey = new Map(prev.map((cell) => [cell.key, cell.glyph]));
  const changed: string[] = [];
  for (const cell of next) {
    if (prevByKey.get(cell.key) !== cell.glyph) changed.push(cell.key);
  }
  return changed;
}

// Markup for one split-flap card. The two leaves carry the glyph; the
// data-cell key lets the flip pass find and animate just this card.
function flapCard(key: string, glyph: string, extraClass: string): string {
  const cls = extraClass ? `vp-flap ${extraClass}` : 'vp-flap';
  return (
    `<span class="${cls}" data-cell="${key}">` +
    `<span class="vp-flap-leaf vp-flap-top">${glyph}</span>` +
    `<span class="vp-flap-leaf vp-flap-bottom">${glyph}</span>` +
    `</span>`
  );
}

// Render one frame's box: its number, up to three split-flap ball cards, and the
// running cumulative total card (blank while a bonus is still pending).
function renderFrame(score: GameScore, frameIndex: number): string {
  const frame = score.frames[frameIndex];
  const ballSlots = frame ? Math.max(3, frame.balls.length) : 3;
  const balls: string[] = [];
  for (let b = 0; b < ballSlots; b += 1) {
    const glyph = frame ? ballGlyph(frame.balls, b, frame.mark) : '';
    balls.push(flapCard(`f${frameIndex}b${b}`, glyph, 'vp-ball'));
  }
  const cumulative = frame && frame.cumulative !== null ? String(frame.cumulative) : '';
  return [
    `<div class="vp-frame">`,
    `<div class="vp-frame-num">${frameIndex + 1}</div>`,
    `<div class="vp-balls">${balls.join('')}</div>`,
    `<div class="vp-cumulative">${flapCard(`f${frameIndex}c`, cumulative, '')}</div>`,
    `</div>`,
  ].join('');
}

// Build the full ten-frame board HTML for the given score. Frames not yet
// played render as empty split-flap cards so the whole board is always visible
// (REQ-012). Pure (no DOM) so the glyph/mark rendering is unit testable.
export function scoreboardHtml(score: GameScore): string {
  const html: string[] = [];
  for (let i = 0; i < FRAME_COUNT; i += 1) {
    html.push(renderFrame(score, i));
  }
  return html.join('');
}

export class Scoreboard {
  // The glyphs from the last paint, so the next paint can flip only the cells
  // that actually changed. Empty before the first render.
  private lastCells: BoardCell[] = [];
  private readonly reduceMotion: boolean;

  constructor(private readonly root: HTMLElement) {
    // Honour the OS reduce-motion preference: when set, the board still updates,
    // it just snaps instead of flipping (RULE 10). matchMedia is missing in some
    // headless contexts, so fall back to motion on.
    this.reduceMotion =
      typeof root.ownerDocument?.defaultView?.matchMedia === 'function' &&
      root.ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Paint the current score into the overlay, flipping the cells whose glyph
  // changed since the previous paint.
  render(score: GameScore): void {
    const nextCells = cellGlyphs(score);
    const changed = this.lastCells.length === 0 ? [] : changedCellKeys(this.lastCells, nextCells);
    this.root.innerHTML = scoreboardHtml(score);
    this.lastCells = nextCells;
    if (this.reduceMotion || changed.length === 0) return;
    this.flip(changed);
  }

  // Add the flip class to the changed cells and strip it once the animation has
  // run, so the next change can re-trigger it.
  private flip(keys: string[]): void {
    const view = this.root.ownerDocument?.defaultView;
    for (const key of keys) {
      const card = this.root.querySelector(`[data-cell="${key}"]`);
      if (!card) continue;
      card.classList.add('vp-flip');
      view?.setTimeout(() => card.classList.remove('vp-flip'), FLIP_DURATION_MS);
    }
  }
}
