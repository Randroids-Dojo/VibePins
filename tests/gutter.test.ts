import { describe, it, expect } from 'vitest';
import { GutterDetector, isInGutter, type GutterConfig } from '../src/gutter.js';
import { GUTTER, LANE } from '../src/config.js';
import { ballSpawnPosition } from '../src/ball.js';

// The lane bed is centred on x = 0 and runs from -bedEdgeX to +bedEdgeX. A live
// ball whose centre reaches a bed edge has left the lane into a gutter channel.
const cfg: GutterConfig = { bedEdgeX: 0.5 };

describe('isInGutter: the bed-edge predicate (REQ-031)', () => {
  it('is false for a ball comfortably on the bed (abs(x) < bedEdgeX)', () => {
    expect(isInGutter(0, cfg)).toBe(false);
    expect(isInGutter(0.2, cfg)).toBe(false);
    expect(isInGutter(-0.49, cfg)).toBe(false);
  });

  it('is true exactly at a bed edge (abs(x) === bedEdgeX)', () => {
    expect(isInGutter(0.5, cfg)).toBe(true);
    expect(isInGutter(-0.5, cfg)).toBe(true);
  });

  it('is true off either edge (abs(x) > bedEdgeX)', () => {
    expect(isInGutter(0.6, cfg)).toBe(true);
    expect(isInGutter(-0.7, cfg)).toBe(true);
  });

  it('honors a different bed half-width', () => {
    const wide: GutterConfig = { bedEdgeX: 1 };
    expect(isInGutter(0.9, wide)).toBe(false);
    expect(isInGutter(1, wide)).toBe(true);
  });
});

describe('GutterDetector: leaving-the-lane latching (REQ-031)', () => {
  it('does not gutter before begin() is called', () => {
    const d = new GutterDetector(cfg);
    expect(d.guttered).toBe(false);
    expect(d.step(1)).toBe(false); // off the bed, but not active yet
    expect(d.guttered).toBe(false);
  });

  it('does not gutter a clean ball that stays on the bed', () => {
    const d = new GutterDetector(cfg);
    d.begin();
    for (const x of [0, 0.1, -0.2, 0.3, -0.35]) {
      expect(d.step(x)).toBe(false);
    }
    expect(d.guttered).toBe(false);
  });

  it('gutters on the first step the ball reaches a bed edge', () => {
    const d = new GutterDetector(cfg);
    d.begin();
    expect(d.step(0.45)).toBe(false);
    expect(d.step(0.5)).toBe(true); // crosses the edge
    expect(d.guttered).toBe(true);
  });

  it('latches: returns true only once, then stays guttered', () => {
    const d = new GutterDetector(cfg);
    d.begin();
    expect(d.step(0.6)).toBe(true);
    expect(d.step(0.7)).toBe(false); // still off the bed, already latched
    // Even if the ball later jitters back toward centre, the gutter stands.
    expect(d.step(0.1)).toBe(false);
    expect(d.guttered).toBe(true);
  });

  it('gutters off the left edge too', () => {
    const d = new GutterDetector(cfg);
    d.begin();
    expect(d.step(-0.4)).toBe(false);
    expect(d.step(-0.55)).toBe(true);
    expect(d.guttered).toBe(true);
  });

  it('re-arms on a fresh begin() for the next shot', () => {
    const d = new GutterDetector(cfg);
    d.begin();
    d.step(1);
    expect(d.guttered).toBe(true);
    d.begin();
    expect(d.guttered).toBe(false);
    expect(d.step(0)).toBe(false);
  });
});

describe('GUTTER config matches the lane geometry', () => {
  it('sets the bed edge at the lane bed half-width', () => {
    expect(GUTTER.bedEdgeX).toBe(LANE.width / 2);
  });

  it('keeps the default ball spawn (lane centre) well inside the bed', () => {
    // A normal launch from the head spot rolls down the centreline; the spawn
    // must never trip the gutter, or every clean shot would read as a gutter.
    expect(isInGutter(ballSpawnPosition().x, GUTTER)).toBe(false);
    expect(Math.abs(ballSpawnPosition().x)).toBeLessThan(GUTTER.bedEdgeX);
  });
});
