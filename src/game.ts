// Game-loop orchestrator (GDD 02-core-loop, REQ-001, REQ-002, REQ-009, REQ-010,
// REQ-011). This is the spine that turns the isolated systems into a game: it
// consumes the pinfall of each ball (the count of pins that fell on that ball,
// as decided by the settle-window detection in src/detection.ts), tracks the
// frame and ball within the frame, decides whether the current frame continues
// or ends, and tells the caller which reset to run between balls vs at frame
// end. It composes the scoring engine (src/scoring.ts) for marks and totals and
// surfaces game completion plus a final summary.
//
// Pure: no Three.js, no Rapier, no clock. The physics/render layer feeds it a
// pinfall count per ball and reacts to the returned outcome (run a between-balls
// reset, run a full re-rack, or end the game). Because it is pure and
// JSON-serializable it can also drive a server-side replay/validation later.
//
// Duckpin specifics this encodes (see src/scoring.ts for the scoring half):
//   - Three balls per frame to clear ten pins (REQ-002).
//   - Standing pins stay on the deck between balls; only fallen pins are lifted
//     (REQ-009). So the next ball in a frame is thrown at the remaining pins,
//     and the running downed count within a frame is cumulative.
//   - At frame end all ten pins are re-racked (REQ-010).
//   - The tenth frame grants bonus balls: two for a strike, one for a spare,
//     none for a flat ten or open frame (REQ-007). Bonus balls re-rack only as
//     needed: a strike or a spared bonus ball clears the deck for the next bonus
//     ball; otherwise the bonus ball continues on the standing pins (Q-011
//     default A, matching the tenth-frame validation in src/scoring.ts).
//   - After the tenth frame the game ends with a final score and summary
//     (REQ-011).

import { FRAME_COUNT, scoreGame, type GameScore } from './scoring.js';

const PINS = 10;
const MAX_BALLS_PER_FRAME = 3;

// What the caller should do after recording a ball. The physics/render layer
// maps these onto the reset cycle (src/reset.ts) and the app shell:
//   - 'await-ball'   the same frame continues; throw again at the pins that
//                    remain standing (run a between-balls reset of fallen pins).
//   - 'frame-reset'  the frame ended; re-rack all ten and advance to the next
//                    frame (run a full re-rack), then throw.
//   - 'game-over'    the tenth frame is resolved; the game is complete.
export type GameOutcome = 'await-ball' | 'frame-reset' | 'game-over';

// What reset the caller should run to honour the outcome. 'between-balls' lifts
// only the fallen pins and leaves standing pins in place (REQ-009); 'rerack'
// lifts all ten back onto their home spots (REQ-010); 'none' on game over.
export type GameReset = 'between-balls' | 'rerack' | 'none';

export interface BallResult {
  // The outcome of the ball just recorded.
  readonly outcome: GameOutcome;
  // The reset the caller should run before the next throw.
  readonly reset: GameReset;
  // Pins downed by this ball (echoed back, clamped to what was standing).
  readonly pinsDowned: number;
  // Pins still standing on the deck after this ball, before any reset runs.
  readonly pinsStanding: number;
  // Zero-based frame index this ball belonged to.
  readonly frameIndex: number;
  // One-based ball number within that frame (1, 2, 3, plus tenth-frame bonuses).
  readonly ballInFrame: number;
  // The live score after this ball (running totals, marks, completion).
  readonly score: GameScore;
}

export interface GameSummary {
  readonly finalScore: number;
  readonly score: GameScore;
}

// The frame/ball state machine. Drive it by calling recordBall(pinsDowned) once
// per settled ball. It accumulates the throw sequence and defers all scoring to
// scoreGame, so there is exactly one source of truth for marks and totals.
export class Game {
  // Per-frame ball pinfalls in throw order, e.g. [[10],[6,3,0],...]. This is the
  // GameFrames tape that scoreGame consumes. A finished non-tenth frame does not
  // eagerly open a trailing empty frame (scoreGame rejects an empty frame); the
  // next frame is opened lazily when its first ball is recorded. closed marks
  // that the current (last) frame has ended and the next ball starts a new one.
  private readonly frames: number[][] = [[]];
  private closed = false;
  private over = false;

  // Zero-based index of the frame the next ball belongs to. When the current
  // frame is closed, the next ball opens the following frame.
  get currentFrame(): number {
    return this.closed ? this.frames.length : this.frames.length - 1;
  }

  // One-based ball number about to be thrown in the current frame.
  get currentBall(): number {
    return this.closed ? 1 : this.frames[this.frames.length - 1].length + 1;
  }

  // Pins still standing for the next ball (what it aims at). After a re-rack (a
  // fresh frame, or a bonus ball that cleared the deck) this is ten.
  get pinsStanding(): number {
    if (this.closed) return PINS;
    return PINS - this.downedOnCurrentRack();
  }

  get isOver(): boolean {
    return this.over;
  }

  // The live score for the game so far.
  get score(): GameScore {
    return scoreGame(this.frames);
  }

  // Record the pinfall of one ball. `pinsDowned` is the count of pins that fell
  // on this ball (0..pinsStanding); it is clamped to the pins actually standing,
  // so an out-of-range reading from a noisy settle never produces an illegal
  // throw sequence. Returns what the caller should do next.
  recordBall(pinsDowned: number): BallResult {
    if (this.over) {
      throw new Error('VibePins: recordBall called after the game ended.');
    }

    // Open the next frame lazily if the previous one closed.
    if (this.closed) {
      this.frames.push([]);
      this.closed = false;
    }

    const standingBefore = this.pinsStanding;
    const downed = clamp(Math.round(pinsDowned), 0, standingBefore);
    const frameIndex = this.frames.length - 1;
    const ballInFrame = this.frames[frameIndex].length + 1;
    this.frames[frameIndex].push(downed);

    const isTenth = frameIndex === FRAME_COUNT - 1;
    const frameDone = isTenth ? this.tenthFrameDone() : this.normalFrameDone();

    let outcome: GameOutcome;
    let reset: GameReset;
    if (!frameDone) {
      // Same frame continues: lift only the fallen pins, standing pins stay.
      outcome = 'await-ball';
      reset = 'between-balls';
    } else if (isTenth) {
      this.over = true;
      outcome = 'game-over';
      reset = 'none';
    } else {
      // Frame ended before the tenth: full re-rack. The next frame opens lazily
      // when its first ball is recorded, so no trailing empty frame is left.
      this.closed = true;
      outcome = 'frame-reset';
      reset = 'rerack';
    }

    return {
      outcome,
      reset,
      pinsDowned: downed,
      pinsStanding: PINS - this.downedOnRack(frameIndex),
      frameIndex,
      ballInFrame,
      score: scoreGame(this.frames),
    };
  }

  // The final summary, available only once the game is over (REQ-011).
  summary(): GameSummary | null {
    if (!this.over) return null;
    const score = scoreGame(this.frames);
    // A completed game always scores; finalScore is non-null here by construction.
    return { finalScore: score.finalScore ?? 0, score };
  }

  // Pins downed on the live physical rack for the open (last) frame. A normal
  // frame is one rack, so this is the running sum. The tenth frame re-racks
  // after a deck-clearing ball (strike, or a spare/clear that consumed the rack),
  // so its bonus balls start from a fresh rack of ten. Only meaningful while a
  // frame is open (the caller guards on `closed`).
  private downedOnCurrentRack(): number {
    return this.downedOnRack(this.frames.length - 1);
  }

  // Pins downed on the live rack within the given frame, accounting for the
  // tenth frame's bonus-ball re-racks.
  private downedOnRack(frameIndex: number): number {
    const balls = this.frames[frameIndex];
    return frameIndex === FRAME_COUNT - 1 ? tenthRackDowned(balls) : sum(balls);
  }

  // A normal (non-tenth) frame ends when all ten are down or three balls thrown.
  private normalFrameDone(): boolean {
    const balls = this.frames[this.frames.length - 1];
    return sum(balls) >= PINS || balls.length >= MAX_BALLS_PER_FRAME;
  }

  // The tenth frame ends per the bonus-ball rules (REQ-007):
  //   strike on ball 1   -> two bonus balls (3 balls total)
  //   spare in balls 1-2 -> one bonus ball (3 balls total)
  //   otherwise          -> three deck balls (flat ten or open), no bonus
  // In every resolved case the tenth frame holds exactly three balls, matching
  // the validation in src/scoring.ts.
  private tenthFrameDone(): boolean {
    return this.frames[this.frames.length - 1].length >= MAX_BALLS_PER_FRAME;
  }
}

// Pins downed on the live rack in the tenth frame, accounting for the bonus-ball
// re-racks. The first ball is on a fresh rack. A strike (ball 1 == 10) or a
// spare (ball 1 + ball 2 == 10) re-racks for the following bonus ball; a bonus
// ball that itself clears the deck re-racks for the next one. So the live rack
// is the run of balls since the most recent deck clear.
function tenthRackDowned(balls: readonly number[]): number {
  let rack = 0;
  for (const ball of balls) {
    rack += ball;
    if (rack >= PINS) rack = 0; // deck cleared: the next ball is a fresh rack
  }
  return rack;
}

const sum = (balls: readonly number[]): number => balls.reduce((total, ball) => total + ball, 0);

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
