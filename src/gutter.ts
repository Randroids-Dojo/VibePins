// Gutter detection (GDD REQ-031). A gutter ball is one that leaves the lane bed
// sideways and drops into the recessed channel running along each side of the
// bed (the channels built from gutterBoxes() in src/config.ts). Once a ball is
// in the gutter it is contained and carried down toward the pit; it can no
// longer reach the pins, so it scores zero pinfall.
//
// Coordinate system (see src/config.ts): the bed is centred on x = 0 and runs
// from -LANE.width/2 to +LANE.width/2; +x is to the right. A ball whose centre
// crosses a bed edge (abs(x) >= bedEdgeX) is over the channel and falling in.
//
// Pure: no Three.js, no Rapier, no clock. The physics layer feeds it the ball's
// x once per fixed step from begin() until the shot resolves; the detector
// latches the first crossing. A guttered ball is dead and scores zero pinfall;
// the game loop reads guttered and records a zero ball (the standing rack is
// untouched), which the pure Game spine (src/game.ts) already handles as a
// normal zero-count ball. This mirrors FoulDetector (src/foul.ts): the foul
// detector decides whether an over-the-line release counts, this decides
// whether a ball that left the lane counts. Both are read when the shot
// resolves so a dead ball scores zero regardless of any pins it disturbed.

export interface GutterConfig {
  // The lane bed half-width in x. A live ball whose centre lateral distance from
  // the lane centreline reaches this (abs(x) >= bedEdgeX) has crossed the bed
  // edge into a gutter channel. A normal ball stays well inside this.
  readonly bedEdgeX: number;
}

// Latching gutter detector for one throw. Call begin() when the ball is
// released, then step(x) once per fixed physics step with the ball's lateral
// position while the shot is live. Once any step sees the ball at or past a bed
// edge the detector latches guttered and stays guttered for the rest of the
// throw, even if the ball later jitters back toward centre.
export class GutterDetector {
  private active = false;
  private gutteredFlag = false;

  constructor(private readonly cfg: GutterConfig) {}

  begin(): void {
    this.active = true;
    this.gutteredFlag = false;
  }

  get guttered(): boolean {
    return this.gutteredFlag;
  }

  // Advance one fixed step with the ball's current lateral x. Returns true only
  // on the step the gutter first latches; false otherwise (including before
  // begin() and after it has already latched).
  step(x: number): boolean {
    if (!this.active || this.gutteredFlag) return false;
    if (isInGutter(x, this.cfg)) {
      this.gutteredFlag = true;
      return true;
    }
    return false;
  }
}

// Pure predicate: is a ball at lateral position x off the lane bed into a
// gutter? True when the centre's distance from the centreline is at or past the
// bed edge (abs(x) >= bedEdgeX). Exported so the detector and tests share one
// rule.
export function isInGutter(x: number, cfg: GutterConfig): boolean {
  return Math.abs(x) >= cfg.bedEdgeX;
}
