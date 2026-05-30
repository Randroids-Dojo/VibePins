// Live shot-loop sequencing (GDD 02-core-loop, 03-string-pinsetter). The pure
// glue between the Game spine (src/game.ts) and the physical reset cycle
// (src/reset.ts) that the browser loop in src/main.ts wires up. It answers one
// question that was previously tangled inline in main.ts and so went untested:
// after a settled ball, what does the pinsetter physically do, and what does the
// deck hold for the next ball?
//
// Pure: no Three.js, no Rapier, no clock. It takes a Game BallResult and returns
// the rack action; main.ts maps that onto ResetCycle / PinSet and the phase
// machine. Because it is pure it is fully unit testable, which is the point: the
// between-balls vs rerack vs clear decision is exactly where the playtest bugs
// lived.

import type { BallResult } from './game.js';

const PINS = 10;

// What the pinsetter should physically do after a settled ball, and what the
// next throw faces:
//   'rerack'        carry all ten pins home and set them down: a fresh full rack
//                   (frame end, or a deck-clearing ball inside a continuing
//                   frame such as a tenth-frame strike/spare bonus).
//   'between-balls' lift only the newly fallen pins clear of the deck and leave
//                   them gone; the standing pins remain exactly where they are
//                   for the next ball (REQ-009).
//   'none'          the game is over; do not reset.
export type RackAction = 'rerack' | 'between-balls' | 'none';

// Decide the rack action for a settled ball from the Game outcome.
//
// The Game spine returns reset 'rerack' at frame end, 'between-balls' while a
// frame continues, and 'none' on game over. The one case its coarse reset tag
// does not capture is a ball that clears the whole deck inside a continuing
// frame: a tenth-frame strike (ball 1) or a spared bonus ball downs all ten yet
// the frame is not over, because bonus balls remain. Those bonus balls must face
// a fresh rack, not an empty deck (REQ-007, Q-011 default A). The signal is
// pinsStanding: the Game reports how many pins the NEXT ball should face, and it
// is ten exactly when the deck was cleared and re-racks for the next ball. So a
// continuing frame whose next ball faces ten is a rerack, not a clear. The deck
// clear must be earned: only a ball that actually downed pins can have cleared
// the rack, so a clean first-ball miss (zero down, ten still standing) stays a
// between-balls clear and keeps the same ten, never a spurious re-rack.
export function rackActionFor(result: BallResult): RackAction {
  if (result.reset === 'none') return 'none';
  if (result.reset === 'rerack') return 'rerack';
  // result.reset === 'between-balls': the frame continues. If the ball cleared the
  // deck (it downed pins and the next ball faces a full rack) it is a bonus-ball
  // re-rack; otherwise lift the fallen pins clear and leave the standing ones,
  // including a clean miss that leaves all ten in place (REQ-009).
  return result.pinsStanding === PINS && result.pinsDowned > 0 ? 'rerack' : 'between-balls';
}

// The phase of one shot through the live loop (mirrors the Phase type in
// main.ts, lifted here so the sequencing is testable without the browser):
//   aiming    the player lines up, sets spin, sets power, then throws.
//   watching  the ball is in flight; wait for it to resolve.
//   settling  the rack is settling; wait, then count and record the ball.
//   resetting the pinsetter is reeling fallen pins or re-racking.
//   over      the game is complete.
export type ShotPhase = 'aiming' | 'watching' | 'settling' | 'resetting' | 'over';

// The next phase the loop should enter after a ball settles and is recorded,
// given its rack action. A reset (rerack or between-balls) means the pinsetter
// runs, then the loop returns to aiming for the next throw; a 'none' action is
// game over. This is the sequencing that, when wrong, dropped the player back
// into the loading walk-up without ever throwing the next ball: every ball that
// is not game-over MUST route through a reset (or skip it when nothing fell) and
// then back to aiming, never stall in settling.
export function phaseAfterRecord(action: RackAction): ShotPhase {
  return action === 'none' ? 'over' : 'resetting';
}

// The throw light's two states, a Pins Mechanical style traffic signal mounted
// down-lane at the pin deck (a physical 3D lamp, not an on-screen overlay). The
// scoreboard already carries frame / ball / score, so the signal is the single
// at-a-glance "is it my turn to throw" cue:
//   'go'   GREEN: the player may aim, set spin and power, and throw. This is only
//          true once the rack is fully set AND the bowler has walked up to the
//          line and can actually aim.
//   'wait' RED: the machine owns the lane. The ball is rolling, the rack is
//          settling, the pinsetter is setting pins, the bowler is still loading
//          the ball and walking up, or the game is over. The player waits. This is
//          also the state when it is not the player's turn at all (an async-match
//          line waiting on the opponent), surfaced the same way so the rule is one
//          consistent thing across solo and match (RULE 7).
export type ThrowLightState = 'go' | 'wait';

// Whether the bowler is actually ready to aim and throw, given the shot phase and
// the shot-setup camera phase. The shot phase is 'aiming' from the moment the next
// shot begins, but that begins during the ball load and the walk-up (camera
// 'pickup' / 'walkup'), while the pinsetter may still be setting the rack. The
// bowler can only aim once the walk-up has completed and the line-up / locked step
// is reached (camera 'align' or 'locked'). So "ready to throw" is the aiming phase
// AND a camera phase that has reached the line. Pure so the mapping is testable.
//   ShotSetupPhase mirrors the ShotPhase in src/camera.ts (lifted here so the
//   light mapping is unit-tested without the browser or Three.js):
//     'pickup' / 'walkup' the ball is loading and the bowler walks up (not ready).
//     'align' / 'locked'  the bowler is at the line and can aim and throw (ready).
export type ShotSetupPhase = 'pickup' | 'walkup' | 'align' | 'locked';

export function readyToAim(phase: ShotPhase, setup: ShotSetupPhase): boolean {
  return phase === 'aiming' && (setup === 'align' || setup === 'locked');
}

// Map the live shot state to the throw light. GREEN exactly when the bowler can
// actually throw: the rack is set and the bowler has walked up to the line (the
// aiming phase with the camera at 'align' or 'locked'). RED for every other state,
// which covers the whole reset / pin-setting cycle, the ball in motion, the
// settling rack, the ball load and walk-up, and game over. Pure so the corrected
// timing is unit-tested directly: red throughout setting / loading / ball-in-
// motion, green only when set and ready.
export function throwLightFor(phase: ShotPhase, setup: ShotSetupPhase): ThrowLightState {
  return readyToAim(phase, setup) ? 'go' : 'wait';
}
