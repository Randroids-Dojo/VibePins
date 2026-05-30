import { describe, it, expect, vi } from 'vitest';
import { Screens, type Screen } from '../src/screens.js';

// The shell state machine (REQ-045) only allows the small one-directional graph:
//   menu -> playing -> summary -> playing | menu.

describe('Screens: menu / playing / summary state machine (REQ-045)', () => {
  it('boots to the menu by default', () => {
    expect(new Screens().screen).toBe('menu');
  });

  it('honours an explicit initial screen', () => {
    expect(new Screens('playing').screen).toBe('playing');
  });

  it('starts a game from the menu', () => {
    const s = new Screens('menu');
    expect(s.start()).toBe(true);
    expect(s.screen).toBe('playing');
  });

  it('finishes a game from playing into the summary', () => {
    const s = new Screens('playing');
    expect(s.finish()).toBe(true);
    expect(s.screen).toBe('summary');
  });

  it('plays again from the summary back into playing', () => {
    const s = new Screens('summary');
    expect(s.playAgain()).toBe(true);
    expect(s.screen).toBe('playing');
  });

  it('returns to the menu from the summary', () => {
    const s = new Screens('summary');
    expect(s.toMenu()).toBe(true);
    expect(s.screen).toBe('menu');
  });

  it('rejects illegal transitions and leaves the screen unchanged', () => {
    const s = new Screens('menu');
    expect(s.finish()).toBe(false); // cannot finish from the menu
    expect(s.playAgain()).toBe(false); // cannot play-again from the menu
    expect(s.toMenu()).toBe(false); // already on the menu
    expect(s.screen).toBe('menu');

    const playing = new Screens('playing');
    expect(playing.start()).toBe(false); // already playing
    expect(playing.playAgain()).toBe(false);
    expect(playing.toMenu()).toBe(false);
    expect(playing.screen).toBe('playing');
  });

  it('opens the match hub from the menu and backs out to the menu (REQ-050/051)', () => {
    const s = new Screens('menu');
    expect(s.openMatch()).toBe(true);
    expect(s.screen).toBe('match');
    expect(s.toMenu()).toBe(true);
    expect(s.screen).toBe('menu');
  });

  it('rejects opening the match hub from anywhere but the menu', () => {
    const playing = new Screens('playing');
    expect(playing.openMatch()).toBe(false);
    expect(playing.screen).toBe('playing');

    const summary = new Screens('summary');
    expect(summary.openMatch()).toBe(false);
    expect(summary.screen).toBe('summary');

    const match = new Screens('match');
    expect(match.openMatch()).toBe(false); // already in the hub
    expect(match.screen).toBe('match');
  });

  it('does not start a game or finish from the match hub', () => {
    const s = new Screens('match');
    expect(s.start()).toBe(false);
    expect(s.finish()).toBe(false);
    expect(s.playAgain()).toBe(false);
    expect(s.screen).toBe('match');
  });

  it('notifies the listener on every transition with the previous screen', () => {
    const s = new Screens('menu');
    const seen: Array<[Screen, Screen]> = [];
    s.onChange((screen, previous) => seen.push([screen, previous]));

    s.start();
    s.finish();
    s.toMenu();

    expect(seen).toEqual([
      ['playing', 'menu'],
      ['summary', 'playing'],
      ['menu', 'summary'],
    ]);
  });

  it('does not notify on a rejected transition', () => {
    const s = new Screens('menu');
    const listener = vi.fn();
    s.onChange(listener);
    expect(s.finish()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const s = new Screens('menu');
    const listener = vi.fn();
    const off = s.onChange(listener);
    off();
    s.start();
    expect(listener).not.toHaveBeenCalled();
  });

  it('replaces the listener when a second one registers', () => {
    const s = new Screens('menu');
    const first = vi.fn();
    const second = vi.fn();
    s.onChange(first);
    s.onChange(second);
    s.start();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
