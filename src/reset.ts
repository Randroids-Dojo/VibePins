// String pinsetter reset cycle (GDD 03-string-pinsetter, REQ-018 to REQ-021).
//
// A reset reels fallen pins up by their cords and sets them back on their home
// spots, with no sweep (REQ-020). During the cycle each targeted pin is carried
// kinematically: righted and raised straight up off the deck, moved over its
// home spot while raised, then lowered onto the spot, after which it is handed
// back to the dynamics at rest. The overhead cords (rendered from the fixed
// anchor to each pin neck) follow the carried pins, so the lift reads as strings
// pulling the pins up, not a sweep. Standing pins are never targeted, so they
// respot exactly where they came to rest (REQ-021).
//
// This controller is pure: no Three.js, no Rapier. It is a frame-counted state
// machine returning, per fixed step, the carried pin world targets. The physics
// adapter (PinSet) makes the targeted pins kinematic, applies the targets, and
// returns them to dynamic when the cycle completes.

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
export function pinTargetFor(phase: ResetPhase, progress: number, home: Vec3, settled: Vec3, cfg: ResetConfig): Vec3 {
  const s = smoothstep(progress);
  switch (phase) {
    case 'lift':
      return { x: settled.x, y: lerp(cfg.restY, cfg.liftPinY, s), z: settled.z };
    case 'reposition':
      return { x: lerp(settled.x, home.x, s), y: cfg.liftPinY, z: lerp(settled.z, home.z, s) };
    case 'lower':
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
  private homes: readonly Vec3[] = [];
  private settled: readonly Vec3[] = [];

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

  // Begin a cycle. In between-balls mode only the given fallen pins are reeled;
  // rerack mode reels all ten. homeSpots are the pin home spots and
  // settledPositions are where each pin currently rests, both in pin order.
  start(
    mode: ResetMode,
    fallenPinIndices: readonly number[],
    homeSpots: readonly Vec3[],
    settledPositions: readonly Vec3[],
  ): void {
    this.homes = homeSpots;
    this.settled = settledPositions;
    this.targetIndices = mode === 'rerack' ? homeSpots.map((_, i) => i) : [...fallenPinIndices];
    this.frame = 0;
    this.accumulator = 0;
    this.running = true;
  }

  // The pin indices this cycle is carrying (so the caller can hand exactly these
  // back to the dynamics when the cycle completes).
  get targets(): readonly number[] {
    return this.targetIndices;
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
      const target = pinTargetFor(phase, progress, this.homes[pinIndex], this.settled[pinIndex], this.cfg);
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
