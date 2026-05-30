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
// continuing frame whose next ball faces ten is a rerack, not a clear.
export function rackActionFor(result: BallResult): RackAction {
  if (result.reset === 'none') return 'none';
  if (result.reset === 'rerack') return 'rerack';
  // result.reset === 'between-balls': the frame continues. If the next ball faces
  // a full rack the deck was cleared (a bonus-ball re-rack), so rerack; otherwise
  // lift the fallen pins clear and leave the standing ones (REQ-009).
  return result.pinsStanding === PINS ? 'rerack' : 'between-balls';
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
