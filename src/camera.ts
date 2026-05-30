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

// Which spin/power gauge (if any) the HUD should show this frame. Pure, so the
// show/hide decision is testable without the DOM (RULE 10).
//
// The gauges belong only to the timed steps of the throw, which run once the
// line is locked. While the ball loads at the return and the bowler walks up
// (camera 'pickup' / 'walkup') and while the player is still shifting the line
// ('align', which shows the line-up indicator instead), neither gauge shows,
// even though the shot phase is already 'aiming'. This is playtest bug 6: the
// meters must appear only when it is time to aim, not during the loading walk-up
// or the line-up step.
//
// Once locked: show the spin gauge while the spin meter sweeps or holds before
// the power step, then swap to the power gauge once the power meter sweeps.
export interface MetersVisibility {
  readonly showSpin: boolean;
  readonly showPower: boolean;
}

export function shotMetersVisibility(
  aiming: boolean,
  cameraPhase: ShotPhase,
  powerSweeping: boolean,
): MetersVisibility {
  // Only after the line is locked do the timed spin/power steps run. This keeps
  // the gauges off the screen during the loading walk-up and the line-up step.
  const ready = aiming && cameraPhase === 'locked';
  const showPower = ready && powerSweeping;
  const showSpin = ready && !powerSweeping;
  return { showSpin, showPower };
}

// Line-up indicator geometry (REQ-033 step 1). The marker slides across the
// rail span of the track (the track minus a rail inset on each end). These two
// pure maps convert between the normalized [-1, +1] stance fraction and a pixel
// offset along the track, so the indicator render and the drag-to-aim handler
// share one source of truth and stay unit-testable without a DOM.

// Pixel offset of the marker centre from the track's left edge, for a stance
// fraction in [-1, +1]. -1 sits at the left end of the rail span, +1 at the
// right end. The fraction is clamped so an out-of-range value stays on track.
export function lineupMarkerOffset(fraction: number, trackWidth: number, railInset: number): number {
  const clamped = Math.max(-1, Math.min(1, fraction));
  const span = Math.max(0, trackWidth - railInset * 2);
  return railInset + ((clamped + 1) / 2) * span;
}

// Inverse of lineupMarkerOffset: a pointer x within the track maps back to a
// stance fraction in [-1, +1]. Caller clamps via setAlignFraction; this returns
// the raw mapped value so the edges of the track reach the limits cleanly.
export function lineupFractionFromOffset(offsetX: number, trackWidth: number, railInset: number): number {
  const span = Math.max(1, trackWidth - railInset * 2);
  return ((offsetX - railInset) / span) * 2 - 1;
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

// Step the bowler laterally into the chosen stance: translate the camera eye in
// x by dx while keeping the look-at anchored on the down-lane aim point. Because
// the eye slides but the target down-lane stays fixed, the gaze swings across the
// lane and the pin deck visibly reframes from the bowler POV. (A naive parallel
// slide that moved the far look-at by the same dx would barely change the framing
// over the ~20 m sight line, so the step would read as no movement.)
const shiftX = (pose: CameraPose, dx: number): CameraPose => ({
  pos: { x: pose.pos.x + dx, y: pose.pos.y, z: pose.pos.z },
  lookAt: { x: pose.lookAt.x, y: pose.lookAt.y, z: pose.lookAt.z },
  fov: pose.fov,
});

// Ball-cam chase pose (optional follow-cam, REQ-033 polish). When the player has
// the Ball Cam setting on, the watching-phase camera tracks the thrown ball down
// the lane instead of holding the fixed bowler view. This pure helper produces the
// pose for a given ball position: the eye sits behind the ball (toward the bowler,
// +z) and above it, and the look-at is anchored down-lane ahead of the ball
// (toward the pins, -z), so the camera reads as a chase cam riding behind the roll.
// Pure and unit-testable: as the ball's z decreases (rolls toward the pins) the
// camera's z decreases with it, which is the observable tracking the test asserts.
export interface ChaseCamConfig {
  // How far behind the ball (toward the bowler, +z) the eye sits, in metres.
  readonly behind: number;
  // How high above the ball the eye sits, in metres.
  readonly height: number;
  // How far ahead of the ball (toward the pins, -z) the look-at is anchored.
  readonly ahead: number;
  // Height of the look-at point above the lane bed, in metres.
  readonly lookHeight: number;
  // Field of view for the chase view.
  readonly fov: number;
}

export function chaseCamPose(ballPos: Vec3, cfg: ChaseCamConfig): CameraPose {
  return {
    pos: { x: ballPos.x, y: ballPos.y + cfg.height, z: ballPos.z + cfg.behind },
    lookAt: { x: ballPos.x, y: cfg.lookHeight, z: ballPos.z - cfg.ahead },
    fov: cfg.fov,
  };
}

// Frame-rate-independent damping toward a target: at rate r and step dt the gap
// shrinks by 1 - e^(-r*dt), so the easing is smooth and stable regardless of frame
// timing (RULE 10 smooth, not jarring). Exported so the follow stepper and any
// caller share one easing rule.
export function dampTo(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

const dampPose = (current: CameraPose, target: CameraPose, rate: number, dt: number): CameraPose => ({
  pos: {
    x: dampTo(current.pos.x, target.pos.x, rate, dt),
    y: dampTo(current.pos.y, target.pos.y, rate, dt),
    z: dampTo(current.pos.z, target.pos.z, rate, dt),
  },
  lookAt: {
    x: dampTo(current.lookAt.x, target.lookAt.x, rate, dt),
    y: dampTo(current.lookAt.y, target.lookAt.y, rate, dt),
    z: dampTo(current.lookAt.z, target.lookAt.z, rate, dt),
  },
  fov: dampTo(current.fov, target.fov, rate, dt),
});

// The damped ball-cam follower (REQ-033 polish). Each watching frame it eases the
// held pose toward the chase target for the live ball position, so the camera
// rides behind the rolling ball and tracks it down the lane. The first frame after
// a reset seeds directly on the target (framed on the ball, no snap-in from a stale
// pose); reset() drops the held pose so the next shot re-seeds. Pure: no Three.js,
// no clock, fully unit-testable for the observable over-time tracking (RULE 10).
export class ChaseCam {
  private pose: CameraPose | null = null;

  constructor(
    private readonly cfg: ChaseCamConfig,
    private readonly rate: number,
  ) {}

  // Forget the current follow so the next step re-seeds on the ball. Called when
  // the ball resolves and the watching phase ends.
  reset(): void {
    this.pose = null;
  }

  // Ease the follow toward the chase target for the ball position and return the
  // pose to apply this frame.
  step(ballPos: Vec3, dt: number): CameraPose {
    const target = chaseCamPose(ballPos, this.cfg);
    this.pose = this.pose ? dampPose(this.pose, target, this.rate, dt) : target;
    return this.pose;
  }
}

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

  // Set the stance directly from a normalized [-1, +1] track position (pointer /
  // touch drag along the line-up indicator). -1 is the far-left stance, +1 the
  // far-right; the value is clamped to the track before mapping to metres.
  setAlignFraction(fraction: number): void {
    if (this.phase !== 'align') return;
    const clamped = Math.max(-1, Math.min(1, fraction));
    this.align = clamped * this.cfg.alignLimit;
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

  // The chosen stance as a normalized [-1, +1] track position, for rendering the
  // line-up indicator. 0 is centre, -1 the far-left limit, +1 the far-right.
  get alignFraction(): number {
    return this.align / this.cfg.alignLimit;
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
