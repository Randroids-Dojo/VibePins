// In-match frame accumulation (GDD 05-async-multiplayer, REQ-053). Pure, framework
// free helper that turns the live shot loop's per-ball pin-fall into the `balls`
// array a single match frame submits to the server (matchClient.submitFrame). The
// shot loop already computes each ball's pin-fall as standingBeforeBall minus the
// standing-now count, plus a zero for a dead ball (foul / gutter); this accumulator
// only collects those counts in throw order and reports when the frame's turn is
// over so the loop can submit and hand off.
//
// The turn-end rule mirrors the server's frameComplete (src/match.ts) and the solo
// Game spine (src/game.ts) so the client never submits an incomplete or over-long
// frame: a normal frame ends on a strike (ball one clears ten), a spare (first two
// balls clear ten), or three balls; the tenth frame always takes exactly three
// balls (strike grants two bonus balls, spare one, flat ten / open use all three).
//
// Kept separate from the DOM shell so the accumulation is unit-testable without a
// browser or the physics sim (RULE 9), the same way scoring.ts and game.ts are.

import { FRAME_COUNT } from './scoring.js';

const PINS = 10;

// Whether a frame's turn is over for the given zero-based frame index, from the
// balls bowled so far. Mirrors the server's frameComplete (src/match.ts): a normal
// frame ends on a strike, a spare, or three balls; the tenth always takes three.
export function matchFrameComplete(balls: readonly number[], frameIndex: number): boolean {
  const isTenth = frameIndex === FRAME_COUNT - 1;
  if (isTenth) return balls.length >= 3;
  if (balls.length >= 1 && balls[0] === PINS) return true; // strike: turn ends
  if (balls.length >= 2 && balls[0] + balls[1] === PINS) return true; // spare: turn ends
  return balls.length >= 3; // open or flat ten
}

// Accumulates one match frame's per-ball pin-fall in throw order. The shot loop
// records each settled ball (a dead ball is a zero), and `isComplete` tells the
// loop when the frame's turn is over so it can submit `balls` and hand off. The
// frame index is fixed for the life of the turn (the match's currentFrame - 1).
export class MatchFrameAccumulator {
  private readonly bowled: number[] = [];

  constructor(private readonly frameIndex: number) {}

  // Record one settled ball's pin-fall (already the standing-before minus standing
  // -now delta, or zero for a dead ball). Returns true once the frame's turn is
  // over. Recording past completion is a no-op so a late settle cannot over-fill.
  record(pinsDowned: number): boolean {
    if (this.isComplete) return true;
    this.bowled.push(Math.max(0, Math.round(pinsDowned)));
    return this.isComplete;
  }

  // The frame's pin-fall in throw order, the payload matchClient.submitFrame sends.
  get balls(): number[] {
    return [...this.bowled];
  }

  // True once no more balls are owed this frame (the turn is over).
  get isComplete(): boolean {
    return matchFrameComplete(this.bowled, this.frameIndex);
  }
}
