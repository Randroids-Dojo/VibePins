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

  // Ball launch and surface tunables (GDD REQ-029). The ball spawns at
  // ballSpawnZ, just inside the foul line on the lane bed (the bed runs from the
  // foul line at z=0 to the head pin), and rolls down-lane at ballLaunchSpeed
  // toward the pins. An approach floor behind the foul line is a later scene
  // slice. These are first-pass values to tighten against the playtest gate
  // (a polished ball skids then rolls and barely bounces).
  ballSpawnZ: -0.15,
  ballLaunchSpeed: 8.0,
  ballFriction: 0.25,
  ballRestitution: 0.1,
  ballLinearDamping: 0.05,
  ballAngularDamping: 0.05,

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

  // Camera frames the lane from behind the foul line, raised and tilted down so
  // the pin deck at the far end reads clearly rather than vanishing to a point.
  cameraPos: { x: 0, y: 1.5, z: 2.2 } as Vec3,
  cameraLookAt: { x: 0, y: 0.4, z: -18.3 } as Vec3,
  cameraFov: 30,

  // Atmospheric fog for venue depth. Far is pushed well past the pin deck
  // (~20.7m from the camera) so the pins are not faded to black.
  fogNear: 9,
  fogFar: 42,

  // The approach floor extends behind the foul line (toward the camera) so the
  // walk-up and the ball return have ground.
  approachDepth: 3.0,

  floorY: 0,
  gravity: -9.82,

  // Ball containment (GDD REQ-031 gutters, followup F-004 back pit). Duckpin
  // gutters are smaller than tenpin: a shallow channel runs along each side of
  // the bed, its floor recessed below floorY so a ball that drifts off the lane
  // drops in and is carried down toward the pit rather than rolling off the
  // side into the void. An inner lip rises just above the bed so the ball does
  // not climb back out onto the lane; an outer wall keeps it from escaping
  // sideways. The pit sits behind the pin deck: a recessed floor with a back
  // wall that stops a ball clearing the rack so it comes to rest down-lane
  // instead of falling forever (the ball-roll smoke previously fell into nothing).
  gutterDepth: 0.09, //   how far the gutter floor sits below the lane bed top
  gutterLipHeight: 0.03, // inner lip above the bed, to keep a gutter ball in
  gutterWallHeight: 0.18, // outer side-wall height above the bed
  pitDepth: 0.25, //      how far the pit floor sits below the lane bed top
  pitLength: 1.4, //      pit extent behind the back of the pin deck (-z)
  pitWallHeight: 0.5, //  back-wall and side-wall height above the bed
} as const;

// Shot-setup camera sequence (GDD 08-controls, REQ-033 lineup). The camera
// animates: pick the ball up at the return, walk up to the foul line, then the
// player shifts their line before locking in. The "line" (locked) pose reuses
// the LANE camera, so there is one source of truth for the shooting view.
export const SHOT_CAMERA = {
  // First-person pickup pose: eye height, looking down toward the throwing hand.
  returnPos: { x: 0.45, y: 1.55, z: 2.75 } as Vec3,
  returnLookAt: { x: 0.62, y: 0.7, z: 2.25 } as Vec3,
  returnFov: 55,

  // Where the ball return rail sits (the ball rests here before pickup).
  ballReturnPos: { x: 0.45, y: 0.18, z: 2.5 } as Vec3,
  // Where the ball is lifted to once grabbed: up and toward the throwing-hand
  // side (the return side, +x) and back toward the body, so the lift reads as an
  // arm bringing the ball up to a front-right carry, not a centred float.
  ballHeldPos: { x: 0.78, y: 0.92, z: 2.35 } as Vec3,

  // Sequence timing in seconds.
  pickupSeconds: 1.3,
  walkupSeconds: 2.0,

  // Max lateral stance shift (metres) while aligning at the line.
  alignLimit: 0.34,
} as const;

// Spin/angle meter (GDD 08-controls, REQ-034 step 2, REQ-036 release). A cursor
// sweeps across a normalized [-1, +1] track; where the player stops it sets the
// spin/hook. A stop near 0 is straight and low-spin; a stop toward a side gives
// that-side spin that curves the roll. Sweep speed and the straight (sweet-spot)
// band are tunable (Q-010: start forgiving, tighten via playtest). The release
// resolves the chosen spin into a lateral launch nudge plus a vertical-axis
// angular velocity, so the ball both points and curves toward the chosen side.
export const SPIN = {
  // Full end-to-end sweeps per second. Forgiving first pass for the playtest gate.
  sweepsPerSecond: 1.2,

  // Stops with abs(position) at or below this read as straight (no spin/curve),
  // so a centred stop is reliably a low-spin ball rather than a knife edge.
  straightBand: 0.12,

  // Peak lateral launch velocity (m/s, at full spin) added to the down-lane
  // throw, so a full-side stop angles the ball across the lane at release.
  maxLateralSpeed: 1.1,

  // Peak spin about the vertical (y) axis (rad/s, at full spin). With the ball
  // rolling on the bed this hooks the path toward the chosen side as it travels.
  maxSpinYaw: 12,
} as const;

// Step 3 of the throw: the power meter (GDD 08-controls REQ-035). A second sweep
// on the same [-1, +1] track sets the down-lane ball speed and triggers release.
// The track reads as a gradient with a sweet spot in the centre (the cursor
// starts at an end and passes through the centre, so the player times the stop
// to catch the peak): a centred stop gives the fastest, best shot, and the
// extremes are weak. Sweep speed and the sweet-spot width are tunable (Q-010:
// start forgiving, tighten via the playtest gate).
export const POWER = {
  // Full end-to-end sweeps per second. Forgiving first pass for the playtest gate.
  sweepsPerSecond: 1.0,

  // Half-width of the centred sweet-spot band on the [-1, +1] track. Stops with
  // abs(position) at or below this read as full power, so catching the peak is
  // forgiving rather than a knife edge.
  sweetSpotBand: 0.15,

  // Down-lane launch speed (m/s) at the sweet spot (best shot) and at the track
  // extremes (a weak push). Speed ramps linearly from max at the band edge down
  // to min at the extreme, so a mistimed stop is slow but never stalls.
  maxSpeed: 8.0,
  minSpeed: 3.5,
} as const;

// Step 1 base-aim direction (GDD 08-controls REQ-033, REQ-036 release). The
// line-up sets a lateral start position (SHOT_CAMERA.alignLimit) AND the base direction
// the ball points. Lining up off-centre points the ball back toward an aim spot
// down-lane so the stance reads as "aim from here at the pins" rather than a
// blind sideways slide that always rolls dead-straight and misses the pocket.
export const AIM = {
  // Down-lane z the base aim points toward. The pin deck (head spot) is the
  // natural target, so a left/right stance angles the ball back at the rack.
  targetZ: LANE.headSpot.z,

  // How strongly the stance steers the aim, 0..1. 1 points the ball exactly at
  // (headSpot.x, targetZ) from the stance; 0 is always straight down-lane. A
  // partial weight keeps off-centre stances meaningful without fully cancelling
  // the lateral start, so the player still owns where on the deck they attack.
  // Forgiving first pass to tighten against the playtest gate (Q-010).
  strength: 0.7,
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

// Pin standing/fallen detection tunables (GDD 03-string-pinsetter, REQ-016/017).
// A pin counts as standing only if upright within tolerance AND at rest AND
// still on the deck footprint. A settle window waits for sustained rest before
// counting so wobbling pins are not miscounted. Frame counts assume the fixed
// 1/60 physics step. These are first-pass values for the playtest gate.
export const DETECTION = {
  // Upright tolerance: a pin tilted more than 15 degrees off vertical is fallen.
  // Stored as the minimum body up-axis Y (cos of the tolerance angle).
  standingUpAxisThreshold: Math.cos((15 * Math.PI) / 180),

  // At-rest thresholds: a pin is at rest when both speeds are at or below these.
  atRestLinSpeed: 0.05,
  atRestAngSpeed: 0.1,

  // Settle window: classify once the whole rack holds rest for settleAtRestFrames
  // (~0.15s), or at settleMaxFrames (~0.6s) as a hard timeout for a pin that
  // never fully stills (for example one gently rocking on its cord).
  settleAtRestFrames: 9,
  settleMaxFrames: 36,

  // The deck footprint rectangle, derived from LANE (matches world3d's deck
  // span). A standing pin's centre must lie within x,z and at or below maxCenterY;
  // a pin that slid off the deck or hangs by its cord fails this and reads fallen.
  deckFootprint: {
    minX: -LANE.width / 2,
    maxX: LANE.width / 2,
    minZ: LANE.headSpot.z - LANE.pinDeckDepth,
    maxZ: LANE.headSpot.z + 0.15,
    maxCenterY: LANE.floorY + LANE.pinHeight / 2 + LANE.pinBellyRadius,
  },
} as const;

// String pinsetter reset-cycle tunables (GDD 03-string-pinsetter, REQ-018 to
// REQ-021). A reset reels fallen pins up by their cords (no sweep) and sets them
// back on their home spots. Each fallen pin is carried kinematically: righted at
// its settled spot, raised straight up to liftPinY (clear of the deck and the
// standing pins), carried over its home spot, then lowered onto it. The rendered
// cords follow the carried pins so the lift reads as strings, not a sweep. Frame
// counts assume the fixed 1/60 physics step; ~3.7s total sits in the GDD 3-5s
// window. These are first-pass values for the playtest gate.
export const RESET = {
  settleHoldFrames: 18, // ~0.30s legibility beat before the strings move
  liftFrames: 72, //       ~1.20s raise the fallen pins straight up off the deck
  repositionFrames: 60, // ~1.00s carry the raised pins over their home spots
  lowerFrames: 72, //      ~1.20s lower the pins back onto their home spots
  // Carried pin centre height. Above the standing pins (pinHeight) so a lifted
  // pin clears them as it travels: liftPinY - pinHeight/2 > pinHeight.
  liftPinY: 0.6,
} as const;

// A pin's centre height at rest on the deck (base on the deck surface). Single
// source for the reset lower target and the detection/rack geometry.
export const PIN_REST_Y = LANE.floorY + LANE.pinHeight / 2;

// Post-throw shot watcher (GDD 02-core-loop, REQ-009). Decides when a thrown
// ball has resolved so the loop can count pinfall and advance the frame. A shot
// resolves when the ball is at rest, has cleared the deck into the pit, or hits
// the hard timeout. Frame counts are in fixed (1/60s) steps.
export const SHOT = {
  // A ball this slow (m/s) is no longer acting on the pins. Above the pin
  // at-rest threshold because a rolling ball carries more residual speed than a
  // standing pin's jitter, and we want to call the shot reasonably promptly.
  atRestSpeed: 0.2,
  atRestFrames: 18, //  ~0.30s held at rest before the shot resolves
  // The ball has cleared the pin deck into the pit once past the deepest back
  // row; from there it cannot return to the rack, so the shot resolves at once.
  pitZ: LANE.headSpot.z - LANE.pinDeckDepth,
  maxFrames: 600, // ~10s hard cap so a wedged ball never stalls the loop
} as const;

// Ball-containment geometry (GDD REQ-031 gutters, followup F-004 back pit).
// Pure layout derived from LANE so the world3d meshes and the physics colliders
// (and the smoke tests) share one source of truth. All boxes are described by a
// centre and a half-extent in each axis, matching Three.js BoxGeometry (full
// size) and Rapier ColliderDesc.cuboid (half-extents).

export interface Box {
  readonly center: Vec3;
  readonly half: Vec3; // half-extents (x, y, z)
}

// The lane-and-deck run in z: from just behind the foul line back to the back
// of the pin deck. Gutters span this whole run alongside the bed.
const LANE_RUN_BACK_Z = LANE.headSpot.z - LANE.pinDeckDepth;
const LANE_RUN_FRONT_Z = 0;
const LANE_RUN_CENTER_Z = (LANE_RUN_FRONT_Z + LANE_RUN_BACK_Z) / 2;
const LANE_RUN_HALF_Z = (LANE_RUN_FRONT_Z - LANE_RUN_BACK_Z) / 2;

// One gutter channel beside the lane, on the given side (-1 left, +1 right). The
// floor is a thin slab recessed below the bed; an inner lip and an outer wall
// box it so a ball drops in, stays in, and is carried down toward the pit.
function gutterParts(side: -1 | 1): { floor: Box; innerLip: Box; outerWall: Box } {
  const channelOuterX = LANE.width / 2 + LANE.gutterWidth;
  const channelCenterX = side * (LANE.width / 2 + LANE.gutterWidth / 2);
  const floorTopY = LANE.floorY - LANE.gutterDepth;
  const slab = 0.05; // half-thickness of the channel floor/wall slabs

  return {
    floor: {
      center: { x: channelCenterX, y: floorTopY - slab, z: LANE_RUN_CENTER_Z },
      half: { x: LANE.gutterWidth / 2, y: slab, z: LANE_RUN_HALF_Z },
    },
    // Inner lip: a thin wall between the bed edge and the channel, rising just
    // above the bed so a gutter ball cannot climb back onto the lane.
    innerLip: {
      center: {
        x: side * (LANE.width / 2 - slab),
        y: LANE.floorY + LANE.gutterLipHeight / 2,
        z: LANE_RUN_CENTER_Z,
      },
      half: { x: slab, y: LANE.gutterLipHeight / 2, z: LANE_RUN_HALF_Z },
    },
    // Outer wall: closes the far side of the channel so the ball cannot escape.
    outerWall: {
      center: {
        x: side * (channelOuterX + slab),
        y: LANE.floorY + (LANE.gutterWallHeight - LANE.gutterDepth) / 2,
        z: LANE_RUN_CENTER_Z,
      },
      half: { x: slab, y: (LANE.gutterWallHeight + LANE.gutterDepth) / 2, z: LANE_RUN_HALF_Z },
    },
  };
}

// Both gutter channels (left then right), each a floor + inner lip + outer wall.
export function gutterBoxes(): Box[] {
  return ([-1, 1] as const).flatMap((side) => {
    const parts = gutterParts(side);
    return [parts.floor, parts.innerLip, parts.outerWall];
  });
}

// The back pit behind the pin deck: a recessed floor plus a back wall and two
// side walls, so a ball clearing the rack drops in and comes to rest instead of
// rolling off the back into the void.
export function pitBoxes(): Box[] {
  const deckBackZ = LANE.headSpot.z - LANE.pinDeckDepth;
  const pitFrontZ = deckBackZ;
  const pitBackZ = deckBackZ - LANE.pitLength;
  const pitCenterZ = (pitFrontZ + pitBackZ) / 2;
  const pitHalfZ = (pitFrontZ - pitBackZ) / 2;
  // The pit spans the full lane-plus-gutter width so a ball that came down a
  // gutter or off the deck is caught.
  const pitHalfX = LANE.width / 2 + LANE.gutterWidth;
  const floorTopY = LANE.floorY - LANE.pitDepth;
  const slab = 0.05;

  const floor: Box = {
    center: { x: 0, y: floorTopY - slab, z: pitCenterZ },
    half: { x: pitHalfX, y: slab, z: pitHalfZ },
  };
  // Back wall closes the far (-z) end.
  const backWall: Box = {
    center: { x: 0, y: LANE.floorY + (LANE.pitWallHeight - LANE.pitDepth) / 2, z: pitBackZ - slab },
    half: { x: pitHalfX + slab, y: (LANE.pitWallHeight + LANE.pitDepth) / 2, z: slab },
  };
  // Two side walls along the pit so a ball cannot escape sideways out of it.
  const sideWalls: Box[] = ([-1, 1] as const).map((side) => ({
    center: {
      x: side * (pitHalfX + slab),
      y: LANE.floorY + (LANE.pitWallHeight - LANE.pitDepth) / 2,
      z: pitCenterZ,
    },
    half: { x: slab, y: (LANE.pitWallHeight + LANE.pitDepth) / 2, z: pitHalfZ },
  }));

  return [floor, backWall, ...sideWalls];
}
