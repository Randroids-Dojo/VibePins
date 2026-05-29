import { describe, it, expect, vi } from 'vitest';
import { Scoreboard } from '../src/scoreboard.js';
import { scoreGame } from '../src/scoring.js';

// REQ-042 / RULE 10: the flip is observable motion, so verify the Scoreboard
// class actually toggles the .vp-flip class on the cells that changed (and only
// those), and that it respects reduce-motion. There is no jsdom in this repo, so
// we use a tiny fake DOM: a root that, after innerHTML is assigned, exposes one
// fake card per data-cell key found in the markup, each tracking its classList.

class FakeClassList {
  private set = new Set<string>();
  add(c: string): void {
    this.set.add(c);
  }
  remove(c: string): void {
    this.set.delete(c);
  }
  has(c: string): boolean {
    return this.set.has(c);
  }
}

class FakeCard {
  readonly classList = new FakeClassList();
}

class FakeRoot {
  private cards = new Map<string, FakeCard>();
  ownerDocument: { defaultView: { matchMedia: (q: string) => { matches: boolean }; setTimeout: typeof setTimeout } };

  constructor(reduceMotion = false) {
    this.ownerDocument = {
      defaultView: {
        matchMedia: () => ({ matches: reduceMotion }),
        setTimeout: ((fn: () => void) => setTimeout(fn, 0)) as unknown as typeof setTimeout,
      },
    };
  }

  set innerHTML(html: string) {
    this.cards.clear();
    const re = /data-cell="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) this.cards.set(m[1], new FakeCard());
  }

  querySelector(selector: string): FakeCard | null {
    const key = /data-cell="([^"]+)"/.exec(selector)?.[1];
    return key ? this.cards.get(key) ?? null : null;
  }

  card(key: string): FakeCard | undefined {
    return this.cards.get(key);
  }
}

describe('Scoreboard flip (REQ-042, RULE 10 observable motion)', () => {
  it('does not flip on the very first paint', () => {
    const root = new FakeRoot();
    const board = new Scoreboard(root as unknown as HTMLElement);
    board.render(scoreGame([[7]]));
    expect(root.card('f0b0')?.classList.has('vp-flip')).toBe(false);
  });

  it('flips only the cells whose glyph changed between paints', () => {
    const root = new FakeRoot();
    const board = new Scoreboard(root as unknown as HTMLElement);
    board.render(scoreGame([[7]]));
    board.render(scoreGame([[7, 2, 0]])); // open 9: ball2, ball3, cumulative move
    expect(root.card('f0b0')?.classList.has('vp-flip')).toBe(false);
    expect(root.card('f0b1')?.classList.has('vp-flip')).toBe(true);
    expect(root.card('f0c')?.classList.has('vp-flip')).toBe(true);
  });

  it('clears the flip class after the animation window', () => {
    vi.useFakeTimers();
    try {
      const root = new FakeRoot();
      const board = new Scoreboard(root as unknown as HTMLElement);
      board.render(scoreGame([[7]]));
      board.render(scoreGame([[7, 2, 0]]));
      expect(root.card('f0b1')?.classList.has('vp-flip')).toBe(true);
      vi.runAllTimers();
      expect(root.card('f0b1')?.classList.has('vp-flip')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flip when the user asks to reduce motion', () => {
    const root = new FakeRoot(true);
    const board = new Scoreboard(root as unknown as HTMLElement);
    board.render(scoreGame([[7]]));
    board.render(scoreGame([[7, 2, 0]]));
    expect(root.card('f0b1')?.classList.has('vp-flip')).toBe(false);
  });
});
