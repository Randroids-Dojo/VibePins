// Post-throw shot watcher (GDD 02-core-loop, REQ-009). After the ball is
// released it rolls, hits the rack, and then either comes to rest on the bed,
// drops into a gutter or the back pit, or grinds on indefinitely. The game loop
// must wait for the shot to resolve before it counts pinfall and advances the
// frame. This is the gate that decides "the ball is done, count the pins now".
//
// Pure: no Three.js, no Rapier, no clock. The physics layer feeds it the ball's
// speed and depth (z) once per fixed step; the watcher decides when the shot has
// resolved. Kept separate from the pin SettleWindow because a shot resolves on
// the BALL going quiet or leaving the playfield, whereas the rack settle decides
// when the PINS are still enough to classify. The loop waits on both: the ball
// resolves the shot, then the rack settle classifies the pinfall.

export interface ShotConfig {
  // Ball speed at or below which the ball counts as at rest (m/s). Matches the
  // order of the pin at-rest threshold; a ball this slow is no longer acting on
  // the pins.
  readonly atRestSpeed: number;
  // Consecutive at-rest steps required before the shot resolves, so a ball that
  // momentarily slows at the top of a bounce is not called early.
  readonly atRestFrames: number;
  // Down-lane z past which the ball has cleared the pin deck into the pit; once
  // past this the shot is resolved immediately (it cannot return to the rack).
  readonly pitZ: number;
  // Hard cap on steps before the shot resolves regardless, so a ball wedged in a
  // gutter grinding forever never stalls the loop.
  readonly maxFrames: number;
}

// Frame-counted state machine. Call begin() when the ball is launched, then
// step() once per fixed physics step with the ball's current speed and z. step()
// returns true on the step the shot resolves; resolved stays true afterward.
export class ShotWatcher {
  private active = false;
  private resolvedFlag = false;
  private restRun = 0;
  private elapsed = 0;

  constructor(private readonly cfg: ShotConfig) {}

  begin(): void {
    this.active = true;
    this.resolvedFlag = false;
    this.restRun = 0;
    this.elapsed = 0;
  }

  get resolved(): boolean {
    return this.resolvedFlag;
  }

  get isWatching(): boolean {
    return this.active && !this.resolvedFlag;
  }

  // Advance one fixed step. `speed` is the ball's linear speed (m/s); `z` is its
  // down-lane position. Returns true only on the step the shot first resolves.
  step(speed: number, z: number): boolean {
    if (!this.active || this.resolvedFlag) return false;

    this.elapsed += 1;
    this.restRun = speed <= this.cfg.atRestSpeed ? this.restRun + 1 : 0;

    const clearedDeck = z <= this.cfg.pitZ;
    const atRest = this.restRun >= this.cfg.atRestFrames;
    const timedOut = this.elapsed >= this.cfg.maxFrames;

    if (clearedDeck || atRest || timedOut) {
      this.resolvedFlag = true;
      this.active = false;
      return true;
    }
    return false;
  }
}
