// VibePins entry point and game loop. Boots the 3D lane scene and physics world,
// drives the shot-setup camera sequence (pickup, walk-up, align, lock), carries
// and throws the ball, and handles the placeholder controls. The full three-step
// control scheme and the scoring/reset game loop layer on in later slices.

import { createWorld3D } from './world3d.js';
import { PinSet, pinRackPositions } from './pins.js';
import { Ball, ballSpawnPosition } from './ball.js';
import { detectPins } from './detection.js';
import { ResetCycle } from './reset.js';
import { ShotCamera, canThrow } from './camera.js';
import { SweepMeter } from './meter.js';
import { DETECTION, LANE, PIN_REST_Y, POWER, RESET, SHOT_CAMERA, SPIN } from './config.js';

const canvas = document.getElementById('lane') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('VibePins: missing required <canvas id="lane"> element.');
}

const world = await createWorld3D(canvas);
const pins = new PinSet(world);
const ball = new Ball(world);

const reset = new ResetCycle({ ...RESET, restY: PIN_REST_Y });
let resetting: number[] | null = null;

// Shot-setup camera: pick the ball up at the return, walk up to the foul line,
// then shift your line and lock in before the throw (GDD 08-controls, REQ-033).
const shotCamera = new ShotCamera(
  { pos: SHOT_CAMERA.returnPos, lookAt: SHOT_CAMERA.returnLookAt, fov: SHOT_CAMERA.returnFov },
  { pos: LANE.cameraPos, lookAt: LANE.cameraLookAt, fov: LANE.cameraFov },
  SHOT_CAMERA,
  { rest: SHOT_CAMERA.ballReturnPos, held: SHOT_CAMERA.ballHeldPos, ready: ballSpawnPosition() },
);

// Step 2 of the throw: a spin/angle meter sweeps once the line is locked; one
// confirm stops it, capturing the spin (GDD 08-controls, REQ-034). The captured
// stop feeds the launch (REQ-036).
const spinMeter = new SweepMeter({ sweepsPerSecond: SPIN.sweepsPerSecond });

// Step 3 of the throw: a power meter sweeps once the spin is set; one confirm
// stops it (capturing the speed) and triggers the release (GDD 08-controls,
// REQ-035). The centred sweet spot is the best shot; the extremes are weak.
const powerMeter = new SweepMeter({ sweepsPerSecond: POWER.sweepsPerSecond });

// The ball is carried (kinematic) through the setup, then released on the throw.
let holding = false;
function beginShot(): void {
  ball.grab();
  shotCamera.start();
  holding = true;
}
beginShot();

// Controls: while aligning, A / left and D / right shift your line; a confirm
// (Space / Enter / click) locks the line and starts the spin meter; the next
// confirm stops the spin meter and starts the power meter; the next confirm
// stops the power meter and throws with the captured spin and power. N sets up a
// fresh shot; R reels the fallen pins back up. One confirm per step (REQ-037).
const ALIGN_STEP = 0.04;
function confirm(): void {
  if (shotCamera.isAligning) {
    // Lock the line and begin the spin/angle sweep.
    shotCamera.lock();
    spinMeter.start();
    return;
  }
  if (spinMeter.isSweeping) {
    // Stop the spin meter, then begin the power sweep.
    spinMeter.stop();
    powerMeter.start();
    return;
  }
  if (powerMeter.isSweeping) {
    // Stop the power meter, then throw with the captured spin and power.
    powerMeter.stop();
    if (canThrow(shotCamera.currentPhase, holding)) {
      ball.release();
      ball.launch(spinMeter.position, powerMeter.position);
      holding = false;
    }
  }
}
window.addEventListener('pointerdown', () => confirm());
window.addEventListener('keydown', (event) => {
  switch (event.code) {
    case 'ArrowLeft':
    case 'KeyA':
      shotCamera.nudgeAlign(-ALIGN_STEP);
      break;
    case 'ArrowRight':
    case 'KeyD':
      shotCamera.nudgeAlign(ALIGN_STEP);
      break;
    case 'Enter':
    case 'Space':
      event.preventDefault();
      confirm();
      break;
    case 'KeyN':
      beginShot();
      break;
    case 'KeyR':
      if (!reset.isRunning) {
        const fallen = detectPins(pins, DETECTION)
          .filter((p) => !p.standing)
          .map((p) => p.pinIndex);
        if (fallen.length > 0) {
          const settled = pins.pinStates().map((s) => s.position);
          pins.beginReset(fallen);
          reset.start('between-balls', fallen, pinRackPositions(), settled);
          resetting = fallen;
        }
      }
      break;
    default:
      break;
  }
});

let last = performance.now();
function frame(now: number): void {
  // Cap dt so a backgrounded tab resuming does not fast-forward the camera
  // sequence or destabilise physics with one huge step.
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  // Sweep the spin and power meters while they run (the cursor must keep moving
  // until the player stops it; only the running meter moves), and drive the
  // shot-setup camera each frame, carrying the ball while holding it.
  spinMeter.update(dt);
  powerMeter.update(dt);
  const { pose, ballPos } = shotCamera.update(dt);
  world.camera.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
  world.camera.lookAt(pose.lookAt.x, pose.lookAt.y, pose.lookAt.z);
  if (world.camera.fov !== pose.fov) {
    world.camera.fov = pose.fov;
    world.camera.updateProjectionMatrix();
  }
  if (holding) ball.holdAt(ballPos);

  if (resetting) {
    pins.resetStep(reset.update(dt));
    if (reset.isComplete()) {
      pins.endReset(resetting);
      resetting = null;
    }
  }

  world.step(dt);
  pins.sync();
  ball.sync();
  world.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
