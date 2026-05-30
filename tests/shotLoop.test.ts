// Full-frame shot-loop sequencing (GDD 02-core-loop, 03-string-pinsetter). These
// tests drive the pure Game spine through whole multi-ball frames and assert the
// rack action and phase the live loop derives from each ball, the wiring that the
// playtest found broken:
//   - between balls the fallen pins are cleared and the standing ones remain, so
//     the next ball faces the remaining cluster, NOT a fresh rack (REQ-009).
//   - the frame only fully re-racks at frame end (or a strike / deck clear),
//     REQ-010.
//   - every ball that is not game-over routes through a reset and back to the
//     next throw (phase 'resetting'), never stalling: the second/third ball is
//     actually set up to be thrown again.
//
// These fail against the pre-fix wiring, where a between-balls reset re-stood the
// fallen pins (so the next ball wrongly faced a full rack) and a tenth-frame
// deck-clearing bonus ball was treated as a plain between-balls clear (so the
// bonus ball faced an empty deck).

import { describe, it, expect } from 'vitest';
import { Game, type BallResult } from '../src/game.js';
import { rackActionFor, phaseAfterRecord } from '../src/shotLoop.js';

// Record a ball and return both the Game result and the derived rack action, the
// exact pair the live loop computes per settled ball.
const play = (game: Game, downed: number): { result: BallResult; action: ReturnType<typeof rackActionFor> } => {
  const result = game.recordBall(downed);
  return { result, action: rackActionFor(result) };
};

describe('shot loop: full multi-ball frame sequencing', () => {
  it('clears fallen pins between balls and only re-racks at frame end', () => {
    const game = new Game();

    // Ball 1 downs four. Six stand; the loop clears the four fallen pins and the
    // SIX remaining pins are what ball 2 faces (not a fresh ten).
    const b1 = play(game, 4);
    expect(b1.action).toBe('between-balls');
    expect(b1.result.pinsStanding).toBe(6);
    expect(phaseAfterRecord(b1.action)).toBe('resetting');
    expect(game.pinsStanding).toBe(6); // ball 2 aims at the remaining six

    // Ball 2 downs three of the six. Three stand; still a between-balls clear, and
    // ball 3 faces the remaining three, never a re-rack.
    const b2 = play(game, 3);
    expect(b2.action).toBe('between-balls');
    expect(b2.result.pinsStanding).toBe(3);
    expect(game.pinsStanding).toBe(3);

    // Ball 3 ends the frame (three balls thrown): now and only now a full re-rack.
    const b3 = play(game, 1);
    expect(b3.action).toBe('rerack');
    expect(b3.result.outcome).toBe('frame-reset');

    // Next frame opens on a fresh full rack of ten.
    expect(game.pinsStanding).toBe(10);
    const next = play(game, 0);
    expect(next.result.frameIndex).toBe(1);
    expect(next.result.ballInFrame).toBe(1);
  });

  it('keeps the full rack on a clean first-ball miss instead of re-racking', () => {
    const game = new Game();
    // A clean miss downs nothing: ten still stand. The frame continues and the
    // next ball faces the same ten, but this is a between-balls clear (nothing to
    // lift), NOT a re-rack: a deck clear must be earned by actually downing pins.
    const miss = play(game, 0);
    expect(miss.result.pinsStanding).toBe(10);
    expect(miss.result.pinsDowned).toBe(0);
    expect(miss.action).toBe('between-balls');
    expect(game.pinsStanding).toBe(10);
  });

  it('re-racks immediately when an early ball clears the deck (a spare)', () => {
    const game = new Game();
    const b1 = play(game, 7); // three stand
    expect(b1.action).toBe('between-balls');
    const b2 = play(game, 3); // spare: deck cleared, frame ends -> re-rack
    expect(b2.action).toBe('rerack');
    expect(b2.result.outcome).toBe('frame-reset');
  });

  it('re-racks on a strike (frame ends on ball 1)', () => {
    const game = new Game();
    const strike = play(game, 10);
    expect(strike.action).toBe('rerack');
    expect(strike.result.outcome).toBe('frame-reset');
  });

  it('never reports game-over until the tenth frame resolves', () => {
    const game = new Game();
    // Nine open frames: every frame-end is a re-rack, never game-over.
    for (let frame = 0; frame < 9; frame += 1) {
      play(game, 0);
      play(game, 0);
      const last = play(game, 0);
      expect(last.result.outcome).toBe('frame-reset');
      expect(last.action).toBe('rerack');
    }
    expect(game.isOver).toBe(false);
  });
});

describe('shot loop: tenth-frame bonus deck clears re-rack (REQ-007)', () => {
  // Bowl nine open frames to reach the tenth.
  const reachTenth = (game: Game): void => {
    for (let frame = 0; frame < 9; frame += 1) {
      game.recordBall(0);
      game.recordBall(0);
      game.recordBall(0);
    }
  };

  it('a tenth-frame strike re-racks for the bonus balls instead of leaving an empty deck', () => {
    const game = new Game();
    reachTenth(game);
    // Ball 1 of the tenth is a strike: the deck is physically cleared, but two
    // bonus balls remain, so the loop must re-rack a fresh ten for the next ball,
    // not run a between-balls clear onto an empty deck.
    const strike = play(game, 10);
    expect(strike.result.outcome).toBe('await-ball');
    expect(strike.result.pinsStanding).toBe(10); // a fresh rack for the bonus ball
    expect(strike.action).toBe('rerack');
    expect(game.pinsStanding).toBe(10);

    // Bonus ball 1 downs four off the fresh rack: six remain, a between-balls clear.
    const bonus1 = play(game, 4);
    expect(bonus1.result.outcome).toBe('await-ball');
    expect(bonus1.action).toBe('between-balls');
    expect(game.pinsStanding).toBe(6);

    // Bonus ball 2 ends the game.
    const bonus2 = play(game, 2);
    expect(bonus2.result.outcome).toBe('game-over');
    expect(bonus2.action).toBe('none');
    expect(phaseAfterRecord(bonus2.action)).toBe('over');
  });

  it('a tenth-frame spare re-racks for the single bonus ball', () => {
    const game = new Game();
    reachTenth(game);
    const b1 = play(game, 6); // four stand
    expect(b1.action).toBe('between-balls');
    const spare = play(game, 4); // spare clears the deck; one bonus ball remains
    expect(spare.result.outcome).toBe('await-ball');
    expect(spare.result.pinsStanding).toBe(10);
    expect(spare.action).toBe('rerack');
    const bonus = play(game, 5); // bonus ball ends the game
    expect(bonus.result.outcome).toBe('game-over');
    expect(bonus.action).toBe('none');
  });

  it('an open tenth frame never re-racks mid-frame and ends the game on ball 3', () => {
    const game = new Game();
    reachTenth(game);
    const b1 = play(game, 3); // seven stand
    expect(b1.action).toBe('between-balls');
    expect(game.pinsStanding).toBe(7);
    const b2 = play(game, 2); // five stand, deck not cleared
    expect(b2.action).toBe('between-balls');
    expect(game.pinsStanding).toBe(5);
    const b3 = play(game, 1); // open tenth, game over
    expect(b3.result.outcome).toBe('game-over');
    expect(b3.action).toBe('none');
  });
});
