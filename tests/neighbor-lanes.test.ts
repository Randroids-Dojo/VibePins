// Neighbouring lanes and their bowler figures (GDD 04-look-and-feel#environment,
// REQ-039). neighborLaneLayout and bowlerFigurePose are pure layout/animation
// helpers derived from LANE and the NEIGHBOR_LANES tunables, so we can verify the
// lanes sit in the periphery (off the player's playfield, inside the room) and the
// bowler loop actually moves (walk-up and swing are observable over the cycle)
// without booting Three.js. world3d just turns these into meshes and per-frame
// transforms, so pinning the geometry and the motion here is the meaningful coverage.

import { describe, it, expect } from 'vitest';
import {
  LANE,
  MACHINE_ROOM,
  NEIGHBOR_LANES,
  neighborLaneLayout,
  bowlerFigurePose,
} from '../src/config.js';

const PLAYFIELD_MAX_X = LANE.width / 2 + LANE.gutterWidth;
const lanes = neighborLaneLayout();

describe('neighbor lane layout (REQ-039)', () => {
  it('places one lane per side at the configured count', () => {
    expect(lanes).toHaveLength(NEIGHBOR_LANES.perSide * 2);
    const left = lanes.filter((l) => l.side === -1);
    const right = lanes.filter((l) => l.side === 1);
    expect(left).toHaveLength(NEIGHBOR_LANES.perSide);
    expect(right).toHaveLength(NEIGHBOR_LANES.perSide);
  });

  it('returns the lanes left to right, symmetric about the player lane', () => {
    const xs = lanes.map((l) => l.centerX);
    const sorted = [...xs].sort((a, b) => a - b);
    expect(xs).toEqual(sorted);
    // Symmetric: the centres sum to zero (one each side at equal pitch).
    expect(xs.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9);
  });

  it('stages every neighbour bed clear of the player playfield', () => {
    for (const lane of lanes) {
      // The neighbour bed's near edge sits beyond the player's gutter, so the
      // neighbour lane is in the periphery, never overlapping the playfield.
      const nearEdge = Math.abs(lane.centerX) - NEIGHBOR_LANES.bedWidth / 2;
      expect(nearEdge).toBeGreaterThan(PLAYFIELD_MAX_X);
    }
  });

  it('keeps every neighbour bed inside the machine-room side walls', () => {
    const wallInnerX = MACHINE_ROOM.wallHalfX - MACHINE_ROOM.wallThickness;
    for (const lane of lanes) {
      const farEdge = Math.abs(lane.centerX) + NEIGHBOR_LANES.bedWidth / 2;
      expect(farEdge).toBeLessThan(wallInnerX);
    }
  });

  it('staggers the bowler phases so adjacent lanes are not in lockstep', () => {
    const phases = lanes.map((l) => l.phase);
    const unique = new Set(phases.map((p) => p.toFixed(6)));
    expect(unique.size).toBe(phases.length);
    for (const p of phases) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
});

describe('bowler figure pose loop (REQ-039 observable motion)', () => {
  it('walks up toward the foul line over the approach, then holds at the line', () => {
    const start = bowlerFigurePose(0);
    const quarter = bowlerFigurePose(0.2);
    const atLine = bowlerFigurePose(0.5);
    // Walk offset grows through the approach phase.
    expect(start.walkOffset).toBeLessThan(quarter.walkOffset);
    // By the swing phase the figure is fully up at the line.
    expect(atLine.walkOffset).toBeCloseTo(NEIGHBOR_LANES.walkupReach, 6);
  });

  it('swings the arm from drawn-back through the bottom to forward', () => {
    const drawnBack = bowlerFigurePose(0.46); // start of the swing
    const bottom = bowlerFigurePose(0.575); // mid swing, near the bottom
    const forward = bowlerFigurePose(0.69); // end of the swing
    expect(drawnBack.armSwing).toBeLessThan(0); // behind the body
    expect(forward.armSwing).toBeGreaterThan(0); // swung forward
    expect(bottom.armSwing).toBeGreaterThan(drawnBack.armSwing);
    expect(forward.armSwing).toBeGreaterThan(bottom.armSwing);
  });

  it('flags a release beat as the arm crosses the bottom of the swing', () => {
    // No release while still walking up or recovering.
    expect(bowlerFigurePose(0.2).releasing).toBe(false);
    expect(bowlerFigurePose(0.85).releasing).toBe(false);
    // Some frame in the swing crosses the bottom and flags a release.
    const released = [0.55, 0.575, 0.6].some((t) => bowlerFigurePose(t).releasing);
    expect(released).toBe(true);
  });

  it('returns the figure toward its start during the recover phase', () => {
    const justAfterSwing = bowlerFigurePose(0.72);
    const lateRecover = bowlerFigurePose(0.95);
    // The figure steps back toward the start (walk offset shrinks).
    expect(lateRecover.walkOffset).toBeLessThan(justAfterSwing.walkOffset);
  });

  it('wraps the loop time so the cycle is periodic', () => {
    const a = bowlerFigurePose(0.3);
    const b = bowlerFigurePose(1.3);
    const c = bowlerFigurePose(-0.7); // -0.7 wraps to 0.3
    expect(b.walkOffset).toBeCloseTo(a.walkOffset, 9);
    expect(b.armSwing).toBeCloseTo(a.armSwing, 9);
    expect(c.walkOffset).toBeCloseTo(a.walkOffset, 9);
  });
});
