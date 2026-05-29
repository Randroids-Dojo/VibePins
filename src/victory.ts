// Strike victory routine (GDD 04-look-and-feel "juice", REQ-044).
//
// A strike runs a brief Rube Goldberg flourish: a burst of mechanical debris
// flung up off the pin deck plus a quick camera shake, alongside the audio
// strike sting (REQ-043, played by the caller). This module is the pure
// simulation: it owns no Three.js objects and no DOM. It spawns a fixed set of
// debris particles with random initial velocities, integrates them under
// gravity each frame, and produces a decaying camera-shake offset. The visual
// layer in world3d turns the particle states into meshes and applies the shake
// offset to the camera; main.ts triggers it on a strike.
//
// Kept deliberately short (VICTORY.durationSeconds) so the loop never drags;
// the GDD warns against long unskippable animations.

import type { Vec3 } from './config.js';

export interface VictoryConfig {
  readonly debrisCount: number;
  readonly originY: number;
  readonly spawnSpread: number;
  readonly upMin: number;
  readonly upMax: number;
  readonly sidewaysSpeed: number;
  readonly debrisHalfSize: number;
  readonly spinSpeed: number;
  readonly gravity: number;
  readonly durationSeconds: number;
  readonly shakeAmplitude: number;
  readonly shakeSeconds: number;
  readonly shakeFreqX: number;
  readonly shakeFreqY: number;
}

// One debris bit. position/velocity in world metres; spin is a per-axis
// tumble rate (rad/s) integrated into rotation so the visual mesh can tumble.
export interface Debris {
  position: Vec3;
  velocity: Vec3;
  rotation: Vec3;
  readonly spin: Vec3;
  // Even bits are sparks, odd bits are steel scrap, so the visual layer can
  // colour them from the two-tone palette without the sim knowing about colour.
  readonly spark: boolean;
}

// A function returning [0, 1). Injected so the burst is deterministic in tests.
export type Rng = () => number;

// Map a [0, 1) sample to [-1, +1).
const signed = (r: number): number => r * 2 - 1;

export class VictoryRoutine {
  private elapsed = 0;
  private running = false;
  private readonly debrisList: Debris[] = [];
  private readonly shake = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly cfg: VictoryConfig,
    private readonly rng: Rng = Math.random,
  ) {}

  // Whether the routine is currently playing (spawned and not yet finished).
  get active(): boolean {
    return this.running;
  }

  // The live debris states for the visual layer to mirror onto meshes.
  get debris(): readonly Debris[] {
    return this.debrisList;
  }

  // The current camera-shake offset (metres) to add to the camera position.
  // Zero before the routine starts and after the shake has decayed.
  get shakeOffset(): Vec3 {
    return this.shake;
  }

  // Begin a fresh burst at the given origin (the rack head spot on the deck).
  // Re-triggering restarts cleanly: a second strike replaces an in-flight burst
  // rather than stacking, so the debris count and timing stay bounded.
  start(origin: Vec3): void {
    this.elapsed = 0;
    this.running = true;
    this.debrisList.length = 0;
    for (let i = 0; i < this.cfg.debrisCount; i += 1) {
      const up = this.cfg.upMin + this.rng() * (this.cfg.upMax - this.cfg.upMin);
      this.debrisList.push({
        position: {
          x: origin.x + signed(this.rng()) * this.cfg.spawnSpread,
          y: this.cfg.originY,
          z: origin.z + signed(this.rng()) * this.cfg.spawnSpread,
        },
        velocity: {
          x: signed(this.rng()) * this.cfg.sidewaysSpeed,
          y: up,
          z: signed(this.rng()) * this.cfg.sidewaysSpeed,
        },
        rotation: { x: 0, y: 0, z: 0 },
        spin: {
          x: signed(this.rng()) * this.cfg.spinSpeed,
          y: signed(this.rng()) * this.cfg.spinSpeed,
          z: signed(this.rng()) * this.cfg.spinSpeed,
        },
        spark: i % 2 === 0,
      });
    }
    this.updateShake();
  }

  // Advance the burst by dt seconds: integrate debris under gravity, tumble each
  // bit, and recompute the decaying shake. Ends the routine once the duration
  // elapses, leaving debris and shake zeroed so the visual layer can hide them.
  update(dt: number): void {
    if (!this.running) return;
    this.elapsed += dt;

    for (const bit of this.debrisList) {
      bit.velocity = {
        x: bit.velocity.x,
        y: bit.velocity.y + this.cfg.gravity * dt,
        z: bit.velocity.z,
      };
      bit.position = {
        x: bit.position.x + bit.velocity.x * dt,
        y: bit.position.y + bit.velocity.y * dt,
        z: bit.position.z + bit.velocity.z * dt,
      };
      bit.rotation = {
        x: bit.rotation.x + bit.spin.x * dt,
        y: bit.rotation.y + bit.spin.y * dt,
        z: bit.rotation.z + bit.spin.z * dt,
      };
    }

    this.updateShake();

    if (this.elapsed >= this.cfg.durationSeconds) {
      this.running = false;
      this.debrisList.length = 0;
      this.shake.x = 0;
      this.shake.y = 0;
      this.shake.z = 0;
    }
  }

  // Recompute the shake offset for the current elapsed time. The amplitude
  // decays linearly to zero over shakeSeconds; the offset oscillates on x and y
  // at distinct frequencies so the shake reads as a rattle, not a slide. Z is
  // left unshaken so the down-lane framing stays stable.
  private updateShake(): void {
    const t = this.elapsed;
    if (t >= this.cfg.shakeSeconds) {
      this.shake.x = 0;
      this.shake.y = 0;
      this.shake.z = 0;
      return;
    }
    const decay = 1 - t / this.cfg.shakeSeconds;
    const amp = this.cfg.shakeAmplitude * decay;
    this.shake.x = amp * Math.sin(2 * Math.PI * this.cfg.shakeFreqX * t);
    this.shake.y = amp * Math.sin(2 * Math.PI * this.cfg.shakeFreqY * t);
    this.shake.z = 0;
  }
}
