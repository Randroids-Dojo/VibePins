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
import { detectPins, isRackSnagged, SettleWindow } from './detection.js';
import { ResetCycle, type ResetMode, type ResetPhase } from './reset.js';
import { ShotCamera, ChaseCam, canThrow, lineupMarkerOffset, lineupFractionFromOffset, shotMetersVisibility } from './camera.js';
import { SweepMeter, meterBandSpan } from './meter.js';
import { Game } from './game.js';
import { Scoreboard } from './scoreboard.js';
import { ShotWatcher } from './shot.js';
import { FoulDetector } from './foul.js';
import { GutterDetector } from './gutter.js';
import { Screens, type Screen } from './screens.js';
import { rackActionFor, phaseAfterRecord, throwLightFor, type ThrowLightState } from './shotLoop.js';
import { Settings } from './settings.js';
import { Leaderboard, renderBoardRows, renderContextRows, type BoardType } from './leaderboard.js';
import { MatchClient } from './matchClient.js';
import {
  matchViewMode,
  handoffLink,
  handoffShareData,
  matchIdFromSearch,
  waitingHeadline,
  renderLobbyRows,
  renderMatchScoreboard,
  type MatchViewMode,
} from './matchUI.js';
import { MatchFrameAccumulator } from './matchFrame.js';
import { Tutorial } from './tutorial.js';
import { AudioEngine } from './audio.js';
import { VictoryRoutine } from './victory.js';
import { DETECTION, FOUL, GUTTER, LANE, PIN_REST_Y, POWER, RESET, SHOT, SHOT_CAMERA, SPIN, TANGLE, TETHER, VICTORY } from './config.js';

const canvas = document.getElementById('lane') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('VibePins: missing required <canvas id="lane"> element.');
}
const scoreboardEl = document.getElementById('scoreboard');
const statusEl = document.getElementById('status');
// The red/green throw light and its visible word label. The light replaces the
// verbose in-game status text: the scoreboard carries frame/ball/score, and this
// lamp is the at-a-glance "is it my turn to throw" cue (REQ-038, look-and-feel).
const throwLightEl = document.getElementById('throw-light');
const throwLightLabelEl = document.getElementById('throw-light-label');

// App-shell overlays (REQ-045). The menu and summary screens gate the live game.
const menuEl = document.getElementById('menu');
const summaryEl = document.getElementById('summary');
const summaryScoreEl = document.getElementById('summary-score');
const menuPlayBtn = document.getElementById('menu-play');
const menuMatchBtn = document.getElementById('menu-match');
const menuAudioBtn = document.getElementById('menu-audio');
const menuBallCamBtn = document.getElementById('menu-ballcam');
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

// Async multiplayer hub overlay (REQ-050/051). One overlay whose visible block
// switches by match view-mode (entry / lobby / your-turn-vs-waiting / complete).
const matchEl = document.getElementById('match');
const matchStatusEl = document.getElementById('match-status');
const matchEntryEl = document.getElementById('match-entry');
const matchFormEl = document.getElementById('match-form') as HTMLFormElement | null;
const matchNameInput = document.getElementById('match-name') as HTMLInputElement | null;
const matchCreateBtn = document.getElementById('match-create-btn') as HTMLButtonElement | null;
const matchJoinBtn = document.getElementById('match-join-btn') as HTMLButtonElement | null;
const matchLobbyEl = document.getElementById('match-lobby');
const matchLobbyListEl = document.getElementById('match-lobby-list');
const matchLinkInput = document.getElementById('match-link') as HTMLInputElement | null;
const matchCopyBtn = document.getElementById('match-copy-btn') as HTMLButtonElement | null;
const matchPlayEl = document.getElementById('match-play');
const matchHeadlineEl = document.getElementById('match-headline');
const matchScoreboardEl = document.getElementById('match-scoreboard');
const matchPlayNoteEl = document.getElementById('match-play-note');
const matchBowlBtn = document.getElementById('match-bowl-btn') as HTMLButtonElement | null;
const matchShareBtn = document.getElementById('match-share-btn') as HTMLButtonElement | null;
const matchRefreshBtn = document.getElementById('match-refresh-btn') as HTMLButtonElement | null;
const matchCompleteEl = document.getElementById('match-complete');
const matchStandingsEl = document.getElementById('match-standings');
const matchBackBtn = document.getElementById('match-back');

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
const GAUGE_RAIL_INSET = 38;

const world = await createWorld3D(canvas);
const pins = new PinSet(world);
const ball = new Ball(world);

// The pure game spine: tracks frames/balls, decides re-racks, and scores. It has
// no reset of its own, so a new game replaces this instance (see restartGame).
let game = new Game();
const scoreboard = scoreboardEl ? new Scoreboard(scoreboardEl) : null;

const reset = new ResetCycle({ ...RESET, ...TANGLE, restY: PIN_REST_Y });
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

// Async-match client (REQ-050/051). Drives create / join / resume against the
// match backend and holds the latest authoritative public view, which the match
// overlay renders. The match id a handoff link pointed at (?match=<id>) is held so
// the entry block can offer Join instead of Create when one is present.
const matchClient = new MatchClient(settings);
let pendingMatchId: string | null = null;
// The in-flight async-match turn (REQ-053): the match id, the 1-based frame the
// server expects, and the accumulator that collects each settled ball's pin-fall
// into the frame array submitted on frame completion. Non-null only while the live
// shot loop is bowling a match frame; null keeps the solo flow unchanged (RULE 7).
let matchTurn: { matchId: string; frame: number; accumulator: MatchFrameAccumulator } | null = null;
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
// The mode of the active (or just-completed) reset, so the resetting phase knows
// whether to hand the carried pins back to the dynamics (rerack) or leave them
// held aloft and cleared (between-balls).
let resetMode: ResetMode = 'rerack';
// Pins lifted clear by between-balls resets earlier in this frame and still held
// kinematically aloft. They stay cleared off the deck until the next rerack hands
// them back. Tracked so the rerack carries exactly the held pins home alongside
// the freshly fallen ones.
let clearedPins = new Set<number>();
// The reset phase on the previous tick, so stepReset can act on the frame a phase
// is entered (capture the reeled, hanging rack kinematic when the reposition carry
// begins). Reset on each cycle.
let prevResetPhase: ResetPhase = 'idle';

const ALIGN_STEP = 0.04;

// Ball-cam chase follower (REQ-033 polish). When the persisted Ball Cam setting is
// on, the watching phase rides behind the rolling ball instead of holding the fixed
// bowler view, easing the pose toward the chase target each frame so the follow is
// smooth, not jarring. The pure stepper lives in src/camera; main only feeds it the
// live ball position and applies the returned pose. reset() between shots makes the
// next follow re-seed framed on the ball.
const chaseCam = new ChaseCam(
  {
    behind: SHOT_CAMERA.chaseBehind,
    height: SHOT_CAMERA.chaseHeight,
    ahead: SHOT_CAMERA.chaseAhead,
    lookHeight: SHOT_CAMERA.chaseLookHeight,
    fov: SHOT_CAMERA.chaseFov,
  },
  6,
);

// The status line now carries only essential one-off prompts (game over, match
// submit). It is hidden whenever there is nothing transient to say, so the HUD
// stays quiet and the throw light plus scoreboard carry the live state.
function setStatus(text: string): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.hidden = text.length === 0;
}

// Drive the red/green throw light from the current shot phase. GREEN ('go') only
// in the aiming phase (the player may throw); RED ('wait') for every machine-owned
// phase. The accessible label and visible word change with it so the state is not
// colour-only (RULE 10). Hidden outside live play (set by showScreen).
function renderThrowLight(): void {
  if (!throwLightEl) return;
  const state: ThrowLightState = throwLightFor(phase);
  const label = state === 'go' ? 'Ready to throw' : 'Wait';
  throwLightEl.dataset.light = state;
  throwLightEl.setAttribute('aria-label', label);
  if (throwLightLabelEl) throwLightLabelEl.textContent = state === 'go' ? 'Go' : 'Wait';
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
// cursor (REQ-038). The gauges appear only once the line is locked and the timed
// steps run: the spin gauge while the spin meter sweeps or is stopped before the
// power step starts, then the power gauge while the power meter sweeps. They stay
// hidden through the loading walk-up and the line-up step (shotMetersVisibility),
// so the meters show only when it is time to aim. The needle uses the same
// [-1, +1] -> rail-px map as the line-up marker; the centred band is sized from
// the tuned config so the highlight always matches the real sweet spot. Called
// every aiming frame so the sweep motion is observable (RULE 10).
function renderMeters(): void {
  if (!metersEl) return;
  const { showSpin, showPower } = shotMetersVisibility(
    phase === 'aiming',
    shotCamera.currentPhase,
    powerMeter.isSweeping,
  );
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
  // The scoreboard carries frame / ball / score and the throw light goes green;
  // no verbose status sentence (REQ-038, look-and-feel reduced-text HUD). The
  // first-run tutorial coach still names the aim/spin/power steps.
  renderThrowLight();
}

function countStandingPins(): number {
  return detectPins(pins, DETECTION).filter((p) => p.standing).length;
}

// Start a reset cycle in the given mode, making the carried pins kinematic.
//
// rerack (frame end): reel all ten pins and carry them home, including any pins
// held aloft from earlier between-balls resets this frame, so the deck reads as a
// fresh rack. between-balls: reel the WHOLE rack up (the recall-all motion of a
// real string machine), lower the standing pins back onto their home spots
// (re-spotting a nudged-but-standing pin, REQ-021), and leave the newly fallen
// pins reeled up and aloft, cleared out of play (REQ-009).
function startReset(mode: ResetMode): void {
  resetMode = mode;
  const fallen = detectPins(pins, DETECTION)
    .filter((p) => !p.standing)
    .map((p) => p.pinIndex)
    // Pins already lifted clear earlier in the frame are aloft, so a fresh settle
    // reads them fallen. They are already cleared; on a between-balls cycle keep
    // them aloft (do not re-reel as freshly fallen). A rerack carries them home
    // alongside everything else, so it does not filter them out.
    .filter((index) => mode === 'rerack' || !clearedPins.has(index));
  if (mode !== 'rerack' && fallen.length === 0) {
    // Nothing new was knocked down (a clean miss / pure gutter with the rack
    // untouched): no recall needed. Skip straight to the next shot; the rack
    // already holds exactly the pins the next ball aims at (REQ-009).
    beginShot();
    return;
  }
  const settled = pins.pinStates().map((s) => s.position);
  // Reel the whole rack by the cords. beginReset just wakes the pins so the
  // cord-tension lift acts immediately (the just-fallen and standing pins are
  // dynamic, so the reeling rope drags them up by the neck). On a between-balls
  // cycle the previously cleared pins are already kinematic and aloft; waking them
  // is harmless and they hold position. The fallen list marks which stay aloft.
  const allPins = pinRackPositions().map((_, i) => i);
  const heldAloft = mode === 'rerack' ? fallen : [...new Set([...fallen, ...clearedPins])];
  pins.beginReset(allPins);
  reset.start(mode, heldAloft, pinRackPositions(), settled);
  prevResetPhase = 'idle';
  // The pinsetter's signature voice: servo whir, taut cords, relay clicks, the
  // rack thunking home (REQ-043).
  audio.playStringReset();
  phase = 'resetting';
  // Pinsetter owns the deck: keep the light red through the reset cycle.
  renderThrowLight();
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
  // The lane is now the machine's: light goes red, no "Rolling..." sentence.
  renderThrowLight();
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
  clearedPins = new Set();
  renderScore();
  // Arm the first-run coach (no-op if already seen) and show its first step.
  tutorial.begin();
  renderTutorial();
  startReset('rerack');
}

// Start bowling the player's async-match frame in the live game (REQ-053). Reuses
// the exact solo shot loop and Game spine: a fresh Game so the deck re-racks and
// the between-balls vs frame-end resets honour the same duckpin rules, with the
// tutorial coach suppressed (this is not a first-run flow). The match-turn state is
// already set by the Bowl handler; recordSettledBall feeds the accumulator while it
// is non-null and submits the frame on completion. Only one frame is bowled: the
// match's currentFrame, then the turn hands off.
function startMatchFrame(): void {
  game = new Game();
  phase = 'aiming';
  clearedPins = new Set();
  renderScore();
  startReset('rerack');
}

// The match frame's turn is over: submit its per-ball pin-fall to the server, which
// re-scores and advances the turn (REQ-053), then return to the hub. The hub's
// re-render shows the advanced state (waiting / your next frame) or, when this was
// the last line, the final-standings plate (REQ-056). A submit failure surfaces on
// the hub status line; the turn is not lost because the server is authoritative and
// the player can Refresh and retry. Clearing matchTurn first keeps the solo flow
// clean if the player navigates away.
async function finishMatchFrame(): Promise<void> {
  const turn = matchTurn;
  matchTurn = null;
  phase = 'over';
  if (!turn) {
    screens.toMatch();
    return;
  }
  setStatus('Submitting your frame...');
  // submitFrame resolves rather than throws (it catches its own errors), but guard
  // anyway so an unexpected rejection still hands back to the hub rather than
  // stranding the player in the playing state.
  try {
    const result = await matchClient.submitFrame(turn.matchId, turn.frame, turn.accumulator.balls);
    if (!result.ok) {
      setMatchStatus(matchClient.error ?? 'Could not submit your frame', 'error');
    }
  } catch {
    setMatchStatus('Could not submit your frame', 'error');
  } finally {
    screens.toMatch();
  }
}

// Reflect the audio-enable setting on the menu toggle (label + accessible state).
function syncAudioToggle(): void {
  if (!menuAudioBtn) return;
  const on = settings.audioEnabled;
  menuAudioBtn.setAttribute('aria-pressed', String(on));
  menuAudioBtn.textContent = `Audio: ${on ? 'On' : 'Off'}`;
}

// Reflect the ball-cam setting on the menu toggle (label + accessible state).
function syncBallCamToggle(): void {
  if (!menuBallCamBtn) return;
  const on = settings.ballCam;
  menuBallCamBtn.setAttribute('aria-pressed', String(on));
  menuBallCamBtn.textContent = `Ball Cam: ${on ? 'On' : 'Off'}`;
}

// The single shell view layer: show exactly one overlay per screen and (un)pause
// the status line. The live game owns the canvas; menu/summary cover it.
function showScreen(screen: Screen): void {
  const isMenu = screen === 'menu';
  const isSummary = screen === 'summary';
  const isMatch = screen === 'match';
  if (menuEl) menuEl.hidden = !isMenu;
  if (summaryEl) summaryEl.hidden = !isSummary;
  // The match hub is its own screen: reveal it when entering, hide it when leaving.
  // openMatch() also handles the entry resume; this keeps the overlay visible when
  // returning to the hub from a bowled match frame (the playing -> match path).
  if (matchEl) matchEl.hidden = !isMatch;
  // The standings board is a sub-view of the menu/summary; a screen transition
  // always closes it so it never lingers over the wrong screen or the live game.
  if (boardEl) boardEl.hidden = true;
  // The coach only belongs over the live game; hide it on the menu and summary.
  if (tutorialEl && screen !== 'playing') tutorialEl.hidden = true;
  // The line-up track likewise belongs only over the live align phase.
  if (lineupEl && screen !== 'playing') lineupEl.hidden = true;
  // The spin/power gauges belong only over the live aiming phase.
  if (metersEl && screen !== 'playing') metersEl.hidden = true;
  // The throw light belongs only over the live game; show it on entry and keep it
  // in sync with the current phase, hide it on every other screen.
  if (throwLightEl) {
    throwLightEl.hidden = screen !== 'playing';
    if (screen === 'playing') renderThrowLight();
  }
  if (screen !== 'playing') setStatus('');
  if (isMenu) {
    syncAudioToggle();
    syncBallCamToggle();
  }
}

screens.onChange((screen, previous) => {
  showScreen(screen);
  // Entering play from the match hub bowls one match frame (matchTurn is set);
  // otherwise it is a fresh solo game. Returning to the hub from a finished match
  // frame re-renders the advanced state rather than re-opening from scratch.
  if (screen === 'playing') {
    if (matchTurn) startMatchFrame();
    else startNewGame();
  }
  if (screen === 'match') {
    if (previous === 'playing') renderMatch();
    else openMatch();
  }
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

// Post this device's own seat line from a finished match to the global
// leaderboard (REQ-058). Default: only this device's seat posts, under the name
// it claimed the seat with, so each line lands once (no cross-device duplicates)
// and never under a guessed name. The post is guarded by a persisted flag so a
// re-view of the same finished match (the complete view re-renders on refresh)
// cannot double-post. Fire-and-forget and non-fatal: a failure leaves the flag
// unset so a later view can retry, and never blocks the standings render. The
// client re-scores locally only to confirm completeness; the server is the sole
// ranking authority and we never send a claimed total.
function postMatchLineToBoard(): void {
  const match = matchClient.match;
  const seat = matchClient.mySeat;
  if (!match || match.status !== 'complete' || seat == null) return;
  if (settings.hasPostedMatchToBoard(match.id)) return;

  const seatLine = match.seats.find((s) => s.seat === seat);
  if (!seatLine) return;
  const cred = settings.matchCredential(match.id);
  const name = (cred?.name ?? seatLine.name).trim();
  if (!name) return;

  // Mark before the round trip so a synchronous re-render does not fire a second
  // post; clear it again if the post fails so the next view can retry.
  settings.markMatchPostedToBoard(match.id);
  void leaderboard
    .submitFrames(name, seatLine.frames, 'match')
    .then((result) => {
      if (!result || !result.success) settings.unmarkMatchPostedToBoard(match.id);
    })
    .catch(() => settings.unmarkMatchPostedToBoard(match.id));
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

// Async multiplayer hub (REQ-050/051) -------------------------------------------
//
// The overlay shows exactly one block per view-mode derived from the held match.
// Create / join / resume run through matchClient; the rendered rows, headline, and
// handoff link come from the pure src/matchUI presenter so this stays a thin shell.

// Reflect a status / error line on the match overlay (neutral / ok / error cue).
function setMatchStatus(message: string, state: 'neutral' | 'ok' | 'error' = 'neutral'): void {
  if (!matchStatusEl) return;
  matchStatusEl.textContent = message;
  if (state === 'neutral') matchStatusEl.removeAttribute('data-state');
  else matchStatusEl.setAttribute('data-state', state);
}

// Show exactly one match block for the current view-mode and fill it from the held
// match (RULE 10 observable render). Pure-ish: reads matchClient + pendingMatchId,
// writes the DOM. Called after every match call resolves and on open.
function renderMatch(): void {
  if (!matchEl || matchEl.hidden) return;
  const mode: MatchViewMode = matchViewMode(matchClient.match, matchClient.mySeat, matchClient.loading);
  const showEntry = mode === 'none' || mode === 'loading';
  const showLobby = mode === 'lobby';
  const showPlay = mode === 'yourTurn' || mode === 'waiting';
  const showComplete = mode === 'complete';

  if (matchEntryEl) matchEntryEl.hidden = !showEntry;
  if (matchLobbyEl) matchLobbyEl.hidden = !showLobby;
  if (matchPlayEl) matchPlayEl.hidden = !showPlay;
  if (matchCompleteEl) matchCompleteEl.hidden = !showComplete;

  if (showEntry) {
    // A handoff link (?match=<id>) was opened, or this device already holds a
    // credential for it: offer Join. Otherwise offer Create. Loading disables both.
    const joining = pendingMatchId != null;
    if (matchCreateBtn) matchCreateBtn.hidden = joining;
    if (matchJoinBtn) matchJoinBtn.hidden = !joining;
    const busy = matchClient.loading;
    if (matchCreateBtn) matchCreateBtn.disabled = busy;
    if (matchJoinBtn) matchJoinBtn.disabled = busy;
    if (mode === 'loading') setMatchStatus('Loading match...');
    else if (matchClient.error) setMatchStatus(matchClient.error, 'error');
  }

  if (showLobby) {
    if (matchLobbyListEl) matchLobbyListEl.innerHTML = renderLobbyRows(matchClient.match, matchClient.mySeat);
    if (matchLinkInput && matchClient.match) {
      matchLinkInput.value = handoffLink(window.location.href, matchClient.match.id);
    }
    setMatchStatus('Waiting for players to join. Share the link below.');
  }

  if (showPlay) {
    const yours = mode === 'yourTurn';
    if (matchHeadlineEl) {
      matchHeadlineEl.textContent = yours ? 'Your turn to bowl' : waitingHeadline(matchClient.match);
    }
    if (matchScoreboardEl) {
      matchScoreboardEl.innerHTML = renderMatchScoreboard(matchClient.match, matchClient.mySeat);
    }
    // The handoff link is the bowler's tool to pass the match on; show it on both
    // states so a waiting player can re-share the invite (REQ-050).
    if (matchShareBtn) matchShareBtn.hidden = false;
    // The Bowl button launches the live shot loop for this frame; it is the
    // unmistakable your-turn affordance and is hidden while waiting (REQ-051/053).
    if (matchBowlBtn) {
      matchBowlBtn.hidden = !yours;
      matchBowlBtn.disabled = matchClient.loading;
      const frame = matchClient.match?.currentFrame ?? 1;
      matchBowlBtn.textContent = `Bowl Frame ${frame}`;
    }
    if (matchPlayNoteEl) {
      matchPlayNoteEl.textContent = yours
        ? 'Bowl your frame, then share the handoff link to pass the match on.'
        : 'You will see the score update here as players bowl. Use Refresh to check.';
    }
    setMatchStatus('');
  }

  if (showComplete) {
    if (matchStandingsEl) {
      matchStandingsEl.innerHTML = renderMatchScoreboard(matchClient.match, matchClient.mySeat);
    }
    setMatchStatus('Match complete.', 'ok');
    // Feed this device's finished line into the global board (REQ-058). Guarded
    // against double-posting; non-fatal if it fails.
    postMatchLineToBoard();
  }
}

// Open the match hub. Show the overlay, hide the menu (so the dialog is the only
// modal surface, like openBoard), then resolve what to show: if a handoff link or
// a stored credential points at a match, resume it; otherwise show the create entry.
function openMatch(): void {
  if (menuEl) menuEl.hidden = true;
  if (matchEl) matchEl.hidden = false;
  if (matchNameInput) matchNameInput.value = settings.playerName;
  setMatchStatus('');
  renderMatch();
  if (pendingMatchId) {
    void matchClient.resumeMatch(pendingMatchId).then(renderMatch);
  }
}

// Resume the held match from the server (the Refresh affordance and post-action
// re-read). Re-renders when it lands. Non-fatal: a failure leaves the prior view.
function refreshMatch(): void {
  const id = matchClient.match?.id ?? pendingMatchId;
  if (!id) return;
  void matchClient.resumeMatch(id).then(renderMatch);
}

// Copy a string to the clipboard and flash the button label. Degrades to a
// throwaway off-screen input that gets selected when the clipboard API is
// unavailable or denied, so the fallback works regardless of which block is
// visible (the lobby link field is hidden in play mode, RULE 10 observable).
function copyToClipboard(text: string, button: HTMLButtonElement | null): void {
  const flash = (ok: boolean): void => {
    if (!button) return;
    const original = button.textContent ?? 'Copy';
    button.textContent = ok ? 'Copied' : 'Copy failed';
    window.setTimeout(() => {
      button.textContent = original;
    }, 1500);
  };
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(
        () => flash(true),
        () => flash(false),
      );
      return;
    }
  } catch {
    // Fall through to the manual-select fallback below.
  }
  // No clipboard API: drop a temporary visible-but-offscreen input the player can
  // copy from, select its contents, then remove it. Selecting a hidden lobby
  // field would be a dead end when the share button is pressed in play mode.
  const scratch = document.createElement('input');
  scratch.type = 'text';
  scratch.readOnly = true;
  scratch.value = text;
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  scratch.select();
  scratch.setSelectionRange(0, text.length);
  flash(false);
  document.body.removeChild(scratch);
}

// Hand the match link off through the OS share sheet when the Web Share API is
// available (F-009), degrading cleanly to the clipboard copy on platforms that do
// not support it (for example most desktop browsers). navigator.share resolves on
// a successful share and rejects on cancel or failure; either way we do nothing
// further on the share path. Only when the API is absent do we fall back to copy,
// so a user who dismisses the share sheet does not also get a surprise copy.
function shareHandoff(link: string, button: HTMLButtonElement | null): void {
  const data = handoffShareData(link);
  const nav = navigator as Navigator & {
    share?: (d: ShareData) => Promise<void>;
    canShare?: (d: ShareData) => boolean;
  };
  if (typeof nav.share === 'function' && (typeof nav.canShare !== 'function' || nav.canShare(data))) {
    nav.share(data).catch(() => {
      // Share cancelled or failed: leave the link visible, no fallback copy.
    });
    return;
  }
  copyToClipboard(link, button);
}

menuMatchBtn?.addEventListener('click', () => {
  wakeAudio();
  audio.playClick();
  screens.openMatch();
});

matchFormEl?.addEventListener('submit', (event) => {
  event.preventDefault();
  // Enter in the name field submits the form. Route it to whichever action the
  // entry block is offering: Join when a handoff link was opened (Create hidden),
  // else Create. This keeps Enter-to-submit working on the primary join path
  // rather than dead-ending when the visible button is Join (RULE 10 keyboard).
  if (matchCreateBtn?.hidden) {
    void joinMatchFromForm();
    return;
  }
  void createMatchFromForm();
});

matchJoinBtn?.addEventListener('click', () => {
  audio.playClick();
  void joinMatchFromForm();
});

matchCopyBtn?.addEventListener('click', () => {
  audio.playClick();
  if (matchLinkInput?.value) copyToClipboard(matchLinkInput.value, matchCopyBtn);
});

matchBowlBtn?.addEventListener('click', () => {
  wakeAudio();
  audio.playClick();
  startMatchTurn();
});

matchShareBtn?.addEventListener('click', () => {
  audio.playClick();
  if (matchClient.match) shareHandoff(handoffLink(window.location.href, matchClient.match.id), matchShareBtn);
});

matchRefreshBtn?.addEventListener('click', () => {
  audio.playClick();
  refreshMatch();
});

matchBackBtn?.addEventListener('click', () => {
  audio.playClick();
  screens.toMenu();
});

// Read the chosen display name from the match name field, persisting it so the
// next match (and the leaderboard) pre-fills with it. Returns null (and flags the
// status) when empty so create / join can bail early.
function matchNameOrWarn(): string | null {
  const name = (matchNameInput?.value ?? '').trim();
  if (!name) {
    setMatchStatus('Enter a name first', 'error');
    matchNameInput?.focus();
    return null;
  }
  settings.setPlayerName(name);
  return name;
}

async function createMatchFromForm(): Promise<void> {
  if (matchClient.loading) return;
  const name = matchNameOrWarn();
  if (!name) return;
  audio.playClick();
  setMatchStatus('Creating match...');
  renderMatch();
  const result = await matchClient.createMatch(name);
  if (!result.ok) setMatchStatus(result.error ?? 'Could not create match', 'error');
  renderMatch();
}

async function joinMatchFromForm(): Promise<void> {
  if (matchClient.loading || !pendingMatchId) return;
  const name = matchNameOrWarn();
  if (!name) return;
  setMatchStatus('Joining match...');
  renderMatch();
  const result = await matchClient.joinMatch(pendingMatchId, name);
  if (result.ok) {
    // The seat is claimed; further actions resume by id, not the pending link.
    pendingMatchId = null;
  } else {
    setMatchStatus(result.error ?? 'Could not join match', 'error');
  }
  renderMatch();
}

// Launch the live shot loop to bowl the player's current match frame (REQ-053).
// Guard on its actually being this device's turn so a stale render cannot start a
// frame the server would reject. Set the match-turn state (id, expected frame, a
// fresh accumulator) before the screen transition so the playing listener routes to
// startMatchFrame rather than a solo game.
function startMatchTurn(): void {
  if (!matchClient.isMyTurn || !matchClient.match) return;
  const match = matchClient.match;
  matchTurn = {
    matchId: match.id,
    frame: match.currentFrame,
    // The accumulator's frame index is zero-based; the tenth frame (index 9) takes
    // three balls, every earlier frame ends on a strike / spare / three balls.
    accumulator: new MatchFrameAccumulator(match.currentFrame - 1),
  };
  // Clear the turn if the screen transition is rejected, so stale match context
  // cannot leak into a later solo play transition.
  if (!screens.bowlMatch()) matchTurn = null;
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
menuBallCamBtn?.addEventListener('click', () => {
  // Flip and persist the chase-cam preference; the watching phase reads it live,
  // so no further wiring is needed. A click cue confirms the toggle.
  wakeAudio();
  settings.toggleBallCam();
  syncBallCamToggle();
  audio.playClick();
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

// Handoff deep link (REQ-050/055): when the page was opened with ?match=<id>, jump
// straight into the match hub so the recipient can join (or resume) that match.
pendingMatchId = matchIdFromSearch(window.location.search);
if (pendingMatchId) {
  // A device that already claimed a seat in this match resumes it rather than
  // joining a new one; openMatch's resume call resolves which seat it owns and the
  // mode lands on lobby / your-turn / waiting / complete accordingly. A device with
  // no credential lands on the entry block's Join action for the open seat.
  screens.openMatch();
}

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

// Pin indices the active reset is carrying (the whole reeled rack).
function reeledPins(): number[] {
  return [...reset.targets];
}

// One tick of the reset cycle (REQ-018 to REQ-021, REQ-024). The pure ResetCycle
// drives the phase timing and the bounded snag-recovery loop; this adapter wires
// it to the real physics so the lift is genuinely cord-tension driven and the
// snag verdict reads from the live sim:
//
//   settle-hold: the rack rests on the deck; no cord motion.
//   lift / shake-down / shake-up: the pins stay DYNAMIC and the cords are reeled
//     (the rope joint shortens). The constraint drags each pin up BY ITS NECK so
//     it hangs and swings under gravity (the signature cord-tension lift), never
//     stood upright on the deck. shake-down/shake-up only run on a genuine snag.
//   verify-lift: at the top of the reel the live rack is read for a genuine snag
//     (a pin whose neck failed to rise to its clearance because its cord is held
//     low by another pin lying across it). A clean rack (the common case) reports
//     no snag and runs NO shake; a real snag runs the bounded up/down shake.
//   reposition / lower: the rack is captured KINEMATIC at its hanging pose and
//     carried over the home spots and set down (the held-aloft fallen pins stay
//     aloft, cleared, on a between-balls cycle).
function stepReset(dt: number): void {
  const { targets, reel } = reset.update(dt);
  const phase = reset.phase;

  // The snag verdict: at the top of the cord-tension reel the cycle is paused for
  // a read. A clean rack reports no snag (no shake); only a genuine cord snag (a
  // pin held below its clearance) runs the up/down shake recovery, bounded by the
  // retry cap with a force-clear so the reset can never hang.
  if (reset.needsSnagVerdict) {
    const snagged = isRackSnagged(pins.pinStates(), TETHER.neckLocalY, TANGLE);
    reset.reportSnag(snagged);
    prevResetPhase = phase;
    return;
  }

  // Entering the kinematic carry (reposition): the cord-tension lift (and any
  // shake) has hung the rack aloft. Capture every reeled pin kinematic where it
  // hangs so the carry sets it home from there rather than snapping back, and tell
  // the cycle where each pin actually ended up.
  if (phase === 'reposition' && prevResetPhase !== 'reposition') {
    pins.recaptureKinematic(reeledPins());
    reset.updateSettled(pins.pinStates().map((s) => s.position));
  }

  // The cord-tension phases reel the cords (pins dynamic); the carry phases move
  // the captured kinematic pins.
  if (reel.length > 0) pins.reelStep(reel);
  if (targets.length > 0) pins.resetStep(targets);

  prevResetPhase = phase;
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
    // Ball Cam (REQ-033 polish): when the setting is on, ride a damped chase cam
    // behind the rolling ball down the lane instead of holding the fixed bowler
    // view. Only the watching phase follows; aiming and the settle/reset beat keep
    // the normal pose, and a strike shake (which seeds shakeBase from the camera
    // position during settle/reset) is untouched. The ball rolls on the bed, so
    // its height is the lane-bed radius; x and z come from the live body.
    if (settings.ballCam) {
      const pose = chaseCam.step({ x: k.x, y: LANE.floorY + LANE.ballRadius, z: k.z }, dt);
      applyCameraPose(pose);
    }
    // Track an over-the-line release the moment the ball crosses the foul line
    // while live (REQ-032). The throw still plays out; the foul is applied when
    // the ball resolves so the dead ball scores zero regardless of any pinfall.
    // No status sentence: the light is red (machine's turn) and the scoreboard
    // shows the zero ball once it records.
    foulDetector.step(k.z);
    // Track a gutter ball the moment it leaves the lane bed sideways (REQ-031).
    // Like a foul it is a dead ball: the throw plays out and scores zero pinfall
    // when it resolves.
    gutterDetector.step(k.x);
    if (shotWatcher.step(k.speed, k.z)) {
      // The ball has resolved; begin settling the rack before counting. If the
      // chase cam was following, return the camera to the normal locked shooting
      // view for the settle/reset beat (a strike shake seeds shakeBase from the
      // camera position here, so it must be the bowler pose, not down-lane). Drop
      // the chase pose so the next shot re-seeds the follow from scratch.
      if (settings.ballCam) applyCameraPose(shotCamera.update(0).pose);
      chaseCam.reset();
      settle.reset();
      phase = 'settling';
      // Still the machine's turn (watching -> settling are both red); refresh in
      // case any external state nudged the light.
      renderThrowLight();
    }
  } else if (phase === 'settling') {
    const result = settle.step(pins.pinStates());
    if (result.settled) recordSettledBall(result.standingCount);
  } else if (phase === 'resetting') {
    stepReset(dt);
    if (reset.isComplete()) {
      // The pins lowered onto a home spot are handed back to the dynamics at rest
      // (all ten on a rerack; the standing pins on a between-balls cycle). The
      // pins held reeled up and aloft stay kinematic and cleared.
      pins.endReset(reset.landedTargets);
      if (resetMode === 'rerack') {
        // Frame end: every pin is set back on the deck, a fresh rack, so nothing
        // stays cleared.
        clearedPins = new Set();
      } else {
        // Between balls: the standing pins were re-spotted onto their home spots
        // (handed back above); the knocked-down pins stay aloft and cleared off
        // the deck until the next rerack. Remember them so the rerack carries them
        // home and a later between-balls settle does not re-reel them.
        clearedPins = new Set(reset.heldAloftTargets);
      }
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

  // The pinsetter action for this ball (pure sequencing, src/shotLoop.ts):
  //   rerack        frame end, or a deck-clearing ball inside a continuing frame
  //                 (a tenth-frame strike/spare bonus), so the next ball faces a
  //                 fresh full rack (REQ-010, REQ-007).
  //   between-balls lift only the newly fallen pins clear and leave the standing
  //                 ones, so the next ball aims at the remaining cluster (REQ-009).
  //   none          the game is over.
  const action = rackActionFor(result);

  // Async-match turn (REQ-053): collect this ball's pin-fall (the same dead-ball
  // aware count the solo flow scores) into the frame array. When the frame's turn
  // is over, submit it and hand back to the hub; otherwise run the same rack action
  // the solo flow runs so the next ball of the frame faces the right deck (a strike
  // or spare ends a normal frame before three balls; the tenth always bowls three,
  // re-racking for its bonus balls just like the solo tenth).
  if (matchTurn) {
    const frameDone = matchTurn.accumulator.record(pinsDowned);
    if (frameDone) {
      void finishMatchFrame();
      return;
    }
    if (action !== 'none') startReset(action);
    return;
  }

  if (action === 'none') {
    phase = phaseAfterRecord(action);
    const summary = game.summary();
    const finalScore = summary?.finalScore ?? 0;
    // The summary overlay carries the final score (set below); no separate
    // game-over status sentence on the live HUD (reduced-text HUD).
    if (summaryScoreEl) summaryScoreEl.textContent = String(finalScore);
    // Prime the leaderboard submit form for this fresh result (REQ-057).
    primeSubmitForm();
    // Hand off to the shell: show the summary screen with play-again / menu.
    screens.finish();
    return;
  }

  // Run the rack action: a between-balls clear of the fallen pins (REQ-009) or a
  // full re-rack (REQ-010 frame end, or a bonus-ball deck clear). startReset routes
  // into the resetting phase, which returns to aiming for the next throw.
  startReset(action);
}

requestAnimationFrame(frame);
