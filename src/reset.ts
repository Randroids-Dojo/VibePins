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
export type ResetPhase = 'idle' | 'settle-hold' | 'lift' | 'reposition' | 'lower';

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
  switch (phase) {
    case 'lift':
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

export class ResetCycle {
  private running = false;
  private frame = 0;
  private accumulator = 0;
  private targetIndices: number[] = [];
  // Pins that stay reeled up and aloft through reposition/lower rather than
  // being set back on a home spot (the knocked-down pins on a between-balls
  // cycle). Empty on a rerack and on a clean between-balls cycle.
  private heldAloft = new Set<number>();
  private homes: readonly Vec3[] = [];
  private settled: readonly Vec3[] = [];

  // Frame boundaries for the full cycle (settle-hold, lift, reposition, lower).
  // Both modes now run the complete cycle: a between-balls reset reels the whole
  // rack up (lift) then lowers the standing pins home (reposition/lower) while the
  // fallen pins hold aloft, and a rerack lowers every pin home.
  readonly totalFrames: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly b3: number;

  constructor(private readonly cfg: ResetConfig) {
    this.b1 = cfg.settleHoldFrames;
    this.b2 = this.b1 + cfg.liftFrames;
    this.b3 = this.b2 + cfg.repositionFrames;
    this.totalFrames = this.b3 + cfg.lowerFrames;
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
    this.frame = 0;
    this.accumulator = 0;
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

  private phaseAt(frame: number): { phase: ResetPhase; progress: number } {
    const within = (start: number, frames: number) => Math.min(1, Math.max(0, (frame - start) / Math.max(1, frames - 1)));
    if (frame < this.b1) return { phase: 'settle-hold', progress: within(0, this.cfg.settleHoldFrames) };
    if (frame < this.b2) return { phase: 'lift', progress: within(this.b1, this.cfg.liftFrames) };
    if (frame < this.b3) return { phase: 'reposition', progress: within(this.b2, this.cfg.repositionFrames) };
    if (frame < this.totalFrames) return { phase: 'lower', progress: within(this.b3, this.cfg.lowerFrames) };
    return { phase: 'idle', progress: 1 };
  }

  private targetsAtFrame(frame: number): ResetTarget[] {
    const { phase, progress } = this.phaseAt(frame);
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

  // Advance exactly one fixed step; returns the carried pin targets for this step.
  step(): ResetTarget[] {
    if (!this.running) return [];
    const targets = this.targetsAtFrame(this.frame);
    this.frame += 1;
    if (this.frame >= this.totalFrames) this.running = false;
    return targets;
  }

  // Advance by real elapsed seconds, accumulating to the fixed step. Returns the
  // most recent step's targets (empty if no whole step elapsed or the cycle is idle).
  update(dt: number): ResetTarget[] {
    if (!this.running) return [];
    this.accumulator += dt;
    let targets: ResetTarget[] = [];
    while (this.running && this.accumulator >= FIXED_STEP) {
      targets = this.step();
      this.accumulator -= FIXED_STEP;
    }
    return targets;
  }

  get phase(): ResetPhase {
    return this.running ? this.phaseAt(this.frame).phase : 'idle';
  }

  get isRunning(): boolean {
    return this.running;
  }

  isComplete(): boolean {
    return this.frame >= this.totalFrames;
  }
}
