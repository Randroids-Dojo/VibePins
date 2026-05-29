// VibePins entry point and game loop. Boots the 3D lane scene and physics world,
// drives the shot-setup camera sequence (pickup, walk-up, align, lock), runs the
// three-step throw (line-up, spin, power), then orchestrates the full game loop:
// watch the thrown ball, wait for the rack to settle, count this ball's pinfall,
// feed the pure Game spine, run the string-pinsetter reset between balls or a
// full re-rack at frame end, advance through three balls per frame and ten
// frames, and show the end-of-game summary (GDD 02-core-loop, F-008).
//
// The app shell wraps that loop in a screen state machine (src/screens.ts):
// the game boots to a title menu, Play starts a fresh game, and game-over lands
// on a summary screen with play-again / main-menu (GDD 06-reuse-and-tech,
// REQ-045). Player settings (audio enable) persist via src/settings.ts (REQ-046).

import { createWorld3D } from './world3d.js';
import { PinSet, pinRackPositions } from './pins.js';
import { Ball, ballSpawnPosition } from './ball.js';
import { detectPins, SettleWindow } from './detection.js';
import { ResetCycle, type ResetMode } from './reset.js';
import { ShotCamera, canThrow } from './camera.js';
import { SweepMeter } from './meter.js';
import { Game } from './game.js';
import { Scoreboard } from './scoreboard.js';
import { ShotWatcher } from './shot.js';
import { Screens, type Screen } from './screens.js';
import { Settings } from './settings.js';
import { AudioEngine } from './audio.js';
import { DETECTION, LANE, PIN_REST_Y, POWER, RESET, SHOT, SHOT_CAMERA, SPIN } from './config.js';

const canvas = document.getElementById('lane') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('VibePins: missing required <canvas id="lane"> element.');
}
const scoreboardEl = document.getElementById('scoreboard');
const statusEl = document.getElementById('status');

// App-shell overlays (REQ-045). The menu and summary screens gate the live game.
const menuEl = document.getElementById('menu');
const summaryEl = document.getElementById('summary');
const summaryScoreEl = document.getElementById('summary-score');
const menuPlayBtn = document.getElementById('menu-play');
const menuAudioBtn = document.getElementById('menu-audio');
const summaryAgainBtn = document.getElementById('summary-again');
const summaryMenuBtn = document.getElementById('summary-menu');

const world = await createWorld3D(canvas);
const pins = new PinSet(world);
const ball = new Ball(world);

// The pure game spine: tracks frames/balls, decides re-racks, and scores. It has
// no reset of its own, so a new game replaces this instance (see restartGame).
let game = new Game();
const scoreboard = scoreboardEl ? new Scoreboard(scoreboardEl) : null;

const reset = new ResetCycle({ ...RESET, restY: PIN_REST_Y });
const settle = new SettleWindow(DETECTION, DETECTION.settleAtRestFrames, DETECTION.settleMaxFrames);
const shotWatcher = new ShotWatcher(SHOT);

// Shot-setup camera: pick the ball up at the return, walk up to the foul line,
// then shift your line and lock in before the throw (GDD 08-controls, REQ-033).
const shotCamera = new ShotCamera(
  { pos: SHOT_CAMERA.returnPos, lookAt: SHOT_CAMERA.returnLookAt, fov: SHOT_CAMERA.returnFov },
  { pos: LANE.cameraPos, lookAt: LANE.cameraLookAt, fov: LANE.cameraFov },
  SHOT_CAMERA,
  { rest: SHOT_CAMERA.ballReturnPos, held: SHOT_CAMERA.ballHeldPos, ready: ballSpawnPosition() },
);

// Step 2 and 3 of the throw: a spin/angle meter then a power meter, each a single
// sweep stopped by one confirm (GDD 08-controls, REQ-034, REQ-035). The captured
// stops feed the launch (REQ-036).
const spinMeter = new SweepMeter({ sweepsPerSecond: SPIN.sweepsPerSecond });
const powerMeter = new SweepMeter({ sweepsPerSecond: POWER.sweepsPerSecond });

// Phases of one shot through the loop:
//   aiming   the player lines up, sets spin, sets power, then throws.
//   watching the ball is in flight; wait for it to resolve (rest or pit).
//   settling the rack is settling; wait, then count pinfall and record it.
//   resetting the pinsetter is reeling fallen pins or re-racking.
//   over      the game is complete; the summary is shown.
type Phase = 'aiming' | 'watching' | 'settling' | 'resetting' | 'over';
let phase: Phase = 'aiming';

// App shell: the top-level screen state machine (menu / playing / summary) and
// the persisted settings (audio enable). The shell gates the live shot loop so
// the game boots to a title menu and lands on a summary screen, rather than
// dropping straight into play (REQ-045, REQ-046).
const screens = new Screens('menu');
const settings = new Settings();

// Procedural Web Audio engine (REQ-043). It synthesizes pin clatter, ball roll,
// the string-reset whir, and the strike/spare stings. It starts at the persisted
// audio-enable setting and is lazily initialized + resumed on the first user
// gesture (browsers block audio until then). Sound is the machine's voice; see
// GDD 04-look-and-feel.
const audio = new AudioEngine(settings.audioEnabled);

// Wake the audio context on the first gesture and keep it resumed thereafter.
// Both pointer and key paths route through here so any confirm/menu interaction
// unblocks sound.
function wakeAudio(): void {
  audio.init();
  audio.resume();
}

// Pins standing before the current ball was thrown, so pinfall = before - after.
let standingBeforeBall = 10;
// The pin indices the active reset is carrying (handed back when it completes).
let resetTargets: number[] | null = null;

const ALIGN_STEP = 0.04;

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function renderScore(): void {
  scoreboard?.render(game.score);
}

// Begin a fresh shot: carry the ball to the return and start the walk-up. Set
// the standing-before count so the next pinfall reading is a delta against it.
function beginShot(): void {
  ball.respawn();
  ball.grab();
  shotCamera.start();
  standingBeforeBall = countStandingPins();
  phase = 'aiming';
  setStatus(shotStatus());
}

function shotStatus(): string {
  return `Frame ${game.currentFrame + 1} - Ball ${game.currentBall} - Aim, spin, power. Space/click to confirm.`;
}

function countStandingPins(): number {
  return detectPins(pins, DETECTION).filter((p) => p.standing).length;
}

// Start a reset cycle in the given mode, making the carried pins kinematic.
function startReset(mode: ResetMode): void {
  const fallen =
    mode === 'rerack'
      ? pinRackPositions().map((_, i) => i)
      : detectPins(pins, DETECTION)
          .filter((p) => !p.standing)
          .map((p) => p.pinIndex);
  const settled = pins.pinStates().map((s) => s.position);
  if (fallen.length === 0) {
    // Nothing to reel (a clean miss between balls): skip straight to the next shot.
    beginShot();
    return;
  }
  pins.beginReset(fallen);
  reset.start(mode, fallen, pinRackPositions(), settled);
  // The pinsetter's signature voice: servo whir, taut cords, relay clicks, the
  // rack thunking home (REQ-043).
  audio.playStringReset();
  resetTargets = fallen;
  phase = 'resetting';
}

// The throw: release the ball with the captured spin and power, then start
// watching it. One confirm per step drives the aiming phase (REQ-037).
function throwBall(): void {
  ball.release();
  ball.launch(spinMeter.position, powerMeter.position);
  // The ball leaves the hand and meets the lane: a release thunk plus a rumble
  // down the wood (REQ-043).
  audio.playBallThunk();
  audio.playBallRoll();
  shotWatcher.begin();
  phase = 'watching';
  setStatus('Rolling...');
}

function confirm(): void {
  // Only the live game consumes a confirm. On the menu or summary screen the
  // overlay buttons drive the flow, so a stray tap/key on the canvas is ignored.
  if (screens.screen !== 'playing') return;
  if (phase !== 'aiming') return;

  if (shotCamera.isAligning) {
    shotCamera.lock();
    audio.playClick();
    spinMeter.start();
    return;
  }
  if (spinMeter.isSweeping) {
    spinMeter.stop();
    audio.playClick();
    powerMeter.start();
    return;
  }
  if (powerMeter.isSweeping) {
    powerMeter.stop();
    audio.playClick();
    if (canThrow(shotCamera.currentPhase, true)) throwBall();
  }
}

// Start a brand-new game from the menu or the summary. The Game spine has no
// reset; replace it with a fresh one, clear the scoreboard, re-rack the deck,
// and start the first shot.
function startNewGame(): void {
  game = new Game();
  phase = 'aiming';
  renderScore();
  startReset('rerack');
}

// Reflect the audio-enable setting on the menu toggle (label + accessible state).
function syncAudioToggle(): void {
  if (!menuAudioBtn) return;
  const on = settings.audioEnabled;
  menuAudioBtn.setAttribute('aria-pressed', String(on));
  menuAudioBtn.textContent = `Audio: ${on ? 'On' : 'Off'}`;
}

// The single shell view layer: show exactly one overlay per screen and (un)pause
// the status line. The live game owns the canvas; menu/summary cover it.
function showScreen(screen: Screen): void {
  const isMenu = screen === 'menu';
  const isSummary = screen === 'summary';
  if (menuEl) menuEl.hidden = !isMenu;
  if (summaryEl) summaryEl.hidden = !isSummary;
  if (isMenu) {
    syncAudioToggle();
    setStatus('');
  }
}

screens.onChange((screen) => {
  showScreen(screen);
  if (screen === 'playing') startNewGame();
});

// Menu and summary controls (mouse / touch / keyboard via native button
// activation, REQ-037 and RULE 10). Each maps to one screen transition.
menuPlayBtn?.addEventListener('click', () => {
  wakeAudio();
  audio.playClick();
  screens.start();
});
summaryAgainBtn?.addEventListener('click', () => {
  audio.playClick();
  screens.playAgain();
});
summaryMenuBtn?.addEventListener('click', () => {
  audio.playClick();
  screens.toMenu();
});
menuAudioBtn?.addEventListener('click', () => {
  // Toggling is a gesture: wake the context so the engine can sound when turned
  // on, then mirror the persisted setting into the live engine.
  wakeAudio();
  const on = settings.toggleAudio();
  audio.setEnabled(on);
  syncAudioToggle();
  if (on) audio.playClick();
});

window.addEventListener('pointerdown', () => {
  wakeAudio();
  confirm();
});
window.addEventListener('keydown', (event) => {
  wakeAudio();
  switch (event.code) {
    case 'ArrowLeft':
    case 'KeyA':
      if (screens.screen === 'playing' && phase === 'aiming') shotCamera.nudgeAlign(-ALIGN_STEP);
      break;
    case 'ArrowRight':
    case 'KeyD':
      if (screens.screen === 'playing' && phase === 'aiming') shotCamera.nudgeAlign(ALIGN_STEP);
      break;
    case 'Enter':
    case 'Space':
      event.preventDefault();
      confirm();
      break;
    default:
      break;
  }
});

// Boot to the title menu (REQ-045). The scene renders behind the overlay; the
// shot loop stays idle until the player presses Play, which fires the screens
// listener and runs startNewGame().
renderScore();
showScreen(screens.screen);

let last = performance.now();
function frame(now: number): void {
  // Cap dt so a backgrounded tab resuming does not fast-forward the camera
  // sequence or destabilise physics with one huge step.
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  // The shot loop only advances while the game is on screen. On the menu and
  // summary the scene keeps rendering behind the overlay, but no shot, camera
  // sweep, or settle runs (REQ-045). startNewGame() begins the first shot when
  // the player presses Play.
  if (screens.screen === 'playing') stepShotLoop(dt);

  world.step(dt);
  pins.sync();
  ball.sync();
  world.render();
  requestAnimationFrame(frame);
}

// One tick of the live shot phase machine. Split from frame() so the menu/
// summary guard reads as a single condition rather than wrapping the whole body.
function stepShotLoop(dt: number): void {
  if (phase === 'aiming') {
    // Only the running meter sweeps; the camera carries the held ball.
    spinMeter.update(dt);
    powerMeter.update(dt);
    const { pose, ballPos } = shotCamera.update(dt);
    applyCameraPose(pose);
    ball.holdAt(ballPos);
  } else if (phase === 'watching') {
    const k = ball.kinematics();
    if (shotWatcher.step(k.speed, k.z)) {
      // The ball has resolved; begin settling the rack before counting.
      settle.reset();
      phase = 'settling';
      setStatus('Counting pins...');
    }
  } else if (phase === 'settling') {
    const result = settle.step(pins.pinStates());
    if (result.settled) recordSettledBall(result.standingCount);
  } else if (phase === 'resetting') {
    pins.resetStep(reset.update(dt));
    if (reset.isComplete()) {
      if (resetTargets) pins.endReset(resetTargets);
      resetTargets = null;
      beginShot();
    }
  }
}

function applyCameraPose(pose: { pos: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number }; fov: number }): void {
  world.camera.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
  world.camera.lookAt(pose.lookAt.x, pose.lookAt.y, pose.lookAt.z);
  if (world.camera.fov !== pose.fov) {
    world.camera.fov = pose.fov;
    world.camera.updateProjectionMatrix();
  }
}

// The rack has settled: count this ball's pinfall (the drop in standing pins),
// feed it to the Game spine, render the new score, and act on the outcome.
function recordSettledBall(standingNow: number): void {
  const pinsDowned = Math.max(0, standingBeforeBall - standingNow);
  const result = game.recordBall(pinsDowned);
  renderScore();

  // Mechanical feedback for the count (REQ-043). Pins falling clatter (louder for
  // a bigger count); clearing the rack rings a flourish: the bigger strike sting
  // when the first ball takes all ten, the smaller spare cue otherwise.
  if (result.pinsDowned > 0) audio.playPinClatter(result.pinsDowned);
  if (result.pinsStanding === 0) {
    if (result.ballInFrame === 1 && result.pinsDowned === 10) audio.playStrike();
    else audio.playSpare();
  }

  if (result.outcome === 'game-over') {
    phase = 'over';
    const summary = game.summary();
    const finalScore = summary?.finalScore ?? 0;
    setStatus(`Game over. Final score ${finalScore}.`);
    if (summaryScoreEl) summaryScoreEl.textContent = String(finalScore);
    // Hand off to the shell: show the summary screen with play-again / menu.
    screens.finish();
    return;
  }

  // The Game spine returns 'between-balls' (lift only fallen pins, REQ-009) or
  // 'rerack' (full re-rack at frame end, REQ-010); 'none' only accompanies the
  // game-over outcome handled above, so the remaining values are valid ResetModes.
  if (result.reset !== 'none') startReset(result.reset);
}

requestAnimationFrame(frame);
