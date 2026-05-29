// Central tunable configuration for VibePins.
//
// LANE is the single source of truth for lane geometry, body sizes/masses,
// and camera framing (GDD REQ-025). Every system reads from here instead of
// hard-coding numbers, so the whole game can be re-tuned from one place.
//
// Coordinate system: origin at the centre of the foul line, +x to the right,
// +y up, lane running into -z toward the pin deck. Units are metres and
// kilograms. Values are duckpin-scaled first-pass tunables; the playtest gate
// (Q-010, GDD 08-controls) will tighten them.

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const LANE = {
  // Playfield. 60ft foul-line-to-head-pin and a ~42in bed, duckpin-scaled.
  length: 18.29,
  width: 1.066,
  gutterWidth: 0.16,

  // Ball: palm-sized sphere, no finger holes (GDD REQ-028).
  ballRadius: 0.0635,
  ballMass: 1.64,

  // Pin: squat and belly-heavy for low energy transfer (GDD REQ-026).
  pinHeight: 0.2381,
  pinBellyRadius: 0.0476,
  pinMass: 0.4,

  // Standard 10-pin triangle spacing, centre-to-centre (GDD REQ-027).
  pinSpacing: 0.3048,

  // Pin deck head spot sits at the far end of the bed (the lane length is the
  // foul-line-to-head-pin distance). The triangle's three back rows recede past
  // the head spot onto the pin deck, so the deck is its own surface behind the
  // lane bed (GDD REQ-027). One row of slack covers the deepest back row.
  headSpot: { x: 0, y: 0, z: -18.29 } as Vec3,
  pinDeckDepth: 1.2,

  // Camera frames the lane from just behind the foul line.
  cameraPos: { x: 0, y: 1.6, z: 2.4 } as Vec3,
  cameraLookAt: { x: 0, y: 0.2, z: -9.0 } as Vec3,

  floorY: 0,
  gravity: -9.82,
} as const;

// Collision-group bitmask for the physics layers (GDD reuse, GROUP pattern).
export const GROUP = {
  BALL: 1 << 0,
  PIN: 1 << 1,
  LANE: 1 << 2,
  GUTTER: 1 << 3,
  STRING: 1 << 4,
} as const;

// String pinsetter tether tunables (GDD 03-string-pinsetter, REQ-013 to REQ-015).
// Each pin hangs from a fixed overhead anchor by a slack cord modeled as a Rapier
// rope joint (a max-distance constraint: slack until the anchor-to-neck distance
// reaches slackLength, then taut). The cord must never go taut during normal play.
export const TETHER = {
  // Overhead anchor height above floorY, directly above each pin home spot.
  // Midpoint of the GDD's 2.2 to 2.8m drive-unit range.
  topY: 2.5,

  // Cord attach point on the pin, as a local +y offset above the body centre:
  // the neck, above the dropped belly/centre-of-mass and below the geometric top.
  neckLocalY: LANE.pinHeight * 0.3,

  // Rope joint maximum length. It must exceed the largest anchor-to-neck distance
  // the cord can ever see in normal play so a struck pin falls freely (REQ-014),
  // yet stay finite so a later reset slice can reel a pin up off the deck (REQ-015).
  // Worst case (metres): an outer back-row pin's neck lying flat (y = floorY +
  // pinBellyRadius) slid to the far corner of the deck footprint gives a distance
  // of ~2.81. At rest the distance is only ~2.31. 2.96 clears the worst case by a
  // ~0.15 margin. tether.test.ts recomputes the worst case and guards this value.
  slackLength: 2.96,

  // Thin neutral-grey cord line, in keeping with the industrial palette.
  cordColor: 0x8a8a8a,
} as const;
