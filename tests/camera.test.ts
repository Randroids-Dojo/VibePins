import { describe, it, expect } from 'vitest';
import {
  ShotCamera,
  canThrow,
  lineupMarkerOffset,
  lineupFractionFromOffset,
  shotMetersVisibility,
  chaseCamPose,
  ChaseCam,
  type BallPath,
  type CameraPose,
  type ChaseCamConfig,
  type ShotCameraConfig,
} from '../src/camera.js';

const returnPose: CameraPose = { pos: { x: 0.45, y: 1.55, z: 2.75 }, lookAt: { x: 0.62, y: 0.7, z: 2.25 }, fov: 55 };
const linePose: CameraPose = { pos: { x: 0, y: 1.5, z: 2.2 }, lookAt: { x: 0, y: 0.4, z: -18.3 }, fov: 30 };
const cfg: ShotCameraConfig = { pickupSeconds: 1, walkupSeconds: 1, alignLimit: 0.3 };
const ball: BallPath = {
  rest: { x: 0.45, y: 0.18, z: 2.5 },
  held: { x: 0.78, y: 0.92, z: 2.35 },
  ready: { x: 0, y: 0.06, z: -0.15 },
};

const make = () => new ShotCamera(returnPose, linePose, cfg, ball);

describe('ShotCamera sequence', () => {
  it('starts in pickup and holds the return pose while lifting the ball off the rest', () => {
    const sc = make();
    sc.start();
    expect(sc.currentPhase).toBe('pickup');
    const f = sc.update(0.5);
    expect(sc.currentPhase).toBe('pickup');
    expect(f.pose).toEqual(returnPose);
    // Ball has risen from the rest toward the held point (between the two in x and y).
    expect(f.ballPos.y).toBeGreaterThan(ball.rest.y);
    expect(f.ballPos.y).toBeLessThan(ball.held.y);
    expect(f.ballPos.x).toBeGreaterThan(ball.rest.x);
  });

  it('transitions pickup -> walkup -> align at the configured durations', () => {
    const sc = make();
    sc.start();
    sc.update(0.5);
    sc.update(0.6); // crosses pickupSeconds (1.1 > 1)
    expect(sc.currentPhase).toBe('walkup');
    sc.update(0.5);
    const atLine = sc.update(0.6); // crosses walkupSeconds
    expect(sc.currentPhase).toBe('align');
    // The walk-up lands exactly on the line pose and the ball at the ready spot.
    expect(atLine.pose).toEqual(linePose);
    expect(atLine.ballPos).toEqual(ball.ready);
  });

  it('carries the ball from held to ready and eases the fov during the walk-up', () => {
    const sc = make();
    sc.start();
    sc.update(1); // finish pickup, enter walkup
    const mid = sc.update(0.5); // mid walk-up
    expect(sc.currentPhase).toBe('walkup');
    expect(mid.ballPos.z).toBeLessThan(ball.held.z); // moving down-lane toward ready
    expect(mid.ballPos.z).toBeGreaterThan(ball.ready.z);
    // The fov eases from the return fov toward the line fov.
    expect(mid.pose.fov).toBeLessThan(returnPose.fov);
    expect(mid.pose.fov).toBeGreaterThan(linePose.fov);
  });
});

describe('ShotCamera alignment', () => {
  const aligned = () => {
    const sc = make();
    sc.start();
    sc.update(1); // -> walkup
    sc.update(1); // -> align
    return sc;
  };

  it('steps the eye laterally with the stance while the look-at stays anchored down-lane', () => {
    const sc = aligned();
    expect(sc.isAligning).toBe(true);
    sc.nudgeAlign(0.5); // beyond the 0.3 limit
    expect(sc.alignment).toBeCloseTo(0.3, 6);
    const f = sc.update(0);
    // The eye steps in x; height and depth of the pose are unchanged.
    expect(f.pose.pos.x).toBeCloseTo(linePose.pos.x + 0.3, 6);
    expect(f.pose.pos.y).toBe(linePose.pos.y);
    expect(f.pose.pos.z).toBe(linePose.pos.z);
    // The look-at stays anchored on the down-lane aim point so the gaze swings
    // across the lane and the framing visibly changes from the bowler POV.
    expect(f.pose.lookAt.x).toBe(linePose.lookAt.x);
    expect(f.pose.lookAt.y).toBe(linePose.lookAt.y);
    expect(f.pose.lookAt.z).toBe(linePose.lookAt.z);
    // The held ball still shifts with the stance (it is carried in the hands).
    expect(f.ballPos.x).toBeCloseTo(ball.ready.x + 0.3, 6);
    expect(f.ballPos.y).toBe(ball.ready.y);
    expect(f.ballPos.z).toBe(ball.ready.z);

    sc.nudgeAlign(-1);
    expect(sc.alignment).toBeCloseTo(-0.3, 6);
  });

  it('translates the eye monotonically across stance values (observable camera motion)', () => {
    const left = aligned();
    left.setAlignFraction(-1);
    const right = aligned();
    right.setAlignFraction(1);
    const centre = aligned();
    centre.setAlignFraction(0);
    const lx = left.update(0).pose.pos.x;
    const cx = centre.update(0).pose.pos.x;
    const rx = right.update(0).pose.pos.x;
    // Stepping right moves the eye right, stepping left moves it left, relative
    // to the centred stance: the camera physically translates with the slider.
    expect(lx).toBeLessThan(cx);
    expect(cx).toBeLessThan(rx);
    expect(rx - lx).toBeCloseTo(2 * cfg.alignLimit, 6);
  });

  it('sets the stance from a normalized track fraction, clamped to [-1, +1]', () => {
    const sc = aligned();
    sc.setAlignFraction(0.5);
    // Half a track toward +R is half the limit in metres.
    expect(sc.alignment).toBeCloseTo(0.15, 6);
    expect(sc.alignFraction).toBeCloseTo(0.5, 6);

    sc.setAlignFraction(2); // beyond the track end
    expect(sc.alignment).toBeCloseTo(0.3, 6);
    expect(sc.alignFraction).toBeCloseTo(1, 6);

    sc.setAlignFraction(-3);
    expect(sc.alignment).toBeCloseTo(-0.3, 6);
    expect(sc.alignFraction).toBeCloseTo(-1, 6);

    // Centre is zero stance.
    sc.setAlignFraction(0);
    expect(sc.alignment).toBe(0);
    expect(sc.alignFraction).toBe(0);
  });

  it('reports alignFraction consistently with nudgeAlign', () => {
    const sc = aligned();
    sc.nudgeAlign(0.15); // half the 0.3 limit
    expect(sc.alignFraction).toBeCloseTo(0.5, 6);
  });

  it('ignores setAlignFraction outside the align phase', () => {
    const sc = make();
    sc.start(); // pickup
    sc.setAlignFraction(1);
    expect(sc.alignment).toBe(0);
    expect(sc.alignFraction).toBe(0);
  });

  it('only aligns during the align phase', () => {
    const sc = make();
    sc.start(); // pickup
    sc.nudgeAlign(0.2);
    expect(sc.alignment).toBe(0);
  });

  it('locks only from the align phase, then holds the shooting pose', () => {
    const sc = make();
    sc.start();
    sc.lock(); // ignored during pickup
    expect(sc.currentPhase).toBe('pickup');

    const ready = aligned();
    ready.nudgeAlign(0.1);
    ready.lock();
    expect(ready.currentPhase).toBe('locked');
    const f = ready.update(0.016);
    expect(f.pose.pos.x).toBeCloseTo(linePose.pos.x + 0.1, 6);
    expect(f.pose.fov).toBe(linePose.fov);
    ready.nudgeAlign(0.1); // no longer aligning
    expect(ready.alignment).toBeCloseTo(0.1, 6);
    ready.lock(); // locking again is a no-op
    expect(ready.currentPhase).toBe('locked');
  });
});

describe('line-up indicator geometry (REQ-033 step 1)', () => {
  // A 420px track with a 20px rail inset on each end: the marker travels the
  // 380px span between 20 and 400.
  const W = 420;
  const INSET = 20;

  it('places the marker across the rail span as the fraction moves', () => {
    expect(lineupMarkerOffset(-1, W, INSET)).toBeCloseTo(20, 6); // far-left end
    expect(lineupMarkerOffset(0, W, INSET)).toBeCloseTo(210, 6); // centre
    expect(lineupMarkerOffset(1, W, INSET)).toBeCloseTo(400, 6); // far-right end
  });

  it('moves the marker monotonically with the stance (observable motion)', () => {
    const left = lineupMarkerOffset(-0.5, W, INSET);
    const mid = lineupMarkerOffset(0, W, INSET);
    const right = lineupMarkerOffset(0.5, W, INSET);
    expect(left).toBeLessThan(mid);
    expect(mid).toBeLessThan(right);
  });

  it('clamps an out-of-range fraction to the track ends', () => {
    expect(lineupMarkerOffset(-5, W, INSET)).toBeCloseTo(20, 6);
    expect(lineupMarkerOffset(5, W, INSET)).toBeCloseTo(400, 6);
  });

  it('maps a pointer offset back to a stance fraction', () => {
    expect(lineupFractionFromOffset(20, W, INSET)).toBeCloseTo(-1, 6);
    expect(lineupFractionFromOffset(210, W, INSET)).toBeCloseTo(0, 6);
    expect(lineupFractionFromOffset(400, W, INSET)).toBeCloseTo(1, 6);
  });

  it('round-trips fraction -> offset -> fraction', () => {
    for (const f of [-1, -0.4, 0, 0.27, 1]) {
      const offset = lineupMarkerOffset(f, W, INSET);
      expect(lineupFractionFromOffset(offset, W, INSET)).toBeCloseTo(f, 6);
    }
  });
});

describe('shotMetersVisibility (playtest bug 6: hide gauges during loading)', () => {
  it('hides both gauges during the loading walk-up even while aiming', () => {
    for (const phase of ['pickup', 'walkup'] as const) {
      const v = shotMetersVisibility(true, phase, false);
      expect(v.showSpin).toBe(false);
      expect(v.showPower).toBe(false);
    }
  });

  it('hides both gauges during the line-up step (the indicator shows instead)', () => {
    const v = shotMetersVisibility(true, 'align', false);
    expect(v.showSpin).toBe(false);
    expect(v.showPower).toBe(false);
  });

  it('shows the spin gauge once locked before the power step', () => {
    const v = shotMetersVisibility(true, 'locked', false);
    expect(v.showSpin).toBe(true);
    expect(v.showPower).toBe(false);
  });

  it('swaps to the power gauge once the power meter sweeps', () => {
    const v = shotMetersVisibility(true, 'locked', true);
    expect(v.showSpin).toBe(false);
    expect(v.showPower).toBe(true);
  });

  it('hides both gauges outside the aiming phase', () => {
    const v = shotMetersVisibility(false, 'locked', false);
    expect(v.showSpin).toBe(false);
    expect(v.showPower).toBe(false);
  });
});

describe('canThrow guard', () => {
  it('allows a throw only when locked and still holding the ball', () => {
    expect(canThrow('locked', true)).toBe(true);
    expect(canThrow('locked', false)).toBe(false); // already thrown
    expect(canThrow('align', true)).toBe(false);
    expect(canThrow('pickup', true)).toBe(false);
    expect(canThrow('walkup', true)).toBe(false);
  });
});

describe('chaseCamPose ball-cam follow (REQ-033 polish)', () => {
  const cfg: ChaseCamConfig = { behind: 1.3, height: 0.9, ahead: 4, lookHeight: 0.4, fov: 40 };

  it('sits behind and above the ball, looking down-lane ahead of it', () => {
    const pose = chaseCamPose({ x: 0, y: 0.06, z: -5 }, cfg);
    // Eye is behind the ball (toward the bowler, +z) and above it.
    expect(pose.pos.z).toBeGreaterThan(-5);
    expect(pose.pos.z).toBeCloseTo(-5 + cfg.behind);
    expect(pose.pos.y).toBeCloseTo(0.06 + cfg.height);
    // Look-at is ahead of the ball, toward the pins (more negative z).
    expect(pose.lookAt.z).toBeLessThan(-5);
    expect(pose.lookAt.z).toBeCloseTo(-5 - cfg.ahead);
    expect(pose.lookAt.y).toBeCloseTo(cfg.lookHeight);
    expect(pose.fov).toBe(cfg.fov);
  });

  it('tracks the ball down-lane: as the ball z decreases, the camera z decreases with it', () => {
    // The lane runs from the bowler (z positive) toward the pins (z ~ -18). A ball
    // rolling down-lane has a decreasing z over time; the chase camera must follow.
    const zs = [0, -3, -6, -10, -15];
    const camZs = zs.map((z) => chaseCamPose({ x: 0, y: 0.06, z }, cfg).pos.z);
    for (let i = 1; i < camZs.length; i++) {
      expect(camZs[i]).toBeLessThan(camZs[i - 1]);
    }
  });

  it('follows lateral ball drift (a hooking ball pulls the camera sideways)', () => {
    const left = chaseCamPose({ x: -0.3, y: 0.06, z: -8 }, cfg);
    const right = chaseCamPose({ x: 0.3, y: 0.06, z: -8 }, cfg);
    expect(left.pos.x).toBeCloseTo(-0.3);
    expect(right.pos.x).toBeCloseTo(0.3);
    expect(left.lookAt.x).toBeCloseTo(-0.3);
    expect(right.lookAt.x).toBeCloseTo(0.3);
  });

  it('is pure: same ball position yields the same pose', () => {
    const a = chaseCamPose({ x: 0.1, y: 0.06, z: -7 }, cfg);
    const b = chaseCamPose({ x: 0.1, y: 0.06, z: -7 }, cfg);
    expect(a).toEqual(b);
  });
});

describe('ChaseCam damped ball-cam follow (REQ-033 polish, RULE 10 observable)', () => {
  const cfg: ChaseCamConfig = { behind: 1.3, height: 0.9, ahead: 4, lookHeight: 0.4, fov: 40 };
  const rate = 6;
  const dt = 1 / 60;

  it('seeds framed exactly on the ball on the first step (no snap-in from a stale pose)', () => {
    const cam = new ChaseCam(cfg, rate);
    const first = cam.step({ x: 0, y: 0.06, z: 0 }, dt);
    expect(first).toEqual(chaseCamPose({ x: 0, y: 0.06, z: 0 }, cfg));
  });

  it('tracks the ball down-lane over time: the camera z follows the ball z downward', () => {
    // A ball rolling down-lane reports a steadily decreasing z. Stepping the
    // follower over that sequence, the camera z must decrease too: it tracks.
    const cam = new ChaseCam(cfg, rate);
    let z = 0;
    let prevCamZ = cam.step({ x: 0, y: 0.06, z }, dt).pos.z; // seed
    const camZs: number[] = [prevCamZ];
    for (let i = 0; i < 120; i++) {
      z -= 0.12; // ball advances toward the pins each frame
      const camZ = cam.step({ x: 0, y: 0.06, z }, dt).pos.z;
      expect(camZ).toBeLessThan(prevCamZ); // strictly tracking down-lane
      prevCamZ = camZ;
      camZs.push(camZ);
    }
    // Over the run the camera has travelled a long way down-lane with the ball.
    expect(camZs[camZs.length - 1]).toBeLessThan(-10);
  });

  it('eases smoothly rather than snapping: one step closes only part of the gap', () => {
    const cam = new ChaseCam(cfg, rate);
    cam.step({ x: 0, y: 0.06, z: 0 }, dt); // seed at z=0 (camera z = behind)
    const target = chaseCamPose({ x: 0, y: 0.06, z: -10 }, cfg).pos.z;
    const after = cam.step({ x: 0, y: 0.06, z: -10 }, dt).pos.z;
    // The single small step moves toward the target but does not reach it.
    expect(after).toBeLessThan(cfg.behind); // moved down-lane
    expect(after).toBeGreaterThan(target); // but not all the way (eased)
  });

  it('re-seeds after reset so a new shot starts framed on the ball, not the last pose', () => {
    const cam = new ChaseCam(cfg, rate);
    // Follow a ball well down-lane.
    for (let z = 0; z >= -12; z -= 0.5) cam.step({ x: 0, y: 0.06, z }, dt);
    cam.reset();
    // Next shot: a fresh ball back at the foul line seeds exactly on it.
    const reseeded = cam.step({ x: 0, y: 0.06, z: 0 }, dt);
    expect(reseeded).toEqual(chaseCamPose({ x: 0, y: 0.06, z: 0 }, cfg));
  });

  it('follows lateral drift over time (a hooking ball pulls the camera sideways)', () => {
    const cam = new ChaseCam(cfg, rate);
    cam.step({ x: 0, y: 0.06, z: 0 }, dt); // seed centred
    let prevX = 0;
    for (let i = 0; i < 60; i++) {
      const x = -0.01 * (i + 1); // ball drifts left each frame
      const camX = cam.step({ x, y: 0.06, z: -i * 0.1 }, dt).pos.x;
      expect(camX).toBeLessThanOrEqual(prevX + 1e-9); // camera trails leftward
      prevX = camX;
    }
    expect(prevX).toBeLessThan(0);
  });
});
