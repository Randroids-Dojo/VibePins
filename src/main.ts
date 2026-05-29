// VibePins entry point. Boots the 3D lane scene and the physics world, then
// runs a render loop. Gameplay systems (ball, pins, controls, scoring) layer
// onto this World3D in later slices.

import { createWorld3D } from './world3d.js';
import { PinSet, pinRackPositions } from './pins.js';
import { Ball } from './ball.js';
import { detectPins } from './detection.js';
import { ResetCycle } from './reset.js';
import { DETECTION, PIN_REST_Y, RESET } from './config.js';

const canvas = document.getElementById('lane') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('VibePins: missing required <canvas id="lane"> element.');
}

const world = await createWorld3D(canvas);
const pins = new PinSet(world);
const ball = new Ball(world);
ball.launch();

const reset = new ResetCycle({ ...RESET, restY: PIN_REST_Y });
let resetting: number[] | null = null;

// Minimal manual controls (placeholders ahead of the real game loop): a tap,
// click, or Space sends a fresh ball down-lane (REQ-029); R reels the currently
// fallen pins back up and respots them (REQ-018). The automated settle, reset,
// and scoring loop is a later slice.
window.addEventListener('pointerdown', () => ball.reroll());
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    ball.reroll();
  } else if (event.code === 'KeyR' && !reset.isRunning) {
    const fallen = detectPins(pins, DETECTION).filter((p) => !p.standing).map((p) => p.pinIndex);
    if (fallen.length > 0) {
      const settled = pins.pinStates().map((s) => s.position);
      pins.beginReset(fallen);
      reset.start('between-balls', fallen, pinRackPositions(), settled);
      resetting = fallen;
    }
  }
});

let last = performance.now();
function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  if (resetting) {
    pins.resetStep(reset.update(dt)); // carry the pins before stepping
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
