// Scoreboard overlay (GDD 02-core-loop, REQ-012). Renders the live game score
// over the 3D lane: all ten frames, the per-ball counts, the frame mark (strike
// X, spare /, flat ten F, open digits), and the running cumulative total. It is
// a thin DOM view over the pure GameScore from src/scoring.ts; the
// electromechanical split-flap styling (REQ-042) is a later look-and-feel slice.
//
// Marks render in the duckpin convention: a strike on ball one shows X in the
// first box, a spare shows the first ball then / in the second, a flat ten (all
// ten only on ball three) shows F in the third box, and an open frame shows the
// plain digits. The tenth frame can hold three scoring balls plus bonuses.

import type { GameScore, FrameScore } from './scoring.js';
import { FRAME_COUNT } from './scoring.js';

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

// Render one frame's box: its number, up to three ball glyphs, and the running
// cumulative total (blank while a bonus is still pending).
function renderFrame(frame: FrameScore): string {
  const ballCount = Math.max(3, frame.balls.length);
  const glyphs: string[] = [];
  for (let i = 0; i < ballCount; i += 1) {
    glyphs.push(`<span class="vp-ball">${ballGlyph(frame.balls, i, frame.mark)}</span>`);
  }
  const cumulative = frame.cumulative === null ? '' : String(frame.cumulative);
  return [
    `<div class="vp-frame">`,
    `<div class="vp-frame-num">${frame.frameIndex + 1}</div>`,
    `<div class="vp-balls">${glyphs.join('')}</div>`,
    `<div class="vp-cumulative">${cumulative}</div>`,
    `</div>`,
  ].join('');
}

// Build the full ten-frame board HTML for the given score. Frames not yet
// played render as empty boxes so the whole board is always visible (REQ-012).
// Pure (no DOM) so the glyph/mark rendering is unit testable.
export function scoreboardHtml(score: GameScore): string {
  const html: string[] = [];
  for (let i = 0; i < FRAME_COUNT; i += 1) {
    const frame = score.frames[i];
    if (frame) {
      html.push(renderFrame(frame));
    } else {
      html.push(
        `<div class="vp-frame"><div class="vp-frame-num">${i + 1}</div>` +
          `<div class="vp-balls"><span class="vp-ball"></span><span class="vp-ball"></span><span class="vp-ball"></span></div>` +
          `<div class="vp-cumulative"></div></div>`,
      );
    }
  }
  return html.join('');
}

export class Scoreboard {
  constructor(private readonly root: HTMLElement) {}

  // Paint the current score into the overlay.
  render(score: GameScore): void {
    this.root.innerHTML = scoreboardHtml(score);
  }
}
