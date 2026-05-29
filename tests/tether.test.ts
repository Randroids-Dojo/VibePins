import { describe, it, expect } from 'vitest';
import { LANE, TETHER } from '../src/config.js';
import { neckLocalAnchor, tetherAnchorPositions, pinRackPositions } from '../src/pins.js';

describe('tether neck attach point', () => {
  it('attaches on the neck: above the dropped belly/COM and below the geometric top (REQ-013)', () => {
    const neck = neckLocalAnchor();
    expect(neck.x).toBe(0);
    expect(neck.z).toBe(0);
    expect(neck.y).toBeCloseTo(LANE.pinHeight * 0.3, 6);
    // BELLY_DROP in pins.ts drops the COM to -0.18 * pinHeight; the top is +0.5.
    expect(neck.y).toBeGreaterThan(-0.18 * LANE.pinHeight);
    expect(neck.y).toBeLessThan(0.5 * LANE.pinHeight);
  });
});

describe('tether anchor positions', () => {
  const anchors = tetherAnchorPositions();
  const rack = pinRackPositions();

  it('hangs one anchor directly above each of the ten home spots (REQ-013, REQ-015)', () => {
    expect(anchors).toHaveLength(10);
    anchors.forEach((a, i) => {
      expect(a.x).toBeCloseTo(rack[i].x, 6);
      expect(a.z).toBeCloseTo(rack[i].z, 6);
      expect(a.y).toBe(TETHER.topY);
    });
  });
});

describe('tether slack length', () => {
  const anchors = tetherAnchorPositions();

  // Worst-case anchor-to-neck distance over rest and any natural fall on the deck.
  // A toppled pin's neck lies at about the belly radius above the deck and can
  // slide anywhere within the deck footprint.
  const neckFlatY = LANE.floorY + LANE.pinBellyRadius;
  const deckFrontZ = LANE.headSpot.z + 0.15;
  const deckBackZ = LANE.headSpot.z - LANE.pinDeckDepth;
  const corners = [
    { x: -LANE.width / 2, z: deckFrontZ },
    { x: -LANE.width / 2, z: deckBackZ },
    { x: LANE.width / 2, z: deckFrontZ },
    { x: LANE.width / 2, z: deckBackZ },
  ];
  let worstFall = 0;
  for (const a of anchors) {
    for (const c of corners) {
      const d = Math.hypot(a.x - c.x, TETHER.topY - neckFlatY, a.z - c.z);
      worstFall = Math.max(worstFall, d);
    }
  }

  const restDistance = TETHER.topY - (LANE.floorY + LANE.pinHeight / 2 + TETHER.neckLocalY);

  it('stays slack at rest (REQ-013)', () => {
    expect(restDistance).toBeGreaterThan(0);
    expect(TETHER.slackLength).toBeGreaterThan(restDistance);
    // The cord is nowhere near taut at rest, so the joint is fully inactive.
    expect(restDistance / TETHER.slackLength).toBeLessThan(0.9);
  });

  it('exceeds the worst natural fall so the cord never restrains a falling pin (REQ-014)', () => {
    expect(TETHER.slackLength).toBeGreaterThan(worstFall);
  });

  it('stays finite and snug so a future reset can still lift pins (REQ-015)', () => {
    expect(Number.isFinite(TETHER.slackLength)).toBe(true);
    // Snug: not so long that the cord could never go taut within the playfield.
    expect(TETHER.slackLength).toBeLessThan(TETHER.topY + 0.7);
  });
});
