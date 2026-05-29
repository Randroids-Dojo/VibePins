// VibePins entry point. Boots the 3D lane scene and the physics world, then
// runs a render loop. Gameplay systems (ball, pins, controls, scoring) layer
// onto this World3D in later slices.

import { createWorld3D } from './world3d.js';
import { PinSet } from './pins.js';
import { Ball } from './ball.js';

const canvas = document.getElementById('lane') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('VibePins: missing required <canvas id="lane"> element.');
}

const world = await createWorld3D(canvas);
const pins = new PinSet(world);
const ball = new Ball(world);
ball.launch();

// Minimal re-roll: a tap, click, or Space sends a fresh ball down-lane. The
// three-step aim/spin/power control scheme is a later slice (REQ-033 to REQ-036).
window.addEventListener('pointerdown', () => ball.reroll());
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    ball.reroll();
  }
});

let last = performance.now();
function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  world.step(dt);
  pins.sync();
  ball.sync();
  world.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
