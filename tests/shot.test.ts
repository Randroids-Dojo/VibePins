import { describe, it, expect } from 'vitest';
import { ShotWatcher, type ShotConfig } from '../src/shot.js';

// A forgiving config for the unit: rest after 3 quiet steps, pit at z <= -10,
// hard timeout at 100 steps.
const cfg: ShotConfig = { atRestSpeed: 0.2, atRestFrames: 3, pitZ: -10, maxFrames: 100 };

describe('ShotWatcher: resolving a thrown ball (REQ-009)', () => {
  it('does not resolve before begin() is called', () => {
    const watcher = new ShotWatcher(cfg);
    expect(watcher.isWatching).toBe(false);
    expect(watcher.step(0, 0)).toBe(false);
    expect(watcher.resolved).toBe(false);
  });

  it('resolves once the ball holds at rest for atRestFrames', () => {
    const watcher = new ShotWatcher(cfg);
    watcher.begin();
    expect(watcher.step(0.1, -2)).toBe(false); // rest run 1
    expect(watcher.step(0.1, -2)).toBe(false); // rest run 2
    expect(watcher.step(0.1, -2)).toBe(true); // rest run 3 -> resolved
    expect(watcher.resolved).toBe(true);
    expect(watcher.isWatching).toBe(false);
  });

  it('does not call the shot early if the ball speeds back up mid-settle', () => {
    const watcher = new ShotWatcher(cfg);
    watcher.begin();
    watcher.step(0.1, -2); // rest 1
    watcher.step(0.1, -2); // rest 2
    expect(watcher.step(5, -3)).toBe(false); // fast again: run resets
    expect(watcher.step(0.1, -3)).toBe(false); // rest 1
    expect(watcher.step(0.1, -3)).toBe(false); // rest 2
    expect(watcher.step(0.1, -3)).toBe(true); // rest 3 -> resolved
  });

  it('resolves immediately when the ball clears the deck into the pit', () => {
    const watcher = new ShotWatcher(cfg);
    watcher.begin();
    // Still moving fast, but past the pit threshold: cannot return to the rack.
    expect(watcher.step(6, -10.5)).toBe(true);
    expect(watcher.resolved).toBe(true);
  });

  it('resolves at the hard timeout for a ball that never stills', () => {
    const watcher = new ShotWatcher({ ...cfg, maxFrames: 5 });
    watcher.begin();
    // Grinding in a gutter: always moving, never past the pit.
    for (let i = 0; i < 4; i += 1) expect(watcher.step(1, -1)).toBe(false);
    expect(watcher.step(1, -1)).toBe(true); // step 5 hits maxFrames
  });

  it('stays resolved and returns false on further steps', () => {
    const watcher = new ShotWatcher(cfg);
    watcher.begin();
    watcher.step(6, -10.5); // resolved by pit
    expect(watcher.step(0.1, -2)).toBe(false);
    expect(watcher.resolved).toBe(true);
  });

  it('re-arms on a fresh begin() for the next shot', () => {
    const watcher = new ShotWatcher(cfg);
    watcher.begin();
    watcher.step(6, -10.5);
    expect(watcher.resolved).toBe(true);
    watcher.begin();
    expect(watcher.resolved).toBe(false);
    expect(watcher.isWatching).toBe(true);
  });
});
