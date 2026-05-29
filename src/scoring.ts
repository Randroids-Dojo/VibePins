// Duckpin scoring engine (GDD 02-core-loop, REQ-001 to REQ-008).
//
// Pure, framework-free, and JSON-serializable so the same module scores games
// in the browser and validates submissions server-side (REQ-053 multiplayer
// authority, REQ-059 leaderboard rejection of impossible scores).
//
// Duckpin differs from tenpin in two ways that this module encodes:
//   1. Three balls per frame, not two (REQ-002).
//   2. Clearing all ten only on the third ball is a candlepin-style "flat ten":
//      a flat 10 with NO bonus. It is NOT a spare (REQ-005). A spare is all ten
//      down within the first two balls (REQ-004); a strike is all ten on ball
//      one (REQ-003). Open frames score the pins knocked down (REQ-006).
//
// A game is up to ten frames (fewer while in progress). Strike scores 10 plus
// the next two balls; spare 10 plus the next one ball; these resolve from the
// flat throw sequence, so bonuses span later frames and into the tenth. The
// tenth frame grants two bonus balls for a strike, one for a spare, none for a
// flat ten or open frame (REQ-007). Bonus balls re-rack only as needed: the
// second bonus ball after a tenth strike hits the remaining pins unless the
// first bonus ball was itself a strike (open question Q-011, default A).

export type FrameMark = 'strike' | 'spare' | 'flat_ten' | 'open';

export interface FrameScore {
  readonly frameIndex: number;
  // null while a frame is in progress and cannot yet be classified.
  readonly mark: FrameMark | null;
  readonly balls: number[];
  // null while a strike/spare bonus is still pending.
  readonly score: number | null;
  // Running total; null from the first pending frame onward.
  readonly cumulative: number | null;
  readonly bonusPending: boolean;
}

export interface GameScore {
  readonly frames: FrameScore[];
  // Non-null only when the game is complete.
  readonly finalScore: number | null;
  readonly complete: boolean;
  readonly valid: boolean;
  readonly error: string | null;
}

// Input: per-frame ball pinfalls in throw order, e.g. [[10],[6,3,0],...].
export type GameFrames = readonly (readonly number[])[];

export const FRAME_COUNT = 10;
const PINS = 10;

// Classify a single frame by its scoring balls. Returns null when the frame is
// still in progress (too few balls to decide). The tenth frame uses the same
// rules: its first balls determine strike / spare / flat ten / open.
export function classifyFrameMark(balls: readonly number[]): FrameMark | null {
  if (balls.length >= 1 && balls[0] === PINS) return 'strike';
  if (balls.length >= 2 && balls[0] < PINS && balls[0] + balls[1] === PINS) return 'spare';
  if (balls.length === 3 && balls[0] + balls[1] < PINS) {
    return balls[0] + balls[1] + balls[2] === PINS ? 'flat_ten' : 'open';
  }
  // All three balls of a non-tenth frame always classify above; only an
  // in-progress prefix (the last frame of a game in play) returns null.
  return null;
}

// The flat ball sequence across every frame in throw order, including the
// tenth-frame bonus balls. This is the lookup tape for bonus resolution.
export function flattenAllBalls(frames: GameFrames): number[] {
  const tape: number[] = [];
  for (const frame of frames) for (const ball of frame) tape.push(ball);
  return tape;
}

function validateNormalFrame(balls: readonly number[], frameIndex: number, isLast: boolean): string | null {
  const label = `frame ${frameIndex + 1}`;
  if (balls.length > 3) return `${label} has more than three balls`;
  let run = 0;
  for (const ball of balls) {
    run += ball;
    if (run > PINS) return `${label} knocks down more than ten pins`;
  }
  if (balls[0] === PINS) {
    return balls.length === 1 ? null : `${label} continues after a strike`;
  }
  if (balls.length >= 2 && balls[0] + balls[1] === PINS) {
    return balls.length === 2 ? null : `${label} continues after a spare`;
  }
  if (balls.length === 3) return null; // open or flat ten, fully thrown
  // One or two balls without clearing: only legal as the in-progress last frame.
  return isLast ? null : `${label} is incomplete`;
}

function validateTenthFrame(balls: readonly number[]): string | null {
  const label = 'tenth frame';
  if (balls.length > 3) return `${label} has more than three balls`;
  if (balls[0] === PINS) {
    // Strike: two bonus balls. The second re-racks only if the first cleared all.
    if (balls.length === 3 && balls[1] < PINS && balls[1] + balls[2] > PINS) {
      return `${label} bonus balls knock down more than ten pins`;
    }
    return null;
  }
  if (balls.length >= 2 && balls[0] + balls[1] > PINS) {
    return `${label} knocks down more than ten pins`;
  }
  if (balls.length >= 2 && balls[0] + balls[1] === PINS) {
    return null; // spare: one bonus ball on a fresh rack
  }
  if (balls.length === 3 && balls[0] + balls[1] + balls[2] > PINS) {
    return `${label} knocks down more than ten pins`;
  }
  return null;
}

// Boundary validation. Never throws; returns a structured result. Rejects only
// genuinely impossible inputs (out-of-range or non-integer pins, more than ten
// pins down within a rack, malformed frame structure, wrong frame count). An
// in-progress game with a partial last frame is valid, not invalid.
export function validateGameInput(frames: GameFrames): { valid: boolean; error: string | null } {
  if (!Array.isArray(frames)) return { valid: false, error: 'frames must be an array' };
  if (frames.length < 1 || frames.length > FRAME_COUNT) {
    return { valid: false, error: `a game has 1 to ${FRAME_COUNT} frames, got ${frames.length}` };
  }
  for (let i = 0; i < frames.length; i += 1) {
    const balls = frames[i];
    if (!Array.isArray(balls) || balls.length === 0) {
      return { valid: false, error: `frame ${i + 1} has no balls` };
    }
    for (const ball of balls) {
      if (!Number.isInteger(ball) || ball < 0 || ball > PINS) {
        return { valid: false, error: `frame ${i + 1} has an illegal ball value ${ball}` };
      }
    }
    const error =
      i === FRAME_COUNT - 1
        ? validateTenthFrame(balls)
        : validateNormalFrame(balls, i, i === frames.length - 1);
    if (error) return { valid: false, error };
  }
  return { valid: true, error: null };
}

const sum = (balls: readonly number[]): number => balls.reduce((total, ball) => total + ball, 0);

// A complete tenth frame always has exactly three balls: strike (10 + two
// bonus), spare (two balls + one bonus), or flat ten / open (three deck balls).
function tenthResolved(balls: readonly number[]): boolean {
  return balls.length === 3;
}

export function scoreGame(frames: GameFrames): GameScore {
  const validation = validateGameInput(frames);
  if (!validation.valid) {
    return { frames: [], finalScore: null, complete: false, valid: false, error: validation.error };
  }

  const tape = flattenAllBalls(frames);
  const frameScores: FrameScore[] = [];
  let cursor = 0; // index in the tape of the current frame's first ball
  let cumulative = 0;
  let runningBroken = false;

  for (let i = 0; i < frames.length; i += 1) {
    const balls = frames[i];
    const isTenth = i === FRAME_COUNT - 1;
    const mark = classifyFrameMark(balls);

    let score: number | null;
    let pending = false;

    if (isTenth) {
      if (tenthResolved(balls)) {
        score = sum(balls);
      } else {
        score = null;
        pending = true;
      }
    } else if (mark === 'strike') {
      const b1 = tape[cursor + 1];
      const b2 = tape[cursor + 2];
      if (b1 !== undefined && b2 !== undefined) {
        score = PINS + b1 + b2;
      } else {
        score = null;
        pending = true;
      }
    } else if (mark === 'spare') {
      const bonus = tape[cursor + 2];
      if (bonus !== undefined) {
        score = PINS + bonus;
      } else {
        score = null;
        pending = true;
      }
    } else if (mark === 'flat_ten' || mark === 'open') {
      score = sum(balls);
    } else {
      // In-progress last frame: not yet scorable.
      score = null;
      pending = true;
    }

    let cumulativeScore: number | null;
    if (runningBroken || score === null) {
      cumulativeScore = null;
      runningBroken = true;
    } else {
      cumulative += score;
      cumulativeScore = cumulative;
    }

    frameScores.push({
      frameIndex: i,
      mark,
      balls: [...balls],
      score,
      cumulative: cumulativeScore,
      bonusPending: pending,
    });
    cursor += balls.length;
  }

  const complete =
    frames.length === FRAME_COUNT && frameScores.every((frame) => !frame.bonusPending && frame.score !== null);
  return {
    frames: frameScores,
    finalScore: complete ? cumulative : null,
    complete,
    valid: true,
    error: null,
  };
}
