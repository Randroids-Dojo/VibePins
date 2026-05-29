// The machine-room interior layout (GDD 04-look-and-feel#environment, REQ-039).
// machineRoomParts is pure layout derived from LANE / TETHER and the MACHINE_ROOM
// tunables, so we can verify the room encloses the lane (a shell of walls plus a
// ceiling) and stages its background machinery (conduit, gauges, a neighbour-rig
// silhouette) clear of the playfield, without booting Three.js. world3d just turns
// these parts into meshes, so pinning the geometry here is the meaningful coverage.

import { describe, it, expect } from 'vitest';
import { LANE, TETHER, MACHINE_ROOM, machineRoomParts } from '../src/config.js';

const room = machineRoomParts();

// The far reach of the playfield in each axis, so we can assert the shell stays
// outside it. The lane runs from the approach (+z) back through the pit (-z); the
// bed plus gutters set the widest x; the pinsetter frame sets the top.
const PLAYFIELD = {
  maxX: LANE.width / 2 + LANE.gutterWidth,
  frontZ: LANE.approachDepth,
  backZ: LANE.headSpot.z - LANE.pinDeckDepth - LANE.pitLength,
  topY: TETHER.topY,
};

describe('machine-room shell', () => {
  it('builds four enclosing walls plus a ceiling', () => {
    expect(room.walls).toHaveLength(4);
    expect(room.ceiling).toBeDefined();
  });

  it('sets the two side walls just outside the gutters', () => {
    const sideWalls = room.walls.filter((w) => Math.abs(w.center.x) > 0.01);
    expect(sideWalls).toHaveLength(2);
    for (const wall of sideWalls) {
      // The wall inner face must sit beyond the outer gutter edge.
      const innerX = Math.abs(wall.center.x) - wall.half.x;
      expect(innerX).toBeGreaterThan(PLAYFIELD.maxX);
    }
  });

  it('puts a back wall behind the pit and a front wall behind the bowler', () => {
    const endWalls = room.walls.filter((w) => Math.abs(w.center.x) <= 0.01);
    expect(endWalls).toHaveLength(2);
    const backWall = endWalls.find((w) => w.center.z < 0)!;
    const frontWall = endWalls.find((w) => w.center.z > 0)!;
    // Back wall is down-lane (-z) past the back of the pit.
    expect(backWall.center.z + backWall.half.z).toBeLessThan(PLAYFIELD.backZ);
    // Front wall is behind the bowler (+z) past the approach.
    expect(frontWall.center.z - frontWall.half.z).toBeGreaterThan(PLAYFIELD.frontZ);
  });

  it('hangs the ceiling above the pinsetter frame so the rig stays clear', () => {
    const ceilingBottom = room.ceiling.center.y - room.ceiling.half.y;
    expect(ceilingBottom).toBeGreaterThan(PLAYFIELD.topY);
  });

  it('rests every wall and the ceiling on or above the lane floor', () => {
    for (const wall of room.walls) {
      expect(wall.center.y - wall.half.y).toBeCloseTo(LANE.floorY, 6);
    }
    expect(room.ceiling.center.y).toBeCloseTo(MACHINE_ROOM.ceilingY, 6);
  });
});

describe('machine-room background machinery (REQ-039)', () => {
  it('runs one conduit pipe along each upper side wall, down-lane', () => {
    expect(room.conduits).toHaveLength(2);
    for (const conduit of room.conduits) {
      expect(conduit.axis).toBe('z');
      // Up high, in the background behind the rig.
      expect(conduit.center.y).toBeGreaterThan(PLAYFIELD.topY);
      // Tucked just inside a side wall, outside the playfield.
      expect(Math.abs(conduit.center.x)).toBeGreaterThan(PLAYFIELD.maxX);
    }
    // One on each side.
    expect(Math.sign(room.conduits[0].center.x)).not.toBe(Math.sign(room.conduits[1].center.x));
  });

  it('mounts a row of gauge dials on the back wall, centred on the lane', () => {
    expect(room.gauges).toHaveLength(MACHINE_ROOM.gaugeCount);
    const sumX = room.gauges.reduce((acc, g) => acc + g.center.x, 0);
    expect(sumX).toBeCloseTo(0, 6); // symmetric about the lane centre
    for (const g of room.gauges) {
      // On (just in front of) the back wall.
      expect(g.center.z).toBeGreaterThan(MACHINE_ROOM.backZ);
      expect(g.center.z).toBeLessThan(MACHINE_ROOM.backZ + 0.1);
      expect(g.radius).toBeCloseTo(MACHINE_ROOM.gaugeRadius, 6);
    }
  });

  it('stands a neighbouring-lane silhouette off to one side, in the background', () => {
    // Off to the side, beyond the playfield width.
    expect(Math.abs(room.neighborRig.center.x)).toBeGreaterThan(PLAYFIELD.maxX);
    // Standing on the floor, taller than a pin so it reads as a rig.
    expect(room.neighborRig.center.y - room.neighborRig.half.y).toBeCloseTo(LANE.floorY, 6);
    expect(room.neighborRig.half.y * 2).toBeGreaterThan(LANE.pinHeight);
    // Deep down-lane in the background, not at the foul line.
    expect(room.neighborRig.center.z).toBeLessThan(0);
  });
});
