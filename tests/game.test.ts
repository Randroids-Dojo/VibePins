import { describe, it, expect } from 'vitest';
import { Game } from '../src/game.js';
import { scoreGame } from '../src/scoring.js';

// Roll a frame's worth of balls into a game and return the last BallResult.
const roll = (game: Game, ...balls: number[]) => {
  let last = game.recordBall(balls[0]);
  for (let i = 1; i < balls.length; i += 1) last = game.recordBall(balls[i]);
  return last;
};

// Play nine identical open frames of [0,0,0] to set up a tenth-frame test.
const playNineOpenFrames = (game: Game): void => {
  for (let frame = 0; frame < 9; frame += 1) roll(game, 0, 0, 0);
};

describe('Game: ball-within-frame progression (REQ-002, REQ-009)', () => {
  it('continues the frame and runs a between-balls reset while pins stand', () => {
    const game = new Game();
    const first = game.recordBall(4);
    expect(first.outcome).toBe('await-ball');
    expect(first.reset).toBe('between-balls');
    expect(first.pinsStanding).toBe(6);
    expect(first.ballInFrame).toBe(1);
    // The next ball aims at the six pins that stayed standing.
    expect(game.pinsStanding).toBe(6);
    expect(game.currentBall).toBe(2);
  });

  it('clamps a noisy over-count to the pins actually standing', () => {
    const game = new Game();
    game.recordBall(4); // six remain
    const second = game.recordBall(9); // only six can fall
    expect(second.pinsDowned).toBe(6);
    expect(second.pinsStanding).toBe(0);
    // All ten down in two balls is a spare: the frame ends with a re-rack.
    expect(second.outcome).toBe('frame-reset');
    expect(second.reset).toBe('rerack');
  });

  it('ends the frame after three balls even with pins left standing (open)', () => {
    const game = new Game();
    expect(game.recordBall(3).outcome).toBe('await-ball');
    expect(game.recordBall(2).outcome).toBe('await-ball');
    const third = game.recordBall(1); // open frame, pins remain
    expect(third.outcome).toBe('frame-reset');
    expect(third.reset).toBe('rerack');
    expect(third.ballInFrame).toBe(3);
    // Advanced to a fresh frame with a full rack.
    expect(game.currentFrame).toBe(1);
    expect(game.pinsStanding).toBe(10);
  });
});

describe('Game: frame end and re-rack (REQ-010)', () => {
  it('ends the frame on a strike (ball one clears) and re-racks', () => {
    const game = new Game();
    const strike = game.recordBall(10);
    expect(strike.outcome).toBe('frame-reset');
    expect(strike.reset).toBe('rerack');
    expect(strike.ballInFrame).toBe(1);
    expect(game.currentFrame).toBe(1);
    expect(game.pinsStanding).toBe(10);
  });

  it('ends the frame on a spare (ball two clears) and re-racks', () => {
    const game = new Game();
    game.recordBall(7);
    const spare = game.recordBall(3);
    expect(spare.outcome).toBe('frame-reset');
    expect(spare.reset).toBe('rerack');
    expect(spare.ballInFrame).toBe(2);
  });
});

describe('Game: marks flow through to the scoring engine', () => {
  it('records a flat ten (cleared only on the third ball), not a spare', () => {
    const game = new Game();
    const result = roll(game, 4, 3, 3);
    expect(result.score.frames[0].mark).toBe('flat_ten');
    expect(result.score.frames[0].mark).not.toBe('spare');
  });

  it('builds a throw tape that scoreGame validates and totals', () => {
    const game = new Game();
    roll(game, 10); // strike, frame 0
    roll(game, 5, 4, 0); // open 9, frame 1
    const direct = scoreGame([[10], [5, 4, 0]]);
    expect(game.score).toEqual(direct);
    expect(game.score.valid).toBe(true);
  });
});

describe('Game: tenth frame bonus balls (REQ-007)', () => {
  it('grants two bonus balls after a tenth-frame strike', () => {
    const game = new Game();
    playNineOpenFrames(game);
    expect(game.currentFrame).toBe(9);
    const strike = game.recordBall(10); // fresh rack for bonus ball 1
    expect(strike.outcome).toBe('await-ball');
    expect(game.pinsStanding).toBe(10);
    const bonus1 = game.recordBall(7); // three remain
    expect(bonus1.outcome).toBe('await-ball');
    expect(game.pinsStanding).toBe(3);
    const bonus2 = game.recordBall(3);
    expect(bonus2.outcome).toBe('game-over');
    expect(bonus2.reset).toBe('none');
    expect(game.isOver).toBe(true);
  });

  it('re-racks between tenth-frame bonus balls when a bonus ball clears the deck', () => {
    const game = new Game();
    playNineOpenFrames(game);
    game.recordBall(10); // strike
    const bonus1 = game.recordBall(10); // bonus ball is itself a strike: fresh rack
    expect(bonus1.outcome).toBe('await-ball');
    expect(game.pinsStanding).toBe(10);
    const bonus2 = game.recordBall(10);
    expect(bonus2.outcome).toBe('game-over');
    expect(game.score.frames[9].balls).toEqual([10, 10, 10]);
  });

  it('grants one bonus ball after a tenth-frame spare', () => {
    const game = new Game();
    playNineOpenFrames(game);
    game.recordBall(6);
    const spare = game.recordBall(4); // spare: one bonus ball on a fresh rack
    expect(spare.outcome).toBe('await-ball');
    expect(game.pinsStanding).toBe(10);
    const bonus = game.recordBall(5);
    expect(bonus.outcome).toBe('game-over');
  });

  it('ends with no bonus on a tenth-frame open or flat ten', () => {
    const open = new Game();
    playNineOpenFrames(open);
    open.recordBall(3);
    open.recordBall(2);
    const last = open.recordBall(1); // open, three deck balls, no bonus
    expect(last.outcome).toBe('game-over');
    expect(open.isOver).toBe(true);
  });
});

describe('Game: game completion and summary (REQ-001, REQ-011)', () => {
  it('summary is null until the tenth frame resolves', () => {
    const game = new Game();
    expect(game.summary()).toBeNull();
  });

  it('a full open game ends complete with a final score and summary', () => {
    const game = new Game();
    for (let frame = 0; frame < 10; frame += 1) roll(game, 3, 3, 0); // 6 per frame
    expect(game.isOver).toBe(true);
    const summary = game.summary();
    expect(summary).not.toBeNull();
    expect(summary?.finalScore).toBe(60);
    expect(summary?.score.complete).toBe(true);
  });

  it('a perfect game of all strikes totals 300', () => {
    const game = new Game();
    for (let frame = 0; frame < 9; frame += 1) game.recordBall(10);
    // Tenth frame: strike plus two bonus strikes, each on a fresh rack.
    game.recordBall(10);
    game.recordBall(10);
    game.recordBall(10);
    expect(game.summary()?.finalScore).toBe(300);
  });

  it('rejects a ball after the game ends', () => {
    const game = new Game();
    for (let frame = 0; frame < 10; frame += 1) roll(game, 0, 0, 0);
    expect(game.isOver).toBe(true);
    expect(() => game.recordBall(0)).toThrow(/after the game ended/);
  });
});
