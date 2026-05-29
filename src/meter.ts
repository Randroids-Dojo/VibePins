// Sweeping stop-the-meter control (GDD 08-controls, REQ-034 spin/angle).
//
// A cursor oscillates back and forth across a normalized track [-1, +1] at a
// steady, readable speed. One confirm input stops it; where it stops is the
// chosen value. This is the timed spin/angle step of the three-step throw: a
// stop near 0 is straight and low-spin, a stop toward a side imparts that-side
// spin and curve. The power meter (REQ-035) is the same mechanic on a different
// range and lands as its own slice (F-007), so this stays a single small
// reusable state machine rather than a spin-specific one.
//
// Pure: it owns no DOM or Three.js objects and produces the cursor position
// each frame; the caller renders the gauge and feeds the launch resolution.

export type MeterPhase = 'idle' | 'sweeping' | 'stopped';

export interface SweepMeterConfig {
  // Full sweeps per second across the track (one sweep is one end-to-end pass,
  // so a full back-and-forth cycle takes 2 / sweepsPerSecond seconds).
  readonly sweepsPerSecond: number;
}

// Triangle wave on [-1, +1] from a sweep phase in [0, 1): 0 -> +1, 0.5 -> -1,
// 1 -> +1. Continuous and symmetric so the cursor reverses smoothly at each end.
const triangle = (phase: number): number => {
  const p = phase - Math.floor(phase);
  // Peaks at the cycle ends and troughs at the half point: p=0 -> +1,
  // p=0.5 -> -1, p=1 -> +1. A symmetric back-and-forth that reverses smoothly.
  return 4 * Math.abs(p - 0.5) - 1;
};

export class SweepMeter {
  private phase: MeterPhase = 'idle';
  // Sweep clock in [0, 1) advanced each frame while sweeping.
  private clock = 0;
  // The position captured at the stop (also the live position while sweeping).
  private value = 1;

  constructor(private readonly cfg: SweepMeterConfig) {}

  // Begin a fresh sweep from one end of the track.
  start(): void {
    this.phase = 'sweeping';
    this.clock = 0;
    this.value = triangle(0);
  }

  // Stop the sweep and capture the current cursor position. No-op unless
  // actively sweeping, so a stray second confirm cannot re-capture a value.
  stop(): void {
    if (this.phase !== 'sweeping') return;
    this.phase = 'stopped';
    this.value = triangle(this.clock);
  }

  get currentPhase(): MeterPhase {
    return this.phase;
  }

  get isSweeping(): boolean {
    return this.phase === 'sweeping';
  }

  // The chosen value on [-1, +1]: live while sweeping, frozen once stopped.
  get position(): number {
    return this.value;
  }

  // Advance the sweep and return the live cursor position. While stopped or
  // idle the position holds; only a running sweep moves.
  update(dt: number): number {
    if (this.phase === 'sweeping') {
      // Two ends per full triangle cycle, so the cycle period is
      // 2 / sweepsPerSecond. clock spans one cycle over [0, 1).
      this.clock += dt * this.cfg.sweepsPerSecond * 0.5;
      this.clock -= Math.floor(this.clock);
      this.value = triangle(this.clock);
    }
    return this.value;
  }
}
