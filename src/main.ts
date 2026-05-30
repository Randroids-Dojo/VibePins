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
import { ShotCamera, canThrow, lineupMarkerOffset, lineupFractionFromOffset } from './camera.js';
import { SweepMeter, meterBandSpan } from './meter.js';
import { Game } from './game.js';
import { Scoreboard } from './scoreboard.js';
import { ShotWatcher } from './shot.js';
import { FoulDetector } from './foul.js';
import { GutterDetector } from './gutter.js';
import { Screens, type Screen } from './screens.js';
import { Settings } from './settings.js';
import { Leaderboard, renderBoardRows, renderContextRows, type BoardType } from './leaderboard.js';
import { Tutorial } from './tutorial.js';
import { AudioEngine } from './audio.js';
import { VictoryRoutine } from './victory.js';
import { DETECTION, FOUL, GUTTER, LANE, PIN_REST_Y, POWER, RESET, SHOT, SHOT_CAMERA, SPIN, VICTORY } from './config.js';

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
const menuTutorialBtn = document.getElementById('menu-tutorial');
const menuLeaderboardBtn = document.getElementById('menu-leaderboard');
const summaryAgainBtn = document.getElementById('summary-again');
const summaryMenuBtn = document.getElementById('summary-menu');
const summaryLeaderboardBtn = document.getElementById('summary-leaderboard');

// Leaderboard standings board overlay (REQ-060/061/063). Opened from the menu
// or the summary, with an all-time/daily tab pair, and a Back button that
// returns to whichever screen opened it.
const boardEl = document.getElementById('board');
const boardListEl = document.getElementById('board-list');
const boardContextEl = document.getElementById('board-context');
const boardTabAllTimeBtn = document.getElementById('board-tab-alltime');
const boardTabDailyBtn = document.getElementById('board-tab-daily');
const boardBackBtn = document.getElementById('board-back');

// Leaderboard score submission on the summary screen (REQ-057): the name field,
// submit form/button, and the status line that reports the server rank or error.
const summarySubmitForm = document.getElementById('summary-submit') as HTMLFormElement | null;
const summaryNameInput = document.getElementById('summary-name') as HTMLInputElement | null;
const summarySubmitBtn = document.getElementById('summary-submit-btn') as HTMLButtonElement | null;
const summarySubmitStatusEl = document.getElementById('summary-submit-status');

// First-run tutorial coach panel (REQ-047).
const tutorialEl = document.getElementById('tutorial');
const tutorialStepEl = document.getElementById('tutorial-step');
const tutorialInstructionEl = document.getElementById('tutorial-instruction');

// Line-up indicator (REQ-033 step 1): the L/R track and the sliding stance
// marker. The track doubles as the touch/mouse drag surface for lateral aim.
const lineupEl = document.getElementById('lineup');
const lineupTrackEl = document.getElementById('lineup-track');
const lineupMarkerEl = document.getElementById('lineup-marker');

// Spin and power gauges (REQ-038 step 2 and step 3). The mechanical-gauge skin
// for the two sweeping meters: a needle that slides to the live cursor and a
// highlighted centred sweet-spot/straight band. Only the active step's gauge is
// shown during the aiming phase.
const metersEl = document.getElementById('meters');
const gaugeSpinEl = document.getElementById('gauge-spin');
const gaugeSpinBandEl = document.getElementById('gauge-spin-band');
const gaugeSpinNeedleEl = document.getElementById('gauge-spin-needle');
const gaugePowerEl = document.getElementById('gauge-power');
const gaugePowerBandEl = document.getElementById('gauge-power-band');
const gaugePowerNeedleEl = document.getElementById('gauge-power-needle');

// The rail inset (px) on each end of the track, matching .vp-lineup-rail's
// left/right in index.html. The marker travels across the rail span only, so
// fraction -1 sits at the left end of the rail and +1 at the right end.
const LINEUP_RAIL_INSET = 20;

// The rail inset (px) on each end of a gauge track, matching .vp-gauge-rail's
// left/right in index.html. The needle and the sweet-spot band both span the
// rail only, so a [-1, +1] cursor maps across the rail span (REQ-038).
const GAUGE_RAIL_INSET = 20;

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
// Over-the-line release detection (REQ-032). Watches the thrown ball's down-lane
// position; if the ball is ever at or in front of the foul line while live the
// throw is a foul and scores zero pinfall.
const foulDetector = new FoulDetector(FOUL);
// Gutter detection (REQ-031). Watches the thrown ball's lateral position; if the
// ball ever leaves the lane bed into a gutter channel the throw is a dead ball
// and scores zero pinfall, just like a foul.
const gutterDetector = new GutterDetector(GUTTER);

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

// Global leaderboard client (REQ-057). Posts the completed game's per-frame ball
// line to the serverless backend, which re-scores it authoritatively.
const leaderboard = new Leaderboard();
// Whether the current summary's score has already been submitted, so the player
// cannot double-post the same game.
let scoreSubmitted = false;

// Leaderboard standings board (REQ-060/061/063): the active tab and the screen
// to return to when the board's Back button is pressed (menu or summary).
let boardTab: BoardType = 'alltime';
let boardReturnVisible: 'menu' | 'summary' = 'menu';
// How many top rows the standings list shows. Also the threshold below which the
// rank-in-context block surfaces the player's own standing (REQ-062).
const BOARD_LIMIT = 20;

// First-run control tutorial (REQ-047). Armed only when the player has not seen
// it before; it advances through the three throw steps as the player confirms
// each, then retires after the first throw. The coach copy lives in src/tutorial.
const tutorial = new Tutorial(settings.tutorialSeen);

// Procedural Web Audio engine (REQ-043). It synthesizes pin clatter, ball roll,
// the string-reset whir, and the strike/spare stings. It starts at the persisted
// audio-enable setting and is lazily initialized + resumed on the first user
// gesture (browsers block audio until then). Sound is the machine's voice; see
// GDD 04-look-and-feel.
const audio = new AudioEngine(settings.audioEnabled);

// Strike victory routine (REQ-044, GDD 04-look-and-feel "juice"). A strike runs
// a brief mechanical flourish: a burst of debris flung off the deck plus a quick
// camera shake, alongside the audio strike sting. The pure sim lives in
// src/victory.ts; the visual layer (debris meshes, shake offset) lives in
// world3d. Triggered on a first-ball ten and advanced each frame below.
const victory = new VictoryRoutine(VICTORY);
// The camera's resting position captured when a victory burst starts, so the
// per-frame shake is applied as an absolute offset rather than accumulating.
let shakeBase: { x: number; y: number; z: number } | null = null;

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

// Show or hide the first-run coach panel for the tutorial's current step. When
// the tutorial is inactive (already seen, or retired after the first throw) the
// panel is hidden. Called whenever the tutorial state changes (REQ-047).
function renderTutorial(): void {
  if (!tutorialEl) return;
  const hint = tutorial.hint();
  if (!hint) {
    tutorialEl.hidden = true;
    return;
  }
  if (tutorialStepEl) tutorialStepEl.textContent = `Step ${hint.index} of ${hint.total} - ${hint.label}`;
  if (tutorialInstructionEl) tutorialInstructionEl.textContent = hint.instruction;
  tutorialEl.hidden = false;
}

// Show or hide the line-up indicator and slide its marker to the chosen stance
// (REQ-033 step 1). Visible only while the camera is in the align phase; the
// marker tracks shotCamera.alignFraction across the rail span. Called every
// aiming frame so keyboard nudges and pointer drags both reflect immediately.
function renderLineup(): void {
  if (!lineupEl || !lineupMarkerEl || !lineupTrackEl) return;
  const aligning = shotCamera.isAligning;
  lineupEl.hidden = !aligning;
  if (!aligning) return;
  const px = lineupMarkerOffset(shotCamera.alignFraction, lineupTrackEl.clientWidth, LINEUP_RAIL_INSET);
  lineupMarkerEl.style.left = `${px}px`;
}

// Show or hide the spin/power gauges and slide each needle to its meter's live
// cursor (REQ-038). During the aiming phase exactly one gauge is shown: the spin
// gauge while the spin meter sweeps or is stopped before the power step starts,
// then the power gauge while the power meter sweeps. The needle uses the same
// [-1, +1] -> rail-px map as the line-up marker; the centred band is sized from
// the tuned config so the highlight always matches the real sweet spot. Called
// every aiming frame so the sweep motion is observable (RULE 10).
function renderMeters(): void {
  if (!metersEl) return;
  const aiming = phase === 'aiming';
  const showSpin = aiming && !shotCamera.isAligning && !powerMeter.isSweeping;
  const showPower = aiming && powerMeter.isSweeping;
  metersEl.hidden = !(showSpin || showPower);
  if (gaugeSpinEl) gaugeSpinEl.hidden = !showSpin;
  if (gaugePowerEl) gaugePowerEl.hidden = !showPower;

  if (showSpin && gaugeSpinNeedleEl && gaugeSpinBandEl) {
    const track = gaugeSpinEl?.querySelector('.vp-gauge-track') as HTMLElement | null;
    const w = track?.clientWidth ?? 0;
    const band = meterBandSpan(SPIN.straightBand, w, GAUGE_RAIL_INSET);
    gaugeSpinBandEl.style.left = `${band.leftPx}px`;
    gaugeSpinBandEl.style.width = `${band.widthPx}px`;
    gaugeSpinNeedleEl.style.left = `${lineupMarkerOffset(spinMeter.position, w, GAUGE_RAIL_INSET)}px`;
  }
  if (showPower && gaugePowerNeedleEl && gaugePowerBandEl) {
    const track = gaugePowerEl?.querySelector('.vp-gauge-track') as HTMLElement | null;
    const w = track?.clientWidth ?? 0;
    const band = meterBandSpan(POWER.sweetSpotBand, w, GAUGE_RAIL_INSET);
    gaugePowerBandEl.style.left = `${band.leftPx}px`;
    gaugePowerBandEl.style.width = `${band.widthPx}px`;
    gaugePowerNeedleEl.style.left = `${lineupMarkerOffset(powerMeter.position, w, GAUGE_RAIL_INSET)}px`;
  }
}

// Map a pointer x (clientX) on the line-up track to a normalized [-1, +1] stance
// and apply it. Used by the drag handlers so touch and mouse set the lateral aim
// directly (REQ-033, REQ-037). No-op outside the align phase (setAlignFraction
// guards that), so a stray drag never disturbs a locked or in-flight shot.
function dragLineupTo(clientX: number): void {
  if (!lineupTrackEl) return;
  const rect = lineupTrackEl.getBoundingClientRect();
  const fraction = lineupFractionFromOffset(clientX - rect.left, rect.width, LINEUP_RAIL_INSET);
  shotCamera.setAlignFraction(fraction);
  renderLineup();
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
  // The line-up stance (metres off centre) sets the base aim so an off-centre
  // line points the ball back at the pins (REQ-033 step 1, REQ-036 release).
  ball.launch(spinMeter.position, powerMeter.position, shotCamera.alignment);
  // The ball leaves the hand and meets the lane: a release thunk plus a rumble
  // down the wood (REQ-043).
  audio.playBallThunk();
  audio.playBallRoll();
  shotWatcher.begin();
  foulDetector.begin();
  gutterDetector.begin();
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
    advanceTutorial();
    return;
  }
  if (spinMeter.isSweeping) {
    spinMeter.stop();
    audio.playClick();
    powerMeter.start();
    advanceTutorial();
    return;
  }
  if (powerMeter.isSweeping) {
    powerMeter.stop();
    audio.playClick();
    advanceTutorial();
    if (canThrow(shotCamera.currentPhase, true)) throwBall();
  }
}

// Advance the first-run coach by one step on each confirm and re-render the
// panel. The final step (power) retires the tutorial; persist that so it never
// shows again in a future session (REQ-047).
function advanceTutorial(): void {
  if (!tutorial.active) return;
  const finished = tutorial.advance();
  if (finished) settings.setTutorialSeen(true);
  renderTutorial();
}

// Start a brand-new game from the menu or the summary. The Game spine has no
// reset; replace it with a fresh one, clear the scoreboard, re-rack the deck,
// and start the first shot.
function startNewGame(): void {
  game = new Game();
  phase = 'aiming';
  renderScore();
  // Arm the first-run coach (no-op if already seen) and show its first step.
  tutorial.begin();
  renderTutorial();
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
  // The standings board is a sub-view of the menu/summary; a screen transition
  // always closes it so it never lingers over the wrong screen or the live game.
  if (boardEl) boardEl.hidden = true;
  // The coach only belongs over the live game; hide it on the menu and summary.
  if (tutorialEl && screen !== 'playing') tutorialEl.hidden = true;
  // The line-up track likewise belongs only over the live align phase.
  if (lineupEl && screen !== 'playing') lineupEl.hidden = true;
  // The spin/power gauges belong only over the live aiming phase.
  if (metersEl && screen !== 'playing') metersEl.hidden = true;
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

// Reflect a submit-status message on the summary, with a state for the colour
// cue (neutral / ok / error). Empty clears the line.
function setSubmitStatus(message: string, state: 'neutral' | 'ok' | 'error' = 'neutral'): void {
  if (!summarySubmitStatusEl) return;
  summarySubmitStatusEl.textContent = message;
  if (state === 'neutral') summarySubmitStatusEl.removeAttribute('data-state');
  else summarySubmitStatusEl.setAttribute('data-state', state);
}

// Ready the leaderboard form for a freshly finished game: pre-fill the name from
// the persisted setting, re-enable the controls, and clear any prior status.
function primeSubmitForm(): void {
  scoreSubmitted = false;
  if (summaryNameInput) {
    summaryNameInput.value = settings.playerName;
    summaryNameInput.disabled = false;
  }
  if (summarySubmitBtn) {
    summarySubmitBtn.disabled = false;
    summarySubmitBtn.textContent = 'Submit Score';
  }
  setSubmitStatus('');
}

// Submit the just-finished game's score (REQ-057). The completed game's score
// carries the per-frame ball line, which the client turns into the wire payload;
// the server re-scores it and returns the authoritative rank. Guard against a
// double-submit of the same game, and persist the name for next time.
async function submitScore(): Promise<void> {
  if (scoreSubmitted || leaderboard.loading) return;
  const summary = game.summary();
  if (!summary) {
    setSubmitStatus('No completed game to submit', 'error');
    return;
  }
  const name = (summaryNameInput?.value ?? '').trim();
  if (!name) {
    setSubmitStatus('Enter a name first', 'error');
    summaryNameInput?.focus();
    return;
  }
  settings.setPlayerName(name);
  audio.playClick();
  if (summarySubmitBtn) summarySubmitBtn.disabled = true;
  setSubmitStatus('Submitting...', 'neutral');

  const result = await leaderboard.submitGame(name, summary.score, 'solo');
  if (result && result.success) {
    scoreSubmitted = true;
    if (summaryNameInput) summaryNameInput.disabled = true;
    if (summarySubmitBtn) summarySubmitBtn.textContent = 'Submitted';
    const rankText = result.rank ? ` You are rank #${result.rank}.` : '';
    setSubmitStatus(`Score ${result.score} posted.${rankText}`, 'ok');
  } else {
    if (summarySubmitBtn) summarySubmitBtn.disabled = false;
    setSubmitStatus(leaderboard.error ?? 'Could not submit score', 'error');
  }
}

// Render the standings list for the active tab from the leaderboard's cached
// entries and load state. Called after a fetch resolves and on every tab flip
// so the visible rows always match the chosen board (RULE 10 observable render).
function renderBoard(): void {
  if (!boardListEl) return;
  const entries = boardTab === 'daily' ? leaderboard.dailyEntries : leaderboard.allTimeEntries;
  boardListEl.innerHTML = renderBoardRows(entries, {
    loading: leaderboard.boardLoading,
    error: leaderboard.boardError,
  });
  // The player's rank-in-context block (REQ-062): only fills when their best sits
  // below the visible top slice (BOARD_LIMIT rows), so it adds information rather
  // than repeating a row already on screen.
  if (boardContextEl) {
    const context = boardTab === 'daily' ? leaderboard.dailyContext : leaderboard.allTimeContext;
    boardContextEl.innerHTML = renderContextRows(context, BOARD_LIMIT);
  }
}

// Reflect the active tab on the two tab buttons (label state + accessible
// pressed state, RULE 10) and re-render the rows for that tab.
function syncBoardTabs(): void {
  boardTabAllTimeBtn?.setAttribute('aria-pressed', String(boardTab === 'alltime'));
  boardTabDailyBtn?.setAttribute('aria-pressed', String(boardTab === 'daily'));
  renderBoard();
}

// Open the standings board over the current screen. Remember which screen to
// return to, show the overlay, render the current (cached) state immediately so
// there is no blank flash, then fetch both boards and re-render when they land.
// A failed load is non-fatal: renderBoard shows the cached rows or an error.
function openBoard(): void {
  boardReturnVisible = screens.screen === 'summary' ? 'summary' : 'menu';
  boardTab = 'alltime';
  // Hide the originating overlay so the standings dialog is the only modal
  // surface: both are full-screen .vp-overlay at the same z-index, so leaving
  // the opener visible would bleed its background through and keep its buttons
  // in the tab order behind the dialog (RULE 10 modal isolation).
  if (menuEl) menuEl.hidden = true;
  if (summaryEl) summaryEl.hidden = true;
  if (boardEl) boardEl.hidden = false;
  syncBoardTabs();
  // Pass the persisted player name so the server returns the player's standing in
  // context when their best is off the top slice (REQ-062). An empty name simply
  // yields no context block.
  const name = settings.playerName.trim();
  void leaderboard.fetchBoth(BOARD_LIMIT, name || undefined).then(renderBoard);
}

// Close the board overlay and return to the screen that opened it. The board is
// a sub-view, not a screen state, so this just toggles overlay visibility.
function closeBoard(): void {
  if (boardEl) boardEl.hidden = true;
  if (menuEl) menuEl.hidden = boardReturnVisible !== 'menu';
  if (summaryEl) summaryEl.hidden = boardReturnVisible !== 'summary';
}

menuLeaderboardBtn?.addEventListener('click', () => {
  wakeAudio();
  audio.playClick();
  openBoard();
});
summaryLeaderboardBtn?.addEventListener('click', () => {
  audio.playClick();
  openBoard();
});
boardTabAllTimeBtn?.addEventListener('click', () => {
  audio.playClick();
  boardTab = 'alltime';
  syncBoardTabs();
});
boardTabDailyBtn?.addEventListener('click', () => {
  audio.playClick();
  boardTab = 'daily';
  syncBoardTabs();
});
boardBackBtn?.addEventListener('click', () => {
  audio.playClick();
  closeBoard();
});

summarySubmitForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitScore();
});
summaryMenuBtn?.addEventListener('click', () => {
  audio.playClick();
  screens.toMenu();
});
menuTutorialBtn?.addEventListener('click', () => {
  // Replay the control tutorial: re-arm the coach, clear the persisted seen flag
  // so it sticks across sessions until the next throw, and start a fresh game.
  wakeAudio();
  audio.playClick();
  tutorial.replay();
  settings.setTutorialSeen(false);
  screens.start();
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

// Line-up track drag (REQ-033 step 1, REQ-037 touch/mouse). A pointerdown on the
// track captures the pointer and steers the lateral aim with each move until
// release. stopPropagation keeps the drag from bubbling to the window confirm
// below, so dragging the track sets the line rather than locking it; the player
// taps anywhere else (the caption reads "tap to lock") to confirm. Pointer
// capture means a drag that wanders off the narrow track keeps steering.
if (lineupTrackEl) {
  let dragging = false;
  lineupTrackEl.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    event.preventDefault();
    wakeAudio();
    dragging = true;
    lineupTrackEl.setPointerCapture(event.pointerId);
    dragLineupTo(event.clientX);
  });
  lineupTrackEl.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    dragLineupTo(event.clientX);
  });
  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (lineupTrackEl.hasPointerCapture(event.pointerId)) {
      lineupTrackEl.releasePointerCapture(event.pointerId);
    }
  };
  lineupTrackEl.addEventListener('pointerup', endDrag);
  lineupTrackEl.addEventListener('pointercancel', endDrag);
}

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
      // Only the live game consumes a confirm, so only suppress the default
      // (page scroll on Space) while playing. On the menu/summary/board overlays
      // the keypress must still activate the focused button (RULE 10).
      if (screens.screen === 'playing') {
        event.preventDefault();
        confirm();
      }
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

  // Strike victory routine (REQ-044). Advance the burst, mirror the debris onto
  // their meshes, and rattle the camera by the decaying shake offset. The
  // routine fires after a strike during the settle/reset beat (camera locked at
  // the line), so adding the offset on top of the current camera position reads
  // as a rattle; it decays to zero and the next applyCameraPose resets cleanly.
  if (victory.active && shakeBase) {
    victory.update(dt);
    world.syncVictoryDebris(victory.debris);
    const s = victory.shakeOffset;
    world.camera.position.set(shakeBase.x + s.x, shakeBase.y + s.y, shakeBase.z + s.z);
  } else if (shakeBase) {
    // The burst just ended: hide any lingering debris and clear the shake so the
    // camera sits back at its resting position before the next shot's pose runs.
    world.syncVictoryDebris(victory.debris);
    world.camera.position.set(shakeBase.x, shakeBase.y, shakeBase.z);
    shakeBase = null;
  }

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
    // Reflect the lateral stance on the line-up track (shown only while aligning).
    renderLineup();
    // Slide the spin/power gauge needles to their live cursors (REQ-038).
    renderMeters();
  } else if (phase === 'watching') {
    const k = ball.kinematics();
    // Flag an over-the-line release the moment the ball crosses the foul line
    // while live (REQ-032). The throw still plays out; the foul is applied when
    // the ball resolves so the dead ball scores zero regardless of any pinfall.
    if (foulDetector.step(k.z)) setStatus('Foul! Over the line.');
    // Flag a gutter ball the moment it leaves the lane bed sideways (REQ-031).
    // Like a foul it is a dead ball: the throw plays out and scores zero pinfall
    // when it resolves. A foul takes priority in the status copy if both trip.
    if (gutterDetector.step(k.x) && !foulDetector.fouled) setStatus('Gutter ball.');
    if (shotWatcher.step(k.speed, k.z)) {
      // The ball has resolved; begin settling the rack before counting.
      settle.reset();
      phase = 'settling';
      if (!foulDetector.fouled && !gutterDetector.guttered) setStatus('Counting pins...');
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
  // A dead ball scores zero pinfall regardless of any pins it disturbed and
  // leaves the standing rack for the next ball (Q-012 default A). Two cases: an
  // over-the-line release is a foul (REQ-032), and a ball that leaves the lane
  // into a gutter is a gutter ball (REQ-031). Recording a zero ball keeps the
  // rack, and the returned between-balls reset reels any pins the dead ball
  // knocked back to their home spots, so it costs the throw but not the rack.
  const deadBall = foulDetector.fouled || gutterDetector.guttered;
  const pinsDowned = deadBall ? 0 : Math.max(0, standingBeforeBall - standingNow);
  const result = game.recordBall(pinsDowned);
  renderScore();

  if (deadBall) {
    // A neutral mechanical acknowledgement; no clatter or sting on a dead ball.
    audio.playClick();
  }

  // Mechanical feedback for the count (REQ-043). Pins falling clatter (louder for
  // a bigger count); clearing the rack rings a flourish: the bigger strike sting
  // when the first ball takes all ten, the smaller spare cue otherwise.
  if (!deadBall && result.pinsDowned > 0) audio.playPinClatter(result.pinsDowned);
  if (result.pinsStanding === 0) {
    if (result.ballInFrame === 1 && result.pinsDowned === 10) {
      audio.playStrike();
      // A strike is rare in duckpin, so it earns the Rube Goldberg flourish:
      // debris flung off the rack and a quick camera shake (REQ-044). Burst
      // originates at the rack head spot on the deck. Capture the camera's
      // resting position so the per-frame shake is an absolute offset from it
      // (the camera is locked at the line through the settle/reset beat, so it
      // does not move on its own while the burst plays).
      shakeBase = {
        x: world.camera.position.x,
        y: world.camera.position.y,
        z: world.camera.position.z,
      };
      victory.start(LANE.headSpot);
    } else {
      audio.playSpare();
    }
  }

  if (result.outcome === 'game-over') {
    phase = 'over';
    const summary = game.summary();
    const finalScore = summary?.finalScore ?? 0;
    setStatus(`Game over. Final score ${finalScore}.`);
    if (summaryScoreEl) summaryScoreEl.textContent = String(finalScore);
    // Prime the leaderboard submit form for this fresh result (REQ-057).
    primeSubmitForm();
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
