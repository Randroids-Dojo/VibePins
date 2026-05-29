// Shot-setup camera director (GDD 08-controls, REQ-033 lineup).
//
// The camera animates through a scripted sequence for each shot: hold at the
// ball return (first-person pickup), walk up to the foul line, then let the
// player shift their line before locking into the shooting pose. It is a pure
// state machine: it owns no Three.js objects and produces the current camera
// pose (position, lookAt, fov) each frame; the caller applies it to the camera.

import type { Vec3 } from './config.js';

export type ShotPhase = 'pickup' | 'walkup' | 'align' | 'locked';

// A throw is only allowed once the line is locked and the ball is still held
// (not already in flight). Pure, so the main-loop guard is testable.
export function canThrow(phase: ShotPhase, holding: boolean): boolean {
  return phase === 'locked' && holding;
}

export interface CameraPose {
  readonly pos: Vec3;
  readonly lookAt: Vec3;
  readonly fov: number;
}

// One frame of the shot setup: where the camera is, and where the carried ball
// is (the ball is held kinematically until the throw).
export interface ShotFrame {
  readonly pose: CameraPose;
  readonly ballPos: Vec3;
}

// The ball carry path: resting on the return, lifted into the hands, then the
// ready spot at the foul line.
export interface BallPath {
  readonly rest: Vec3;
  readonly held: Vec3;
  readonly ready: Vec3;
}

export interface ShotCameraConfig {
  readonly pickupSeconds: number;
  readonly walkupSeconds: number;
  readonly alignLimit: number;
}

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

const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});

const lerpPose = (a: CameraPose, b: CameraPose, t: number): CameraPose => ({
  pos: lerpVec(a.pos, b.pos, t),
  lookAt: lerpVec(a.lookAt, b.lookAt, t),
  fov: lerp(a.fov, b.fov, t),
});

const shiftX = (pose: CameraPose, dx: number): CameraPose => ({
  pos: { x: pose.pos.x + dx, y: pose.pos.y, z: pose.pos.z },
  lookAt: { x: pose.lookAt.x + dx, y: pose.lookAt.y, z: pose.lookAt.z },
  fov: pose.fov,
});

export class ShotCamera {
  private phase: ShotPhase = 'locked';
  private elapsed = 0;
  private align = 0;

  constructor(
    private readonly returnPose: CameraPose,
    private readonly linePose: CameraPose,
    private readonly cfg: ShotCameraConfig,
    private readonly ball: BallPath,
  ) {}

  // Begin a fresh shot sequence at the ball return.
  start(): void {
    this.phase = 'pickup';
    this.elapsed = 0;
    this.align = 0;
  }

  // Shift the stance left/right while aligning (metres, clamped to the limit).
  nudgeAlign(dx: number): void {
    if (this.phase !== 'align') return;
    this.align = Math.max(-this.cfg.alignLimit, Math.min(this.cfg.alignLimit, this.align + dx));
  }

  // Confirm the line and settle into the shooting pose.
  lock(): void {
    if (this.phase === 'align') this.phase = 'locked';
  }

  get currentPhase(): ShotPhase {
    return this.phase;
  }

  // The lateral stance offset chosen during alignment (metres).
  get alignment(): number {
    return this.align;
  }

  get isAligning(): boolean {
    return this.phase === 'align';
  }

  // Advance the sequence and return the camera pose and carried-ball position
  // for this frame.
  update(dt: number): ShotFrame {
    if (this.phase === 'pickup') {
      this.elapsed += dt;
      const t = smoothstep(this.elapsed / this.cfg.pickupSeconds);
      if (this.elapsed >= this.cfg.pickupSeconds) {
        this.elapsed = 0;
        this.phase = 'walkup';
      }
      // Lift the ball off the return into the hands.
      return { pose: this.returnPose, ballPos: lerpVec(this.ball.rest, this.ball.held, t) };
    }
    if (this.phase === 'walkup') {
      this.elapsed += dt;
      const t = smoothstep(this.elapsed / this.cfg.walkupSeconds);
      if (this.elapsed >= this.cfg.walkupSeconds) this.phase = 'align';
      // Walk up while carrying the ball down to the foul line.
      return { pose: lerpPose(this.returnPose, this.linePose, t), ballPos: lerpVec(this.ball.held, this.ball.ready, t) };
    }
    // Align and locked sit at the line pose, shifted by the chosen stance; the
    // held ball shifts with the stance so it launches from where you lined up.
    return {
      pose: shiftX(this.linePose, this.align),
      ballPos: { x: this.ball.ready.x + this.align, y: this.ball.ready.y, z: this.ball.ready.z },
    };
  }
}
