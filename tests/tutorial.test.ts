import { describe, it, expect } from 'vitest';
import { Tutorial } from '../src/tutorial.js';

// The first-run coach is a pure three-step state machine (REQ-047): it walks a
// new player through line up, spin, power, then retires after the first throw.
describe('Tutorial: first-run control coach (REQ-047)', () => {
  it('arms for a player who has not seen it', () => {
    const t = new Tutorial(false);
    expect(t.active).toBe(true);
    expect(t.step).toBe('lineup');
  });

  it('stays disarmed for a player who already saw it', () => {
    const t = new Tutorial(true);
    expect(t.active).toBe(false);
    expect(t.hint()).toBeNull();
  });

  it('begin() resets to the first step while armed', () => {
    const t = new Tutorial(false);
    t.advance(); // -> spin
    t.begin();
    expect(t.step).toBe('lineup');
    expect(t.hint()?.index).toBe(1);
  });

  it('walks lineup -> spin -> power across confirms', () => {
    const t = new Tutorial(false);
    expect(t.step).toBe('lineup');
    expect(t.advance()).toBe(false);
    expect(t.step).toBe('spin');
    expect(t.advance()).toBe(false);
    expect(t.step).toBe('power');
  });

  it('the third confirm completes the tutorial and disarms it', () => {
    const t = new Tutorial(false);
    t.advance(); // lineup -> spin
    t.advance(); // spin -> power
    expect(t.advance()).toBe(true); // power -> done
    expect(t.active).toBe(false);
    expect(t.hint()).toBeNull();
  });

  it('exposes a one-line hint per step with a 1-based index', () => {
    const t = new Tutorial(false);
    const lineup = t.hint();
    expect(lineup).toMatchObject({ step: 'lineup', index: 1, total: 3, label: 'Line up' });
    expect(lineup?.instruction.length).toBeGreaterThan(0);
    t.advance();
    expect(t.hint()).toMatchObject({ step: 'spin', index: 2, total: 3, label: 'Spin' });
    t.advance();
    expect(t.hint()).toMatchObject({ step: 'power', index: 3, total: 3, label: 'Power' });
  });

  it('advance() is a no-op once disarmed', () => {
    const t = new Tutorial(true);
    expect(t.advance()).toBe(false);
    expect(t.active).toBe(false);
  });

  it('begin() does not re-arm a disarmed (already-seen) tutorial', () => {
    const t = new Tutorial(true);
    t.begin();
    expect(t.active).toBe(false);
  });

  it('replay() re-arms from the start even after completion', () => {
    const t = new Tutorial(false);
    t.advance();
    t.advance();
    t.advance(); // completed, disarmed
    expect(t.active).toBe(false);
    t.replay();
    expect(t.active).toBe(true);
    expect(t.step).toBe('lineup');
    expect(t.hint()?.index).toBe(1);
  });

  it('replay() re-arms a player who had already seen it', () => {
    const t = new Tutorial(true);
    t.replay();
    expect(t.active).toBe(true);
    expect(t.step).toBe('lineup');
  });
});
