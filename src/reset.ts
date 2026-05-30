// String pinsetter reset cycle (GDD 03-string-pinsetter, REQ-018 to REQ-021).
//
// Two reset shapes, both sweepless (REQ-020), both carrying pins kinematically by
// their cords with the rendered cords following the carried necks so the motion
// reads as strings, not a sweep:
//
//   between-balls (REQ-009): when one or more pins were knocked down, the WHOLE
//   rack reels up (the recall-all motion a real string machine makes). ALL ten
//   pins are lifted clear of the deck. Then the STANDING pins are carried back
//   over their HOME spots and lowered onto them, re-spotting them precisely (a
//   pin nudged off its spot but still standing returns to its home spot, REQ-021).
//   The KNOCKED-DOWN pins stay reeled up and aloft, cleared out of play, never
//   lowered, so only the standing pins remain on the deck for the next ball.
//
//   rerack (REQ-010): at frame end all ten pins are reeled. Each is righted,
//   raised, carried over its home spot, and lowered onto it, then handed back to
//   the dynamics at rest. This is the only motion that sets every pin back down
//   on the deck, so the deck reads as a clean fresh rack of ten.
//
// Both shapes run the full lift, reposition, and lower cycle. The difference is
// which carried pins follow the reposition/lower path home (the standing ones,
// plus all ten on a rerack) and which hold aloft at the top of the lift (the
// fallen ones on a between-balls cycle). The caller hands the pins that landed
// home back to the dynamics; the held-aloft fallen pins stay kinematic and aloft
// until the next rerack.
//
// This controller is pure: no Three.js, no Rapier. It is a frame-counted state
// machine returning, per fixed step, the carried pin world targets. The physics
// adapter (PinSet) makes the targeted pins kinematic, applies the targets, and
// returns the landed pins to dynamic when the cycle completes.

import type { Vec3 } from './config.js';

export type ResetMode = 'between-balls' | 'rerack';
// The reset phases, in run order. The recovery phases (release, verify-clear,
// re-lift) sit between lift and reposition (REQ-024 drop-and-unwind):
//   release      pays out slack: the held pins are lowered from liftPinY to
//                releaseY (a visible drop) so they hang just above the deck.
//   verify-clear lets the lowered rack loose on its cords for a settle window so
//                gravity swings and unwinds it; the adapter then reads the live
//                sim and reports whether it landed clear or piled up tangled.
//   re-lift      reels the dropped pins back up to liftPinY (to re-check after a
//                tangle, or to set the rack after a clear verdict).
export type ResetPhase =
  | 'idle'
  | 'settle-hold'
  | 'lift'
  | 'verify-clear'
  | 'release'
  | 're-lift'
  | 'reposition'
  | 'lower';

export interface ResetTarget {
  readonly pinIndex: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ResetConfig {
  readonly settleHoldFrames: number;
  readonly liftFrames: number;
  readonly repositionFrames: number;
  readonly lowerFrames: number;
  readonly liftPinY: number; // pin centre height while carried clear of the deck
  readonly restY: number; //    pin centre height resting on the deck (floorY + pinHeight/2)
  // Tangle drop-and-unwind recovery (REQ-024). Optional so existing callers that
  // pass only the four phase durations keep the old no-recovery cycle.
  readonly verifyFrames?: number; //  frames the rack hangs loose for the tangle read
  readonly releaseY?: number; //      pin centre height the held pins drop to on a release
  readonly releaseFrames?: number; // frames held at releaseY so gravity untangles
  readonly reLiftFrames?: number; //  frames to reel the dropped pins back to liftPinY
  readonly maxRetries?: number; //    drop-and-unwind attempts before a force-clear
}

const FIXED_STEP = 1 / 60;

const smoothstep = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
};

const lerp = (a: number, b: number, t: number): number => {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return a + (b - a) * t;
};

// The carried pin centre target for a target pin at a given phase and 0..1
// progress. `home` is the pin's home spot, `settled` where it came to rest.
//   settle-hold: stand the pin upright at its settled x,z (on the deck)
//   lift:        raise it straight up off the deck
//   reposition:  carry it across to over its home spot, staying raised
//   lower:       set it down onto the home spot
//
// `holdAloft` is the knocked-down case on a between-balls cycle: the pin lifts
// with the rest of the rack, then stays reeled up and aloft over its settled
// spot through reposition and lower, cleared out of play rather than set back
// down (REQ-009). A standing pin (or any pin on a rerack) instead follows the
// full path home.
export function pinTargetFor(
  phase: ResetPhase,
  progress: number,
  home: Vec3,
  settled: Vec3,
  cfg: ResetConfig,
  holdAloft = false,
): Vec3 {
  const s = smoothstep(progress);
  const releaseY = cfg.releaseY ?? cfg.liftPinY;
  switch (phase) {
    case 'lift':
      return { x: settled.x, y: lerp(cfg.restY, cfg.liftPinY, s), z: settled.z };
    case 'release':
      // Pay out slack: lower the held pin from the aloft clearance down to
      // releaseY (just above the deck), a visible drop, over its settled x,z.
      return { x: settled.x, y: lerp(cfg.liftPinY, releaseY, s), z: settled.z };
    case 'verify-clear':
      // The pin is let loose on its cord here (dynamic in the adapter), so this
      // target is only a fallback; it holds at the dropped height.
      return { x: settled.x, y: releaseY, z: settled.z };
    case 're-lift':
      // Reel the dropped pin (now near the deck after its swing) back up to the
      // aloft clearance, from wherever the release left it.
      return { x: settled.x, y: lerp(cfg.restY, cfg.liftPinY, s), z: settled.z };
    case 'reposition':
      if (holdAloft) return { x: settled.x, y: cfg.liftPinY, z: settled.z };
      return { x: lerp(settled.x, home.x, s), y: cfg.liftPinY, z: lerp(settled.z, home.z, s) };
    case 'lower':
      if (holdAloft) return { x: settled.x, y: cfg.liftPinY, z: settled.z };
      return { x: home.x, y: lerp(cfg.liftPinY, cfg.restY, s), z: home.z };
    default: // settle-hold / idle: upright at the settled spot on the deck
      return { x: settled.x, y: cfg.restY, z: settled.z };
  }
}

// The ordered phases that always run, with their frame counts. The recovery
// phases (verify-clear, release, re-lift) are inserted between lift and
// reposition only when a tangle is detected, so they are driven separately.
const FORWARD: readonly ResetPhase[] = ['settle-hold', 'lift', 'reposition', 'lower'];

export class ResetCycle {
  private running = false;
  // The current phase and the frame index within it (0..phaseFrames-1). The cycle
  // is a phase state machine rather than one global frame counter, because the
  // recovery loop (verify-clear -> release -> re-lift -> verify-clear ...) has a
  // variable length that fixed cumulative boundaries cannot express.
  private currentPhase: ResetPhase = 'idle';
  private phaseFrame = 0;
  private accumulator = 0;
  // True while the cycle is holding at the top of a (re-)lift, waiting for the
  // adapter to report whether the live rack is tangled (see reportTangle). The
  // cycle emits hold-aloft targets and does not advance until a verdict lands.
  private awaitingVerdict = false;
  // Set when a verdict comes back clear (or force-clear at the cap): the rack,
  // which was let loose and dropped for the hang test, is reeled back up by one
  // re-lift and then the cycle proceeds to reposition rather than re-checking.
  private clearAfterReLift = false;
  // True once a started cycle has run to the end of lower. Distinguishes the
  // finished state from the never-started state (both have phase idle, not running).
  private completed = false;
  // How many drop-and-unwind retries have run this cycle (REQ-024 bounded loop).
  private retries = 0;
  private targetIndices: number[] = [];
  // Pins that stay reeled up and aloft through reposition/lower rather than
  // being set back on a home spot (the knocked-down pins on a between-balls
  // cycle). Empty on a rerack and on a clean between-balls cycle.
  private heldAloft = new Set<number>();
  private homes: readonly Vec3[] = [];
  private settled: readonly Vec3[] = [];

  // The no-recovery cycle length (settle-hold, lift, reposition, lower). A tangle
  // recovery loop adds frames on top of this at run time, so this is the minimum,
  // not the exact total when the rack snags. Kept for the timing test and callers
  // that bound their step loop.
  readonly totalFrames: number;
  private readonly maxRetries: number;

  constructor(private readonly cfg: ResetConfig) {
    this.totalFrames =
      cfg.settleHoldFrames + cfg.liftFrames + cfg.repositionFrames + cfg.lowerFrames;
    // Recovery runs only when all four tangle tunables are present; otherwise the
    // cycle behaves exactly as before (no verify-clear pause, no drop-and-unwind).
    const hasRecovery =
      cfg.verifyFrames != null &&
      cfg.releaseY != null &&
      cfg.releaseFrames != null &&
      cfg.reLiftFrames != null &&
      cfg.maxRetries != null;
    this.maxRetries = hasRecovery ? (cfg.maxRetries as number) : 0;
  }

  // Frames in a given phase. The recovery phases use their tangle tunables;
  // verify-clear is a single hold frame before the cycle pauses for the verdict.
  private framesFor(phase: ResetPhase): number {
    switch (phase) {
      case 'settle-hold':
        return this.cfg.settleHoldFrames;
      case 'lift':
        return this.cfg.liftFrames;
      case 'verify-clear':
        return this.cfg.verifyFrames ?? 1;
      case 'release':
        return this.cfg.releaseFrames ?? 0;
      case 're-lift':
        return this.cfg.reLiftFrames ?? 0;
      case 'reposition':
        return this.cfg.repositionFrames;
      case 'lower':
        return this.cfg.lowerFrames;
      default:
        return 0;
    }
  }

  // Begin a cycle. rerack reels all ten pins and sets them on their home spots.
  // between-balls reels all ten as well (the recall-all motion): the standing
  // pins land back on their home spots while the given fallen pins stay reeled up
  // and aloft (cleared, never lowered). homeSpots are the pin home spots and
  // settledPositions are where each pin currently rests, both in pin order.
  start(
    mode: ResetMode,
    fallenPinIndices: readonly number[],
    homeSpots: readonly Vec3[],
    settledPositions: readonly Vec3[],
  ): void {
    this.homes = homeSpots;
    this.settled = settledPositions;
    // Both modes reel the whole rack. On a between-balls cycle the fallen pins
    // hold aloft; everything else (standing pins, all ten on a rerack) lands home.
    this.targetIndices = homeSpots.map((_, i) => i);
    this.heldAloft = mode === 'rerack' ? new Set() : new Set(fallenPinIndices);
    this.currentPhase = 'settle-hold';
    this.phaseFrame = 0;
    this.accumulator = 0;
    this.awaitingVerdict = false;
    this.clearAfterReLift = false;
    this.completed = false;
    this.retries = 0;
    this.running = true;
  }

  // The pin indices this cycle is carrying (all ten: the whole rack reels up).
  get targets(): readonly number[] {
    return this.targetIndices;
  }

  // The pins this cycle lands back on a home spot (so the caller hands exactly
  // these back to the dynamics): all ten on a rerack, only the standing pins on a
  // between-balls cycle. The held-aloft fallen pins stay kinematic and aloft.
  get landedTargets(): readonly number[] {
    return this.targetIndices.filter((i) => !this.heldAloft.has(i));
  }

  // The pins held reeled up and aloft at the end of this cycle (the knocked-down
  // pins on a between-balls cycle). Empty on a rerack.
  get heldAloftTargets(): readonly number[] {
    return [...this.heldAloft];
  }

  // True when the cycle is holding the rack aloft waiting for the adapter to read
  // the live sim and report whether the rack is tangled (REQ-024). The adapter
  // checks this each step and calls reportTangle to release the pause.
  get needsTangleVerdict(): boolean {
    return this.awaitingVerdict;
  }

  // How many drop-and-unwind retries have run so far this cycle (0 on a clean
  // reset). Exposed so the adapter / tests can observe the bounded recovery loop.
  get retryCount(): number {
    return this.retries;
  }

  // Report the live tangle verdict while the cycle is paused at a verify-clear
  // checkpoint (needsTangleVerdict). tangled=true with retries left enters a
  // drop-and-unwind pass (release -> re-lift -> verify-clear again); tangled=false,
  // or the retry cap reached (a force-clear so the reset can never hang), proceeds
  // to reposition. A no-op if the cycle is not awaiting a verdict.
  reportTangle(tangled: boolean): void {
    if (!this.awaitingVerdict) return;
    this.awaitingVerdict = false;
    // Either way the lowered, let-loose rack is reeled back up (re-lift) first.
    // A clear verdict (or a force-clear at the retry cap) then proceeds to set the
    // rack (reposition); a tangle with retries left drops and unwinds again.
    if (tangled && this.retries < this.maxRetries) {
      this.retries += 1;
      this.clearAfterReLift = false;
    } else {
      this.clearAfterReLift = true;
    }
    this.enterPhase('re-lift');
  }

  private enterPhase(phase: ResetPhase): void {
    this.currentPhase = phase;
    this.phaseFrame = 0;
  }

  // Update where the carried pins are taken to have settled, after a release let
  // them swing to new positions (REQ-024 recovery). The re-lift reels each pin
  // straight up over its new x,z, and the later reposition carries it home from
  // there, so the recovered pins do not snap back to their pre-drop columns.
  updateSettled(settledPositions: readonly Vec3[]): void {
    this.settled = settledPositions;
  }

  private targetsForPhase(phase: ResetPhase, frame: number): ResetTarget[] {
    const frames = this.framesFor(phase);
    const progress = Math.min(1, Math.max(0, frame / Math.max(1, frames - 1)));
    return this.targetIndices.map((pinIndex) => {
      const target = pinTargetFor(
        phase,
        progress,
        this.homes[pinIndex],
        this.settled[pinIndex],
        this.cfg,
        this.heldAloft.has(pinIndex),
      );
      return { pinIndex, x: target.x, y: target.y, z: target.z };
    });
  }

  // Advance to whatever phase follows the one that just finished. Recovery is
  // inserted after lift / re-lift via the verify-clear checkpoint; otherwise the
  // FORWARD order runs straight through to idle (cycle complete).
  private advancePhase(): void {
    switch (this.currentPhase) {
      case 'lift':
        // Top of the first lift (the recall-all rise). Recovery is only armed when
        // maxRetries > 0; otherwise skip straight to reposition so the no-recovery
        // cycle is unchanged. Armed: drop the rack (release) for the hang test.
        if (this.maxRetries > 0) this.enterPhase('release');
        else this.enterPhase('reposition');
        return;
      case 'release':
        // The drop landed: let the rack settle loose for the tangle read.
        this.enterPhase('verify-clear');
        return;
      case 'verify-clear':
        // The settle window elapsed: pause until reportTangle reels the rack back
        // up (re-lift) and decides whether to re-check or set it down.
        this.awaitingVerdict = true;
        return;
      case 're-lift':
        // After reeling the dropped rack back up: a cleared rack proceeds to
        // reposition; otherwise drop and unwind again (release -> verify-clear).
        if (this.clearAfterReLift) this.enterPhase('reposition');
        else this.enterPhase('release');
        return;
      default: {
        const next = FORWARD[FORWARD.indexOf(this.currentPhase) + 1];
        if (next) this.enterPhase(next);
        else {
          this.currentPhase = 'idle';
          this.running = false;
          this.completed = true;
        }
      }
    }
  }

  // Advance exactly one fixed step; returns the carried pin targets for this step.
  // While awaiting a tangle verdict the cycle holds (emits the verify-clear hold
  // targets) and does not advance until reportTangle is called.
  step(): ResetTarget[] {
    if (!this.running) return [];
    if (this.awaitingVerdict) {
      // Hold the rack aloft at the verify-clear position until a verdict lands.
      return this.targetsForPhase('verify-clear', 0);
    }
    const targets = this.targetsForPhase(this.currentPhase, this.phaseFrame);
    this.phaseFrame += 1;
    if (this.phaseFrame >= this.framesFor(this.currentPhase)) this.advancePhase();
    return targets;
  }

  // Advance by real elapsed seconds, accumulating to the fixed step. Returns the
  // most recent step's targets (empty if no whole step elapsed or the cycle is idle).
  // Stops accumulating while awaiting a verdict so the pause does not burn budget.
  update(dt: number): ResetTarget[] {
    if (!this.running) return [];
    this.accumulator += dt;
    let targets: ResetTarget[] = [];
    while (this.running && !this.awaitingVerdict && this.accumulator >= FIXED_STEP) {
      targets = this.step();
      this.accumulator -= FIXED_STEP;
    }
    // Surface the hold targets while paused so the adapter keeps the rack aloft.
    if (this.awaitingVerdict) targets = this.step();
    return targets;
  }

  get phase(): ResetPhase {
    return this.running ? this.currentPhase : 'idle';
  }

  get isRunning(): boolean {
    return this.running;
  }

  isComplete(): boolean {
    return this.completed;
  }
}
