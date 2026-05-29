import { describe, it, expect } from 'vitest';
import { LANE, DETECTION } from '../src/config.js';
import {
  getUpAxisY,
  isOnDeck,
  classifyPinStanding,
  classifyRack,
  SettleWindow,
  type PinKinematics,
} from '../src/detection.js';

// Quaternion for a tilt of `deg` degrees about the x-axis. Its up-axis Y is cos(deg).
const tiltX = (deg: number) => {
  const h = ((deg * Math.PI) / 180) / 2;
  return { x: Math.sin(h), y: 0, z: 0, w: Math.cos(h) };
};

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const onDeckSpot = { x: 0, y: LANE.floorY + LANE.pinHeight / 2, z: LANE.headSpot.z };

// A nominal upright, at-rest, on-deck pin; override fields per test.
const standingState = (over: Partial<PinKinematics> = {}): PinKinematics => ({
  position: onDeckSpot,
  rotation: IDENTITY,
  linSpeed: 0,
  angSpeed: 0,
  ...over,
});

describe('getUpAxisY', () => {
  it('is 1 for an upright pin and equals cos(tilt) about x', () => {
    expect(getUpAxisY(IDENTITY)).toBeCloseTo(1, 6);
    expect(getUpAxisY(tiltX(14))).toBeCloseTo(Math.cos((14 * Math.PI) / 180), 6);
  });

  it('crosses the 15-degree standing threshold between 14 and 16 degrees', () => {
    expect(getUpAxisY(tiltX(14))).toBeGreaterThanOrEqual(DETECTION.standingUpAxisThreshold);
    expect(getUpAxisY(tiltX(16))).toBeLessThan(DETECTION.standingUpAxisThreshold);
  });
});

describe('isOnDeck', () => {
  const fp = DETECTION.deckFootprint;
  it('accepts a pin resting within the footprint', () => {
    expect(isOnDeck(onDeckSpot, fp)).toBe(true);
  });
  it('rejects a pin slid off the side or off the back', () => {
    expect(isOnDeck({ x: LANE.width, y: onDeckSpot.y, z: onDeckSpot.z }, fp)).toBe(false);
    expect(isOnDeck({ x: 0, y: onDeckSpot.y, z: fp.minZ - 0.5 }, fp)).toBe(false);
  });
  it('rejects a pin lifted above the deck (hanging by its cord, REQ-022)', () => {
    expect(isOnDeck({ x: 0, y: fp.maxCenterY + 0.2, z: onDeckSpot.z }, fp)).toBe(false);
  });
});

describe('classifyPinStanding', () => {
  it('counts an upright, at-rest, on-deck pin as standing', () => {
    expect(classifyPinStanding(standingState(), DETECTION)).toBe(true);
  });
  it('counts a pin tilted past tolerance as fallen', () => {
    expect(classifyPinStanding(standingState({ rotation: tiltX(30) }), DETECTION)).toBe(false);
  });
  it('counts a still-moving pin as fallen (at-rest is required)', () => {
    expect(classifyPinStanding(standingState({ linSpeed: 0.2 }), DETECTION)).toBe(false);
    expect(classifyPinStanding(standingState({ angSpeed: 0.5 }), DETECTION)).toBe(false);
  });
  it('counts an off-deck pin as fallen even if upright and at rest', () => {
    expect(classifyPinStanding(standingState({ position: { x: 0, y: onDeckSpot.y, z: 5 } }), DETECTION)).toBe(false);
  });
  it('counts a pin hanging above the deck as fallen (REQ-022)', () => {
    const hung = standingState({ position: { x: 0, y: DETECTION.deckFootprint.maxCenterY + 0.5, z: onDeckSpot.z } });
    expect(classifyPinStanding(hung, DETECTION)).toBe(false);
  });
});

describe('classifier boundaries (lock in the threshold semantics)', () => {
  const fp = DETECTION.deckFootprint;

  it('treats exactly 15 degrees of tilt as still upright (inclusive)', () => {
    expect(classifyPinStanding(standingState({ rotation: tiltX(15) }), DETECTION)).toBe(true);
    expect(classifyPinStanding(standingState({ rotation: tiltX(15.5) }), DETECTION)).toBe(false);
  });

  it('treats speed exactly at the threshold as at rest (inclusive)', () => {
    expect(classifyPinStanding(standingState({ linSpeed: DETECTION.atRestLinSpeed }), DETECTION)).toBe(true);
    expect(classifyPinStanding(standingState({ linSpeed: DETECTION.atRestLinSpeed + 0.001 }), DETECTION)).toBe(false);
    expect(classifyPinStanding(standingState({ angSpeed: DETECTION.atRestAngSpeed }), DETECTION)).toBe(true);
    expect(classifyPinStanding(standingState({ angSpeed: DETECTION.atRestAngSpeed + 0.001 }), DETECTION)).toBe(false);
  });

  it('treats the deck footprint bounds as inclusive', () => {
    const y = onDeckSpot.y;
    expect(isOnDeck({ x: fp.minX, y, z: onDeckSpot.z }, fp)).toBe(true);
    expect(isOnDeck({ x: fp.minX - 0.001, y, z: onDeckSpot.z }, fp)).toBe(false);
    expect(isOnDeck({ x: fp.maxX, y, z: onDeckSpot.z }, fp)).toBe(true);
    expect(isOnDeck({ x: 0, y, z: fp.maxZ }, fp)).toBe(true);
    expect(isOnDeck({ x: 0, y, z: fp.maxZ + 0.001 }, fp)).toBe(false);
    expect(isOnDeck({ x: 0, y: fp.maxCenterY, z: onDeckSpot.z }, fp)).toBe(true);
    expect(isOnDeck({ x: 0, y: fp.maxCenterY + 0.001, z: onDeckSpot.z }, fp)).toBe(false);
  });
});

describe('classifyRack', () => {
  it('returns a standing flag per pin with counts summing to the rack size', () => {
    const states = [
      standingState(),
      standingState({ rotation: tiltX(40) }),
      standingState({ linSpeed: 1 }),
    ];
    const result = classifyRack(states, DETECTION);
    expect(result.map((p) => p.standing)).toEqual([true, false, false]);
    expect(result.map((p) => p.pinIndex)).toEqual([0, 1, 2]);
  });
});

describe('SettleWindow', () => {
  const moving = standingState({ linSpeed: 1 });
  const rack = (states: PinKinematics[]) => states;

  it('does not settle while a pin is still moving', () => {
    const win = new SettleWindow(DETECTION, 3, 100);
    for (let i = 0; i < 10; i += 1) {
      expect(win.step(rack([standingState(), moving])).settled).toBe(false);
    }
  });

  it('settles after sustained rack-wide rest and classifies', () => {
    const win = new SettleWindow(DETECTION, 3, 100);
    expect(win.step(rack([standingState(), standingState()])).settled).toBe(false);
    expect(win.step(rack([standingState(), standingState()])).settled).toBe(false);
    const result = win.step(rack([standingState(), standingState({ rotation: tiltX(40) })]));
    expect(result.settled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.standingCount).toBe(1);
    expect(result.fallenCount).toBe(1);
  });

  it('resets the sustained-rest run when motion interrupts it', () => {
    const win = new SettleWindow(DETECTION, 3, 100);
    win.step(rack([standingState()])); // rest 1
    win.step(rack([standingState()])); // rest 2
    expect(win.step(rack([moving])).settled).toBe(false); // interrupted, run resets
    expect(win.step(rack([standingState()])).settled).toBe(false); // rest 1 again
    expect(win.step(rack([standingState()])).settled).toBe(false); // rest 2
    expect(win.step(rack([standingState()])).settled).toBe(true); // rest 3 -> settle
  });

  it('times out when rest is never sustained, still producing a classification', () => {
    const win = new SettleWindow(DETECTION, 5, 4);
    let result = win.step(rack([moving]));
    for (let i = 0; i < 3; i += 1) result = win.step(rack([moving]));
    expect(result.settled).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.pins).toHaveLength(1);
    expect(result.standingCount).toBe(0); // a moving pin is not standing
  });

  it('prefers sustained rest over timeout when both resolve on the same frame', () => {
    // atRestFrames === maxFrames === 2, fed at-rest both frames: on frame 2 the
    // sustained-rest run and the timeout both fire; sustained should win.
    const win = new SettleWindow(DETECTION, 2, 2);
    expect(win.step(rack([standingState()])).settled).toBe(false);
    const result = win.step(rack([standingState()]));
    expect(result.settled).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('latches the settled result until reset', () => {
    const win = new SettleWindow(DETECTION, 1, 100);
    const first = win.step(rack([standingState()]));
    expect(first.settled).toBe(true);
    const again = win.step(rack([moving, moving])); // ignored once latched
    expect(again).toBe(first);
    win.reset();
    expect(win.step(rack([moving])).settled).toBe(false);
  });
});
