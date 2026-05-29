// Pure geometry tests for ball containment (GDD REQ-031 gutters, followup F-004
// back pit). These guard the layout that world3d's meshes and colliders share:
// gutters flank the bed along its whole run, recessed below the bed top; the pit
// sits behind the pin deck with a back wall. The physics behaviour (a wide ball
// lands in a gutter, a cleared ball rests in the pit) lives in the smoke test.

import { describe, it, expect } from 'vitest';
import { LANE, gutterBoxes, pitBoxes, type Box } from '../src/config.js';

const top = (b: Box): number => b.center.y + b.half.y;
const bottom = (b: Box): number => b.center.y - b.half.y;
const frontZ = (b: Box): number => b.center.z + b.half.z; // toward the foul line
const backZ = (b: Box): number => b.center.z - b.half.z; //  toward the pit

describe('gutter geometry (REQ-031)', () => {
  const boxes = gutterBoxes();

  it('builds two channels (floor, inner lip, outer wall each)', () => {
    expect(boxes.length).toBe(6);
  });

  it('places one channel on each side, outside the bed', () => {
    const leftFloors = boxes.filter((b) => b.center.x < 0 && b.half.y < 0.06);
    const rightFloors = boxes.filter((b) => b.center.x > 0 && b.half.y < 0.06);
    expect(leftFloors.length).toBeGreaterThan(0);
    expect(rightFloors.length).toBeGreaterThan(0);
    for (const b of boxes) {
      // Every gutter part sits at or beyond the bed edge, never over the bed.
      expect(Math.abs(b.center.x) + b.half.x).toBeGreaterThan(LANE.width / 2 - 1e-9);
    }
  });

  it('recesses the channel floor below the bed top so a ball drops in', () => {
    const floors = boxes.filter((b) => b.half.y < 0.06 && Math.abs(b.center.x) > LANE.width / 2);
    expect(floors.length).toBe(2);
    for (const f of floors) {
      expect(top(f)).toBeLessThan(LANE.floorY);
      expect(top(f)).toBeCloseTo(LANE.floorY - LANE.gutterDepth, 6);
    }
  });

  it('runs the gutters the full length of the lane plus deck', () => {
    const backOfDeck = LANE.headSpot.z - LANE.pinDeckDepth;
    for (const b of boxes) {
      expect(frontZ(b)).toBeGreaterThanOrEqual(-1e-9); // reach the foul line
      expect(backZ(b)).toBeLessThanOrEqual(backOfDeck + 1e-9); // reach the deck back
    }
  });
});

describe('pit geometry (F-004)', () => {
  const boxes = pitBoxes();
  const deckBackZ = LANE.headSpot.z - LANE.pinDeckDepth;

  it('builds a floor, a back wall, and two side walls', () => {
    expect(boxes.length).toBe(4);
  });

  it('sits entirely behind the back of the pin deck', () => {
    for (const b of boxes) {
      expect(frontZ(b)).toBeLessThanOrEqual(deckBackZ + 1e-9);
    }
  });

  it('recesses the pit floor below the bed top', () => {
    const floor = boxes.find((b) => b.half.x > LANE.width / 2 && b.half.y < 0.06);
    expect(floor).toBeDefined();
    expect(top(floor!)).toBeLessThan(LANE.floorY);
    expect(top(floor!)).toBeCloseTo(LANE.floorY - LANE.pitDepth, 6);
  });

  it('raises a back wall above the bed to stop a cleared ball', () => {
    const wall = boxes.find((b) => bottom(b) < LANE.floorY - LANE.pitDepth + 1e-9 && top(b) > LANE.floorY);
    expect(wall).toBeDefined();
    // The back wall is the deepest box in -z.
    const deepest = boxes.reduce((a, b) => (b.center.z < a.center.z ? b : a));
    expect(top(deepest)).toBeGreaterThan(LANE.floorY);
  });
});
