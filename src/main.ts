// VibePins entry point. Boots the 3D lane scene and the physics world, then
// runs a render loop. Gameplay systems (ball, pins, controls, scoring) layer
// onto this World3D in later slices.

import { createWorld3D } from './world3d.js';

const canvas = document.getElementById('lane') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('VibePins: missing required <canvas id="lane"> element.');
}

const world = await createWorld3D(canvas);

let last = performance.now();
function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  world.step(dt);
  world.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
