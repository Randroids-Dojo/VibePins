import { describe, it, expect } from 'vitest';
import {
  scoreGame,
  classifyFrameMark,
  flattenAllBalls,
  validateGameInput,
  type GameFrames,
} from '../src/scoring.js';

// n open zero-frames, for padding a game out to ten frames.
const zeros = (n: number): number[][] => Array.from({ length: n }, () => [0, 0, 0]);

describe('classifyFrameMark', () => {
  it('strike: ten on the first ball', () => {
    expect(classifyFrameMark([10])).toBe('strike');
  });
  it('spare: ten on the first two balls, first under ten', () => {
    expect(classifyFrameMark([6, 4])).toBe('spare');
  });
  it('flat ten: cleared only on the third ball, and NOT a spare', () => {
    expect(classifyFrameMark([4, 3, 3])).toBe('flat_ten');
    // The defining duckpin distinction: a third-ball clear is not a spare.
    expect(classifyFrameMark([4, 3, 3])).not.toBe('spare');
  });
  it('open: pins remain after three balls', () => {
    expect(classifyFrameMark([3, 4, 2])).toBe('open');
  });
  it('in-progress frame is unclassified', () => {
    expect(classifyFrameMark([3])).toBeNull();
    expect(classifyFrameMark([3, 4])).toBeNull();
  });
});

describe('flattenAllBalls', () => {
  it('flattens frames into one throw-ordered tape', () => {
    expect(flattenAllBalls([[10], [6, 3, 0], [10, 7, 2]])).toEqual([10, 6, 3, 0, 10, 7, 2]);
  });
});

// Each entry is [name, frames, expectedFinalScore]. Totals were computed and
// verified by hand from the GDD rules.
const FULL_GAMES: Array<[string, GameFrames, number]> = [
  ['strike then open carries the next two balls', [[10], [3, 4, 2], ...zeros(8)], 26],
  ['spare carries the next one ball', [[6, 4], [3, 0, 0], ...zeros(8)], 16],
  ['flat ten scores a flat 10 with no bonus', [[4, 3, 3], ...zeros(9)], 10],
  ['open scores the pins knocked', [[3, 4, 2], ...zeros(9)], 9],
  ['spare bonus is exactly one ball', [[5, 5], [8, 1, 0], ...zeros(8)], 27],
  ['strike bonus is exactly two balls', [[10], [6, 3, 0], ...zeros(8)], 28],
  ['two consecutive strikes', [[10], [10], [5, 0, 0], ...zeros(7)], 45],
  ['four consecutive strikes', [[10], [10], [10], [10], ...zeros(6)], 90],
  ['strike then spare', [[10], [6, 4], [3, 0, 0], ...zeros(7)], 36],
  ['strike then spare with high counts', [[10], [7, 3], [9, 0, 0], ...zeros(7)], 48],
  ['back-to-back spares chain single-ball bonuses', [[6, 4], [5, 5], [7, 3], ...zeros(7)], 42],
  ['flat ten earns no carry-over bonus from the next frame', [[4, 3, 3], [8, 0, 0], ...zeros(8)], 18],
  ['flat ten between opens is frame-independent', [[5, 3, 0], [4, 3, 3], [7, 2, 0], ...zeros(7)], 27],
  ['tenth strike adds two bonus balls', [...zeros(9), [10, 7, 2]], 19],
  ['tenth strike whose first bonus ball is a strike', [...zeros(9), [10, 10, 7]], 27],
  ['tenth spare adds one bonus ball', [...zeros(9), [6, 4, 8]], 18],
  ['tenth spare whose bonus ball is a fresh strike', [...zeros(9), [7, 3, 10]], 20],
  ['tenth flat ten scores a flat 10', [...zeros(9), [3, 4, 3]], 10],
  ['tenth open scores the pins', [...zeros(9), [4, 3, 2]], 9],
  ['ninth strike draws its bonus from the tenth', [...zeros(8), [10], [3, 2, 1]], 21],
  ['ninth strike draws its bonus from a tenth flat ten', [...zeros(8), [10], [4, 3, 3]], 27],
  ['ninth spare draws its bonus from a tenth strike', [...zeros(8), [6, 4], [10, 10, 8]], 48],
  ['ninth spare draws its bonus from a tenth spare', [...zeros(8), [7, 3], [5, 5, 8]], 33],
  ['eighth spare, ninth strike, tenth strike layered bonuses', [...zeros(7), [6, 4], [10], [10, 8, 1]], 67],
  ['eighth strike chained through a ninth and tenth strike', [...zeros(7), [10], [10], [10, 8, 1]], 77],
  ['perfect game totals 300', [[10], [10], [10], [10], [10], [10], [10], [10], [10], [10, 10, 10]], 300],
  ['all-gutter game totals 0', zeros(10), 0],
  ['all spares of five total 150', [[5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5], [5, 5, 5]], 150],
  ['nine strikes then an open tenth', [[10], [10], [10], [10], [10], [10], [10], [10], [10], [3, 2, 1]], 254],
  [
    'realistic mixed game across all four marks',
    [[5, 3, 0], [6, 4], [10], [2, 5, 1], [7, 3], [8, 1, 0], [10], [4, 3, 3], [9, 1], [3, 4, 2]],
    129,
  ],
];

describe('scoreGame full games', () => {
  for (const [name, frames, expected] of FULL_GAMES) {
    it(`${name} (= ${expected})`, () => {
      const result = scoreGame(frames);
      expect(result.valid).toBe(true);
      expect(result.complete).toBe(true);
      expect(result.finalScore).toBe(expected);
    });
  }

  it('flat ten frame is marked flat_ten and scores exactly 10, never a spare bonus', () => {
    const result = scoreGame([[4, 3, 3], [8, 0, 0], ...zeros(8)]);
    expect(result.frames[0].mark).toBe('flat_ten');
    expect(result.frames[0].score).toBe(10);
  });

  it('reports per-frame marks and running cumulative totals', () => {
    const result = scoreGame([[10], [6, 4], [3, 0, 0], ...zeros(7)]);
    expect(result.frames.map((f) => f.mark)).toEqual([
      'strike', 'spare', 'open', 'open', 'open', 'open', 'open', 'open', 'open', 'open',
    ]);
    expect(result.frames[0].cumulative).toBe(20); // 10 + 6 + 4
    expect(result.frames[1].cumulative).toBe(33); // + 10 + 3
    expect(result.frames[2].cumulative).toBe(36); // + 3
  });

  it('builds the perfect game cumulative ladder in steps of thirty', () => {
    const perfect = scoreGame([[10], [10], [10], [10], [10], [10], [10], [10], [10], [10, 10, 10]]);
    expect(perfect.frames.map((f) => f.cumulative)).toEqual([30, 60, 90, 120, 150, 180, 210, 240, 270, 300]);
  });

  it('pins every per-frame mark, score, and cumulative for a mixed game', () => {
    const result = scoreGame(
      [[5, 3, 0], [6, 4], [10], [2, 5, 1], [7, 3], [8, 1, 0], [10], [4, 3, 3], [9, 1], [3, 4, 2]],
    );
    expect(result.frames.map((f) => f.mark)).toEqual([
      'open', 'spare', 'strike', 'open', 'spare', 'open', 'strike', 'flat_ten', 'spare', 'open',
    ]);
    expect(result.frames.map((f) => f.score)).toEqual([8, 20, 17, 8, 18, 9, 17, 10, 13, 9]);
    expect(result.frames.map((f) => f.cumulative)).toEqual([8, 28, 45, 53, 71, 80, 97, 107, 120, 129]);
  });
});

describe('scoreGame incomplete games', () => {
  it('a ninth-frame strike with no tenth yet is pending', () => {
    const result = scoreGame([...zeros(8), [10]]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.finalScore).toBeNull();
    const ninth = result.frames[8];
    expect(ninth.mark).toBe('strike');
    expect(ninth.bonusPending).toBe(true);
    expect(ninth.score).toBeNull();
    expect(ninth.cumulative).toBeNull();
  });

  it('a tenth strike awaiting its second bonus ball is pending', () => {
    const result = scoreGame([...zeros(9), [10, 7]]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.finalScore).toBeNull();
    expect(result.frames[9].mark).toBe('strike');
    expect(result.frames[9].bonusPending).toBe(true);
  });

  it('a partial tenth frame is valid but incomplete and unclassified', () => {
    const result = scoreGame([...zeros(9), [4, 3]]);
    expect(result.valid).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.finalScore).toBeNull();
    expect(result.frames[9].mark).toBeNull();
  });
});

describe('scoreGame validation', () => {
  const REJECTED: Array<[string, GameFrames]> = [
    ['a ball over ten pins', [[11, 0, 0], ...zeros(9)]],
    ['a negative ball', [[-1, 5, 0], ...zeros(9)]],
    ['a non-integer ball', [[3.5, 6, 0], ...zeros(9)]],
    ['more than ten pins within a frame', [...zeros(3), [7, 5, 0], ...zeros(6)]],
    ['eleven frames', zeros(11)],
    ['a ball after a spare clears the frame', [[6, 4, 0], ...zeros(9)]],
    ['a ball after a strike ends the frame', [[10, 3], ...zeros(9)]],
    ['tenth bonus balls exceeding the shared rack', [...zeros(9), [10, 7, 6]]],
    ['an empty frame with no balls', [[], [0, 0, 0], ...zeros(8)]],
  ];

  for (const [name, frames] of REJECTED) {
    it(`rejects ${name}`, () => {
      const result = scoreGame(frames);
      expect(result.valid).toBe(false);
      expect(result.finalScore).toBeNull();
      expect(result.error).toBeTruthy();
    });
  }

  it('accepts a tenth strike whose bonus balls re-rack after a strike', () => {
    expect(validateGameInput([...zeros(9), [10, 10, 7]]).valid).toBe(true);
  });
});

describe('scoreGame serialization (REQ-053 persistence)', () => {
  it('round-trips losslessly through JSON', () => {
    const result = scoreGame([[10], [6, 3, 0], [6, 4], [3, 0, 0], [10], [10], [5, 5], [8, 1, 0], [4, 4, 1], [10, 7, 2]]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.complete).toBe(true);
  });
});
