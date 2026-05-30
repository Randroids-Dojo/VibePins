// String pinsetter reset cycle (GDD 03-string-pinsetter, REQ-018 to REQ-021,
// REQ-024).
//
// The reset is sweepless (REQ-020): pins are reeled up BY THEIR NECK CORDS and
// then set, never wiped. The lift is genuinely cord-tension driven, matching a
// real string machine: each pin is raised by reeling in the cord attached at its
// neck, so a downed pin is dragged up by the neck and HANGS from the cord,
// swinging and righting itself base-down under gravity as it rises. It is never
// stood upright on the deck first. Only once the rack hangs clear aloft does the
// machine carry the pins it will set back over their home spots and lower them.
//
// Two reset shapes:
//
//   between-balls (REQ-009): when one or more pins were knocked down, the WHOLE
//   rack reels up by the cords. The STANDING pins are then carried back over
//   their HOME spots and lowered onto them (re-spotting a nudged-but-standing
//   pin, REQ-021). The KNOCKED-DOWN pins stay reeled up and aloft, cleared out
//   of play, never lowered, so only the standing pins remain on the deck.
//
//   rerack (REQ-010): at frame end all ten pins reel up, are carried over their
//   home spots, and lowered onto them, then handed back to the dynamics at rest.
//   This is the only motion that sets every pin back down, so the deck reads as a
//   clean fresh rack of ten.
//
// Tangles are RARE and GENUINE (REQ-024). A clean rack reels straight up with NO
// shake. A tangle is only the real condition a real string machine hits less than
// once per ~1000 frames: a downed pin lying across another pin's cord snags the
// cords during the reel-up so a pin cannot rise to its clearance height. ONLY
// then does the machine run an up/down shake (pay the cords out a little, let
// gravity swing the snag loose, reel back up) and re-check, bounded by a retry cap
// with a force-clear so the reset can never hang.
//
// This controller is pure: no Three.js, no Rapier. It is a frame-counted state
// machine. The physics adapter (PinSet, src/main.ts) does the cord reeling, reads
// the live sim for the snag verdict, and recaptures/sets the pins.

import type { Vec3 } from './config.js';

export type ResetMode = 'between-balls' | 'rerack';

// The reset phases, in run order.
//   settle-hold  legibility beat; the rack rests on the deck, no cord motion.
//   lift         cord-tension reel-up: each pin's cord shortens from slack to the
//                lifted length, dragging the pin up by its neck so it hangs and
//                swings. Pins stay DYNAMIC here.
//   verify-lift  after the reel-up the adapter reads whether every pin rose to its
//                clearance height. A clean rack proceeds; a genuine snag (a pin
//                still held low) enters the shake recovery.
//   shake-down   recovery only: pay the cords back out so the snagged cluster
//                drops and gravity swings it loose.
//   shake-up     recovery only: reel back up to re-check after a shake.
//   reposition   kinematic carry: the set-down pins move over their home spots.
//   lower        kinematic carry: the held pins lower onto their home spots.
export type ResetPhase =
  | 'idle'
  | 'settle-hold'
  | 'lift'
  | 'verify-lift'
  | 'shake-down'
  | 'shake-up'
  | 'reposition'
  | 'lower';

export interface ResetTarget {
  readonly pinIndex: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// A per-step cord reel command during the cord-tension phases (lift / shake). The
// adapter shortens each pin's rope joint to `ropeLength`, so the cord drags the
// pin up by the neck and the pin hangs/swings under gravity (dynamic, not carried).
export interface ReelTarget {
  readonly pinIndex: number;
  readonly ropeLength: number;
}

export interface ResetConfig {
  readonly settleHoldFrames: number;
  readonly liftFrames: number;
  readonly repositionFrames: number;
  readonly lowerFrames: number;
  readonly liftPinY: number; // pin centre height while carried clear of the deck
  readonly restY: number; //    pin centre height resting on the deck (floorY + pinHeight/2)
  // Cord-tension lift geometry. slackRopeLength is the at-throw slack the cord
  // hangs at; liftRopeLength is the short length the reel-up shortens to, so the
  // pin's neck is pulled up near its overhead anchor and the pin dangles below it.
  readonly slackRopeLength: number;
  readonly liftRopeLength: number;
  // Tangle up/down shake recovery (REQ-024). Optional so callers that pass only
  // the lift geometry keep a no-recovery cycle (clean rack always, never shakes).
  readonly shakeRopeLength?: number; // rope length the shake pays back out to
  readonly shakeDownFrames?: number; // frames to pay the cords out on a shake
  readonly shakeUpFrames?: number; //  frames to reel back up after a shake
  readonly maxRetries?: number; //     shakes before a force-clear (bounded)
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

// The carried pin centre target for the kinematic phases (reposition / lower).
// `home` is the pin's home spot, `settled` where it hung after the lift.
//   reposition: carry the pin (held high) across to over its home spot
//   lower:      set it down onto the home spot
//
// `holdAloft` is the knocked-down case on a between-balls cycle: the pin stays
// reeled up and aloft over its settled spot through reposition and lower, cleared
// out of play rather than set back down (REQ-009).
export function pinTargetFor(
  phase: ResetPhase,
  progress: number,
  home: Vec3,
  settled: Vec3,
  cfg: ResetConfig,
  holdAloft = false,
): Vec3 {
  const s = smoothstep(progress);
  switch (phase) {
    case 'reposition':
      if (holdAloft) return { x: settled.x, y: cfg.liftPinY, z: settled.z };
      return { x: lerp(settled.x, home.x, s), y: cfg.liftPinY, z: lerp(settled.z, home.z, s) };
    case 'lower':
      if (holdAloft) return { x: settled.x, y: cfg.liftPinY, z: settled.z };
      return { x: home.x, y: lerp(cfg.liftPinY, cfg.restY, s), z: home.z };
    default:
      // settle-hold / idle / the cord-tension phases have no kinematic target;
      // the pin is dynamic and hangs from its reeling cord. Fall back to the held
      // clearance over the settled spot so a stray read is harmless.
      return { x: settled.x, y: cfg.liftPinY, z: settled.z };
  }
}

// The cord length for a pin during a cord-tension phase (lift / shake) at a given
// 0..1 progress. The lift shortens from slack to the lifted length; a shake-down
// pays back out to the shake length; a shake-up reels in again to the lifted
// length. Pure: the adapter applies this to the rope joint.
export function ropeLengthFor(phase: ResetPhase, progress: number, cfg: ResetConfig): number {
  const s = smoothstep(progress);
  const shakeLen = cfg.shakeRopeLength ?? cfg.liftRopeLength;
  switch (phase) {
    case 'lift':
      return lerp(cfg.slackRopeLength, cfg.liftRopeLength, s);
    case 'shake-down':
      return lerp(cfg.liftRopeLength, shakeLen, s);
    case 'shake-up':
      return lerp(shakeLen, cfg.liftRopeLength, s);
    default:
      return cfg.liftRopeLength;
  }
}

// The ordered kinematic-carry phases that always run after a clear lift.
const FORWARD: readonly ResetPhase[] = ['reposition', 'lower'];

export class ResetCycle {
  private running = false;
  private currentPhase: ResetPhase = 'idle';
  private phaseFrame = 0;
  private accumulator = 0;
  // True while the cycle is paused at the top of a (re-)reel waiting for the
  // adapter to read whether any pin is genuinely snagged (failed to clear).
  private awaitingVerdict = false;
  private completed = false;
  private retries = 0;
  private targetIndices: number[] = [];
  private heldAloft = new Set<number>();
  private homes: readonly Vec3[] = [];
  private settled: readonly Vec3[] = [];

  // The no-recovery cycle length (settle-hold, lift, reposition, lower). A snag
  // recovery loop adds frames on top of this at run time, so this is the minimum.
  readonly totalFrames: number;
  private readonly maxRetries: number;
  private readonly hasRecovery: boolean;

  constructor(private readonly cfg: ResetConfig) {
    this.totalFrames =
      cfg.settleHoldFrames + cfg.liftFrames + cfg.repositionFrames + cfg.lowerFrames;
    this.hasRecovery =
      cfg.shakeRopeLength != null &&
      cfg.shakeDownFrames != null &&
      cfg.shakeUpFrames != null &&
      cfg.maxRetries != null;
    this.maxRetries = this.hasRecovery ? (cfg.maxRetries as number) : 0;
  }

  private framesFor(phase: ResetPhase): number {
    switch (phase) {
      case 'settle-hold':
        return this.cfg.settleHoldFrames;
      case 'lift':
        return this.cfg.liftFrames;
      case 'verify-lift':
        return 1; // a single frame before the cycle pauses for the verdict
      case 'shake-down':
        return this.cfg.shakeDownFrames ?? 0;
      case 'shake-up':
        return this.cfg.shakeUpFrames ?? 0;
      case 'reposition':
        return this.cfg.repositionFrames;
      case 'lower':
        return this.cfg.lowerFrames;
      default:
        return 0;
    }
  }

  // Begin a cycle. Both modes reel the whole rack up by the cords. On a
  // between-balls cycle the fallen pins hold aloft (cleared); the standing pins
  // (and all ten on a rerack) land home. homeSpots and settledPositions are in
  // pin order.
  start(
    mode: ResetMode,
    fallenPinIndices: readonly number[],
    homeSpots: readonly Vec3[],
    settledPositions: readonly Vec3[],
  ): void {
    this.homes = homeSpots;
    this.settled = settledPositions;
    this.targetIndices = homeSpots.map((_, i) => i);
    this.heldAloft = mode === 'rerack' ? new Set() : new Set(fallenPinIndices);
    this.currentPhase = 'settle-hold';
    this.phaseFrame = 0;
    this.accumulator = 0;
    this.awaitingVerdict = false;
    this.completed = false;
    this.retries = 0;
    this.running = true;
  }

  // The pin indices this cycle is carrying (all ten: the whole rack reels up).
  get targets(): readonly number[] {
    return this.targetIndices;
  }

  // The pins this cycle lands back on a home spot: all ten on a rerack, only the
  // standing pins on a between-balls cycle. The held-aloft fallen pins stay aloft.
  get landedTargets(): readonly number[] {
    return this.targetIndices.filter((i) => !this.heldAloft.has(i));
  }

  // The pins held reeled up and aloft at the end of this cycle (the knocked-down
  // pins on a between-balls cycle). Empty on a rerack.
  get heldAloftTargets(): readonly number[] {
    return [...this.heldAloft];
  }

  // True when the cycle is holding at the top of a reel waiting for the adapter to
  // read whether any pin is genuinely snagged (REQ-024). The adapter checks this
  // each step and calls reportSnag to release the pause.
  get needsSnagVerdict(): boolean {
    return this.awaitingVerdict;
  }

  // How many up/down shake retries have run so far this cycle (0 on a clean
  // reel-up, the overwhelmingly common case).
  get retryCount(): number {
    return this.retries;
  }

  // Report whether the rack is genuinely snagged, while the cycle is paused at the
  // verify-lift checkpoint (needsSnagVerdict). snagged=false (the common case)
  // proceeds straight to reposition with NO shake. snagged=true with retries left
  // runs an up/down shake (shake-down then shake-up) and re-checks; the retry cap
  // forces a clear so the reset can never hang. A no-op off a checkpoint.
  reportSnag(snagged: boolean): void {
    if (!this.awaitingVerdict) return;
    this.awaitingVerdict = false;
    if (snagged && this.retries < this.maxRetries) {
      // A genuine snag with retries left: pay the cords out (shake-down), let
      // gravity swing the snag loose, then reel back up (shake-up) and re-check.
      this.retries += 1;
      this.enterPhase('shake-down');
    } else {
      // Clean (the common case), or the cap reached (force-clear): set the rack.
      // No shake runs on a clean rack: go straight to the kinematic carry.
      this.enterPhase('reposition');
    }
  }

  private enterPhase(phase: ResetPhase): void {
    this.currentPhase = phase;
    this.phaseFrame = 0;
  }

  // Update where the pins are taken to have settled, after the cord-tension lift
  // (and any shake) let them hang/swing to new positions. The reposition then
  // carries each pin home from where it actually hangs, not its pre-lift column.
  updateSettled(settledPositions: readonly Vec3[]): void {
    this.settled = settledPositions;
  }

  // The kinematic carry targets for the current phase (reposition / lower only).
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

  // The per-pin cord reel length for the current cord-tension phase. Empty unless
  // the phase is lift / shake-down / shake-up.
  private reelForPhase(phase: ResetPhase, frame: number): ReelTarget[] {
    if (phase !== 'lift' && phase !== 'shake-down' && phase !== 'shake-up') return [];
    const frames = this.framesFor(phase);
    const progress = Math.min(1, Math.max(0, frame / Math.max(1, frames - 1)));
    const ropeLength = ropeLengthFor(phase, progress, this.cfg);
    return this.targetIndices.map((pinIndex) => ({ pinIndex, ropeLength }));
  }

  // Advance to whatever phase follows the one that just finished.
  private advancePhase(): void {
    switch (this.currentPhase) {
      case 'settle-hold':
        this.enterPhase('lift');
        return;
      case 'lift':
        // Top of the cord-tension reel-up. With recovery armed, pause for the snag
        // read (verify-lift). Without it, a clean reel-up always proceeds to set.
        if (this.hasRecovery) this.enterPhase('verify-lift');
        else this.enterPhase('reposition');
        return;
      case 'verify-lift':
        // Pause until reportSnag decides: clean -> reposition, snag -> shake.
        this.awaitingVerdict = true;
        return;
      case 'shake-down':
        // Cords paid out and the snag let swing: reel back up to re-check.
        this.enterPhase('shake-up');
        return;
      case 'shake-up':
        // Reeled back up after a shake: re-read for a snag (loop). The retry cap
        // in reportSnag forces a clear so the loop is always bounded.
        this.enterPhase('verify-lift');
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

  // Advance exactly one fixed step; returns the kinematic carry targets (empty on
  // the cord-tension phases, where the pin is dynamic) AND the cord reel command
  // for that step. While awaiting a snag verdict the cycle holds and does not
  // advance until reportSnag is called.
  step(): { targets: ResetTarget[]; reel: ReelTarget[] } {
    if (!this.running) return { targets: [], reel: [] };
    if (this.awaitingVerdict) {
      // Hold at the lifted clearance until a verdict lands. No kinematic carry yet
      // (the pins are still dynamic and hanging), and hold the cord at lift length.
      return { targets: [], reel: this.reelForPhase('lift', this.framesFor('lift') - 1) };
    }
    const phase = this.currentPhase;
    const targets = this.targetsForPhase(phase, this.phaseFrame);
    const reel = this.reelForPhase(phase, this.phaseFrame);
    this.phaseFrame += 1;
    if (this.phaseFrame >= this.framesFor(phase)) this.advancePhase();
    // Kinematic targets are only meaningful for the carry phases; null them out on
    // the dynamic cord-tension phases so the adapter does not teleport a hanging pin.
    const carry = phase === 'reposition' || phase === 'lower' ? targets : [];
    return { targets: carry, reel };
  }

  // Advance by real elapsed seconds, accumulating to the fixed step. Returns the
  // most recent step's targets/reel. Stops accumulating while awaiting a verdict.
  update(dt: number): { targets: ResetTarget[]; reel: ReelTarget[] } {
    if (!this.running) return { targets: [], reel: [] };
    this.accumulator += dt;
    let out: { targets: ResetTarget[]; reel: ReelTarget[] } = { targets: [], reel: [] };
    while (this.running && !this.awaitingVerdict && this.accumulator >= FIXED_STEP) {
      out = this.step();
      this.accumulator -= FIXED_STEP;
    }
    if (this.awaitingVerdict) out = this.step();
    return out;
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
