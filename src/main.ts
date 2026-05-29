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
import { DETECTION, LANE, PIN_REST_Y, RESET, SHOT_CAMERA } from './config.js';

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

// The ball is carried (kinematic) through the setup, then released on the throw.
let holding = false;
function beginShot(): void {
  ball.grab();
  shotCamera.start();
  holding = true;
}
beginShot();

// Controls (placeholders ahead of the full three-step scheme): while aligning,
// A / left and D / right shift your line and Enter locks it in; when locked,
// Space or click throws; N sets up a fresh shot; R reels the fallen pins back up.
const ALIGN_STEP = 0.04;
function throwBall(): void {
  if (canThrow(shotCamera.currentPhase, holding)) {
    ball.release();
    ball.launch();
    holding = false;
  }
}
window.addEventListener('pointerdown', () => throwBall());
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
      shotCamera.lock();
      break;
    case 'Space':
      event.preventDefault();
      throwBall();
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

  // Drive the shot-setup camera each frame, and carry the ball while holding it.
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
