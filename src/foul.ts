// Foul-line detection (GDD 02-core-loop, 06-reuse-and-tech#scene, REQ-032). A
// foul is an over-the-line release: the ball is on or behind the foul line plane
// (the approach side) while live, instead of clearing it cleanly down the lane.
//
// Coordinate system (see src/config.ts): the origin sits at the centre of the
// foul line, the lane runs into -z toward the pin deck, and the approach is on
// the +z side. A legal ball spawns just inside the line (z < 0) and rolls into
// -z. The ball has fouled if its down-lane position is at or in front of the
// foul line plane (z >= foulLineZ) at any moment while the throw is live: a ball
// released over the line, or one that bounces or backspins its way back across
// it onto the approach.
//
// Pure: no Three.js, no Rapier, no clock. The physics layer feeds it the ball's
// z once per fixed step from begin() until the shot resolves; the detector
// latches the first crossing. A fouled ball is dead and scores zero pinfall;
// the game loop reads fouled and records a zero ball (the standing rack is
// untouched), which the pure Game spine (src/game.ts) already handles as a
// normal zero-count ball. Kept separate from ShotWatcher (src/shot.ts) because
// the watcher decides WHEN a shot resolves, whereas this decides WHETHER that
// resolved shot counts at all.

export interface FoulConfig {
  // The foul-line plane in down-lane z. A live ball at or in front of this
  // (z >= foulLineZ, the approach side) has crossed the line and fouled. The
  // lane runs into -z, so a legal in-flight ball stays strictly below this.
  readonly foulLineZ: number;
}

// Latching foul detector for one throw. Call begin() when the ball is released,
// then step(z) once per fixed physics step with the ball's down-lane position
// while the shot is live. Once any step sees the ball on or in front of the
// foul line the detector latches fouled and stays fouled for the rest of the
// throw, even if the ball later rolls back down-lane.
export class FoulDetector {
  private active = false;
  private fouledFlag = false;

  constructor(private readonly cfg: FoulConfig) {}

  begin(): void {
    this.active = true;
    this.fouledFlag = false;
  }

  get fouled(): boolean {
    return this.fouledFlag;
  }

  // Advance one fixed step with the ball's current down-lane z. Returns true
  // only on the step the foul first latches; false otherwise (including before
  // begin() and after the foul has already latched).
  step(z: number): boolean {
    if (!this.active || this.fouledFlag) return false;
    if (isOverFoulLine(z, this.cfg)) {
      this.fouledFlag = true;
      return true;
    }
    return false;
  }
}

// Pure predicate: is a ball at down-lane position z over the foul line? True
// when z is at or in front of the foul-line plane (the approach side, +z),
// since a legal live ball rolls into -z away from the line. Exported so the
// release check and tests share one rule.
export function isOverFoulLine(z: number, cfg: FoulConfig): boolean {
  return z >= cfg.foulLineZ;
}
