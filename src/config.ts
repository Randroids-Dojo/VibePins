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
  // side into the void. The bed's own edge is the gutter mouth (the bed slab is
  // thick, so a ball that has dropped into the recessed channel cannot climb
  // back onto the lane); an outer wall keeps it from escaping sideways. There is
  // no raised inner lip over the bed: a lip above the bed surface would sit on
  // the playable edge and act as a rail that launches an edge-drifting ball and
  // blocks gutter entry. The pit sits behind the pin deck: a recessed floor with
  // a back wall that stops a ball clearing the rack so it comes to rest down-lane
  // instead of falling forever (the ball-roll smoke previously fell into nothing).
  gutterDepth: 0.09, //   how far the gutter floor sits below the lane bed top
  gutterWallHeight: 0.18, // outer side-wall height above the bed
  pitDepth: 0.25, //      how far the pit floor sits below the lane bed top
  pitLength: 1.4, //      pit extent behind the back of the pin deck (-z)
  pitWallHeight: 0.5, //  back-wall and side-wall height above the bed
} as const;

// Mechanical material palette (GDD 04-look-and-feel#palette-lighting, REQ-041).
// The single source of truth for every scene-surface look, the visual sibling of
// LANE's single-source geometry (REQ-025). The GDD calls for a material-led,
// warm-metal palette: oiled hardwood, brushed and blackened steel, aged brass,
// copper, cast iron, leather and canvas, warm metals over cool plastics. Accent
// colour comes from the machine, not signage: amber indicator lamps, the deep
// red of a painted frame, the glint of polished brass, hazard-stripe yellow on
// moving parts. Each entry is a Three.js MeshStandardMaterial parameter bundle
// (color is a hex int; emissive lamps carry an emissive colour and intensity).
//
// Discipline: every colour here is a warm tone (its red channel is at least its
// blue channel), so the venue never drifts cool. The palette is unit tested
// (tests/palette.test.ts) for that warmth invariant plus the presence of the
// machine accents, since jsdom cannot drive WebGL to verify the look directly.
export interface SurfaceMaterial {
  readonly color: number;
  readonly roughness: number;
  readonly metalness: number;
  // Emissive lamps glow against the dark venue. Omitted for non-emissive surfaces.
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
}

export const MATERIALS = {
  // Oiled hardwood lane bed: glossy enough to catch the warm work-light as a
  // highlight (GDD "glossy lane reflecting warm highlights"), low metalness.
  oiledWoodLane: { color: 0x6b4a2b, roughness: 0.32, metalness: 0.1 },
  // The approach floor behind the foul line: darker, worn, matte wood.
  approachWood: { color: 0x2a2420, roughness: 0.8, metalness: 0.05 },
  // Dark wood lane inlays (aiming arrows, guide dots).
  inlayWood: { color: 0x241607, roughness: 0.7, metalness: 0.05 },
  // The painted-on foul line, nearly black.
  foulLine: { color: 0x140d06, roughness: 0.85, metalness: 0.0 },
  // Brushed steel: the ball-return rail and pin deck. Mid roughness, high metal.
  // Tuned warm-neutral (red >= blue) so the metal sits in the warm palette
  // rather than the cool blue-grey it read as before.
  brushedSteel: { color: 0x42403c, roughness: 0.5, metalness: 0.55 },
  // Blackened steel: the recessed gutters. Darker, a touch glossier.
  blackenedSteel: { color: 0x282624, roughness: 0.55, metalness: 0.6 },
  // Cast iron: the dim back pit and the overhead drive-unit housing.
  castIron: { color: 0x1d1c1a, roughness: 0.7, metalness: 0.45 },
  // Aged brass: the machine accent glint (drive-unit trim). Polished, metallic,
  // a warm gold so the brass reads as the GDD's "polished brass" highlight.
  agedBrass: { color: 0xb5832e, roughness: 0.3, metalness: 0.85 },
  // Amber indicator lamp: the machine's accent light, emissive so it glows in
  // the dark machine room (GDD "amber indicator lamps").
  amberLamp: {
    color: 0xffae3b,
    roughness: 0.4,
    metalness: 0.2,
    emissive: 0xff8c1a,
    emissiveIntensity: 1.4,
  },
} as const satisfies Record<string, SurfaceMaterial>;

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

  // Optional ball-cam chase view (REQ-033 polish, persisted setting default off).
  // When on, the watching phase rides behind and above the rolling ball, looking
  // down-lane ahead of it. The eye sits 1.3 m behind (toward the bowler, +z) and
  // 0.9 m above the ball, with the look-at anchored 4 m ahead (toward the pins) at
  // mid-pin height so the deck stays framed as the ball nears it. A slightly wider
  // fov than the locked shooting view gives the chase a sense of speed.
  chaseBehind: 1.3,
  chaseHeight: 0.9,
  chaseAhead: 4.0,
  chaseLookHeight: 0.4,
  chaseFov: 40,
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

// Pin-to-pin contact material (GDD REQ-030, pillar 1: authentic duckpin, not
// reskinned tenpin). Beyond the squat belly-heavy mass (REQ-026), the other
// physical reason real strikes stay rare is how little energy a duckpin contact
// transfers: the pins barely bounce off each other, so a hit topples its
// immediate neighbours but the chain dies out fast instead of spraying the rack
// the way tenpin does. We tune that here rather than leaving it to engine
// defaults so the scatter is a deliberate, single-source-of-truth value:
//   - restitution 0: contacts are fully damped, so struck pins do not rebound
//     and rocket across the deck. Any non-zero bounce visibly increases scatter
//     (a small playtest sweep showed restitution 0.05 roughly doubling the
//     furthest pin's travel), which reads as tenpin spray, so duckpin pins keep
//     it at zero.
//   - friction tuned mid-high so a toppling pin sheds its energy into the deck
//     and its neighbour rather than sliding the length of the lane.
// Verified by tests/scatter.smoke.test.ts: across a sweep of straight shots a
// dead-centre ball never strikes and most frames leave six to nine pins, which
// is the duckpin feel the GDD demands (the record is 279, never a 300).
export const PIN_PHYSICS = {
  friction: 0.55,
  restitution: 0.0,
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

// Visible pinsetter rig staging (GDD 04-look-and-feel, REQ-040). The string
// machine is part of the show: above the pin deck sits a frame of beams carrying
// ten guide tubes (one over each pin, the cord runs through it), ten winding
// drums on cross-shafts (what reels each cord), and an overhead drive unit (the
// motor housing the whole rig hangs from). This is set dressing only: pure
// geometry, no colliders, so it never touches the physics or the cords' own
// behaviour. The frame top sits at TETHER.topY (where the cord anchors already
// live), so the rig reads as the structure the cords actually hang from. All
// sizes are tunable here so the rig can be re-staged from one place (REQ-025).
export const PINSETTER = {
  // The drive-unit / frame top plane: coplanar with the cord anchors so the
  // beams visibly carry the strings.
  frameTopY: TETHER.topY,

  // Two longitudinal steel rails run down-lane along the rack's left and right
  // edges; cross beams span between them over each pin row. railHalfX is how far
  // off the lane centre each rail sits (just outside the outer pins).
  railHalfX: LANE.width / 2 - 0.06,
  beamThickness: 0.05, // square cross-section half-extent for rails and beams
  // How far the frame overhangs the rack front/back so the beams clear the pins.
  frameOverhang: 0.25,

  // Guide tubes: a short open tube hung from the frame above each pin, the cord
  // dropping through it toward the pin neck. They stop above the standing pins.
  guideTubeRadius: 0.03,
  guideTubeLength: 0.5,
  guideTubeTopGap: 0.08, // gap from frame underside to the tube top

  // Winding drums: one drum per pin, threaded on a cross-shaft that spans the
  // two rails over each pin row. The cord winds onto its drum to reel the pin up.
  drumRadius: 0.05,
  drumLength: 0.12,
  shaftRadius: 0.018,

  // The overhead drive unit: a motor box mounted on the frame at the back of the
  // rig (down-lane end), the single housing the rig is driven from.
  driveUnitSize: { x: 0.5, y: 0.32, z: 0.7 } as Vec3,

  // Industrial palette (REQ-041): painted-red frame, blackened-steel drums and
  // tubes, dark cast-iron drive unit. The steels are warm-neutral (red >= blue)
  // so the rig sits in the warm machine-room palette rather than reading cool.
  frameColor: 0x7a1f17,
  steelColor: 0x52504a,
  driveColor: 0x2b2826,
} as const;

// A beam (centre + half-extents), reusing the Box shape so the rig renders with
// the same boxMesh helper world3d already uses for gutters and the pit.
export interface RigBeam {
  readonly center: Vec3;
  readonly half: Vec3;
}

// A cylindrical rig part (guide tube, drum, shaft, or conduit) with an axis.
// axis 'y' is upright (tubes), 'x' is across the lane (drums and shafts), 'z' runs
// down-lane (machine-room conduit).
export interface RigCylinder {
  readonly center: Vec3;
  readonly radius: number;
  readonly length: number;
  readonly axis: 'x' | 'y' | 'z';
}

// Pure layout of the visible pinsetter rig (REQ-040), derived from the rack
// positions and PINSETTER tunables so the world3d meshes (and a smoke test) share
// one source of truth. Returns the frame beams, the per-pin guide tubes, the
// per-pin winding drums, the per-row cross-shafts the drums ride, and the single
// overhead drive unit. No physics: this is set dressing above the deck.
export function pinsetterRigParts(rackPositions: readonly Vec3[]): {
  beams: RigBeam[];
  guideTubes: RigCylinder[];
  drums: RigCylinder[];
  shafts: RigCylinder[];
  driveUnit: RigBeam;
} {
  const t = PINSETTER.beamThickness;
  const topY = PINSETTER.frameTopY;

  // Front (toward camera, +z) and back (down-lane, -z) extents of the rack,
  // padded by the overhang so the frame clears the pins.
  const zs = rackPositions.map((p) => p.z);
  const frontZ = Math.max(...zs) + PINSETTER.frameOverhang;
  const backZ = Math.min(...zs) - PINSETTER.frameOverhang;
  const centerZ = (frontZ + backZ) / 2;
  const halfZ = (frontZ - backZ) / 2;
  const centerX = rackPositions.length > 0 ? rackPositions[0].x : 0;

  // Two longitudinal rails along the rack edges at the frame top.
  const beams: RigBeam[] = ([-1, 1] as const).map((side) => ({
    center: { x: centerX + side * PINSETTER.railHalfX, y: topY, z: centerZ },
    half: { x: t, y: t, z: halfZ },
  }));

  // Cross beams spanning the rails over each distinct pin row (one per unique z).
  const rowZs = [...new Set(zs)].sort((a, b) => b - a);
  for (const z of rowZs) {
    beams.push({
      center: { x: centerX, y: topY, z },
      half: { x: PINSETTER.railHalfX + t, y: t, z: t },
    });
  }

  // Cross-shafts: one per row, just below the frame, carrying that row's drums.
  const shaftY = topY - t - PINSETTER.shaftRadius;
  const shafts: RigCylinder[] = rowZs.map((z) => ({
    center: { x: centerX, y: shaftY, z },
    radius: PINSETTER.shaftRadius,
    length: 2 * (PINSETTER.railHalfX + t),
    axis: 'x',
  }));

  // Per-pin drums on the shaft and guide tubes hung below the frame.
  const drumY = shaftY;
  const tubeTopY = topY - PINSETTER.guideTubeTopGap;
  const tubeCenterY = tubeTopY - PINSETTER.guideTubeLength / 2;
  const drums: RigCylinder[] = [];
  const guideTubes: RigCylinder[] = [];
  for (const p of rackPositions) {
    drums.push({
      center: { x: p.x, y: drumY, z: p.z },
      radius: PINSETTER.drumRadius,
      length: PINSETTER.drumLength,
      axis: 'x',
    });
    guideTubes.push({
      center: { x: p.x, y: tubeCenterY, z: p.z },
      radius: PINSETTER.guideTubeRadius,
      length: PINSETTER.guideTubeLength,
      axis: 'y',
    });
  }

  // The overhead drive unit: mounted on the frame at the down-lane back end.
  const d = PINSETTER.driveUnitSize;
  const driveUnit: RigBeam = {
    center: { x: centerX, y: topY + d.y / 2 + t, z: backZ - d.z / 2 },
    half: { x: d.x / 2, y: d.y / 2, z: d.z / 2 },
  };

  return { beams, guideTubes, drums, shafts, driveUnit };
}

// Machine-room interior staging (GDD 04-look-and-feel#environment, REQ-039). The
// single 3D lane is set inside a machine room: the scene is enclosed so it reads
// as an interior rather than a lane floating in void, and the room is suggested
// through background machinery (conduit runs, gauge dials, the silhouette of a
// neighbouring lane rig) lit by the warm work-light, NOT through neon signage or
// an explorable space. Everything here is set dressing: pure geometry, no
// colliders, well off the playfield so it never touches the ball, pins, or cords.
// All sizes are tunable here so the room can be re-staged from one place (REQ-025).
export const MACHINE_ROOM = {
  // The room shell: a floor-to-ceiling box around the lane. Walls sit just outside
  // the gutters; the ceiling hangs above the pinsetter frame so the rig stays clear.
  wallHalfX: LANE.width / 2 + LANE.gutterWidth + 0.5, // each side wall offset from centre
  ceilingY: TETHER.topY + 0.9, //        ceiling height above the floor
  // The room runs from behind the bowler (+z, past the approach) to behind the pit
  // (-z, past the pin deck), enclosing the whole playfield.
  frontZ: LANE.approachDepth + 0.6, //   back wall behind the bowler
  backZ: LANE.headSpot.z - LANE.pinDeckDepth - LANE.pitLength - 0.6, // wall behind the pit
  wallThickness: 0.1, //                 half-thickness of the shell slabs

  // Background conduit: horizontal pipe runs along the upper side walls, the kind
  // of exposed plumbing a machine room is full of. One run per side, up high so it
  // sits in the background behind the rig.
  conduitRadius: 0.05,
  conduitY: TETHER.topY + 0.35,
  conduitInset: 0.08, //                 how far the pipe sits in front of the wall

  // Gauge dials mounted on the back wall behind the pit: small round faces, the
  // engraved instrument look the GDD calls for. Count and spacing across the wall.
  gaugeCount: 4,
  gaugeRadius: 0.13,
  gaugeSpacing: 0.4,
  gaugeY: 1.4,

  // The silhouette of a neighbouring lane rig: a dark vertical frame standing off
  // to one side in the background, so the room reads as one lane among several
  // rather than a solo booth. Set back near the side wall, dim against the fog.
  neighborRigX: LANE.width / 2 + LANE.gutterWidth + 0.42,
  neighborRigZ: LANE.headSpot.z * 0.5, // roughly mid-lane, deep in the background
  neighborRigSize: { x: 0.12, y: 2.4, z: 0.12 } as Vec3,

  // Industrial palette (REQ-041): the room shell is dark cast-iron-toned concrete,
  // the conduit and neighbour rig blackened steel, the gauges a brass-rimmed face.
  // All warm-neutral (red >= blue) so the room stays in the warm machine palette.
  shellColor: 0x161310,
  conduitColor: 0x3a3733,
  gaugeRimColor: 0x6b5320,
  gaugeFaceColor: 0x2a2723,
  neighborColor: 0x100e0c,
} as const;

// Pure layout of the machine-room interior (REQ-039), derived from LANE / TETHER
// and the MACHINE_ROOM tunables so the world3d meshes and a unit test share one
// source of truth. Returns the enclosing shell slabs (floor is the existing lane
// floor, so the shell here is the four walls plus ceiling), the background
// conduit runs, the back-wall gauge dials, and the neighbouring-lane silhouette.
// No physics: this is dressing well outside the playfield.
export function machineRoomParts(): {
  walls: RigBeam[];
  ceiling: RigBeam;
  conduits: RigCylinder[];
  gauges: { center: Vec3; radius: number }[];
  neighborRig: RigBeam;
} {
  const m = MACHINE_ROOM;
  const t = m.wallThickness;
  const centerZ = (m.frontZ + m.backZ) / 2;
  const halfZ = (m.frontZ - m.backZ) / 2;
  const wallHeight = m.ceilingY - LANE.floorY;
  const wallCenterY = LANE.floorY + wallHeight / 2;

  // Two side walls and a back/front wall enclose the lane.
  const walls: RigBeam[] = [];
  for (const side of [-1, 1] as const) {
    walls.push({
      center: { x: side * m.wallHalfX, y: wallCenterY, z: centerZ },
      half: { x: t, y: wallHeight / 2, z: halfZ },
    });
  }
  // Back wall (behind the pit, -z) and front wall (behind the bowler, +z).
  walls.push({
    center: { x: 0, y: wallCenterY, z: m.backZ - t },
    half: { x: m.wallHalfX + t, y: wallHeight / 2, z: t },
  });
  walls.push({
    center: { x: 0, y: wallCenterY, z: m.frontZ + t },
    half: { x: m.wallHalfX + t, y: wallHeight / 2, z: t },
  });

  const ceiling: RigBeam = {
    center: { x: 0, y: m.ceilingY, z: centerZ },
    half: { x: m.wallHalfX + t, y: t, z: halfZ },
  };

  // One conduit run along the top of each side wall, just inside it.
  const conduits: RigCylinder[] = ([-1, 1] as const).map((side) => ({
    center: { x: side * (m.wallHalfX - m.conduitInset), y: m.conduitY, z: centerZ },
    radius: m.conduitRadius,
    length: 2 * halfZ,
    axis: 'z',
  }));

  // Gauge dials in a row on the back wall, centred on the lane.
  const gauges: { center: Vec3; radius: number }[] = [];
  const firstX = -((m.gaugeCount - 1) * m.gaugeSpacing) / 2;
  for (let i = 0; i < m.gaugeCount; i += 1) {
    gauges.push({
      center: { x: firstX + i * m.gaugeSpacing, y: m.gaugeY, z: m.backZ + 0.02 },
      radius: m.gaugeRadius,
    });
  }

  // The neighbouring-lane silhouette: a dark vertical post off to the right, deep
  // in the background near the side wall.
  const d = m.neighborRigSize;
  const neighborRig: RigBeam = {
    center: { x: m.neighborRigX, y: LANE.floorY + d.y / 2, z: m.neighborRigZ },
    half: { x: d.x / 2, y: d.y / 2, z: d.z / 2 },
  };

  return { walls, ceiling, conduits, gauges, neighborRig };
}

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
  liftFrames: 72, //       ~1.20s reel the pins up by their neck cords (cord-tension)
  repositionFrames: 60, // ~1.00s carry the raised pins over their home spots
  lowerFrames: 72, //      ~1.20s lower the pins back onto their home spots
  // Carried pin centre height. Above the standing pins (pinHeight) so a lifted
  // pin clears them as it travels: liftPinY - pinHeight/2 > pinHeight.
  liftPinY: 0.6,
  // Cord-tension lift geometry (the signature feel). The reel-up shortens each
  // pin's rope joint from the at-throw slack down to liftRopeLength, dragging the
  // pin up BY ITS NECK so it hangs and swings under gravity (it is never stood
  // upright on the deck first). slackRopeLength matches TETHER.slackLength so the
  // lift begins from the cord's real rest slack. liftRopeLength is short enough
  // that the neck is pulled up near the overhead anchor (TETHER.topY) and the pin
  // dangles clear of the deck: anchor topY 2.5 minus liftRopeLength ~1.85 puts the
  // neck near ~0.65m, with the belly-heavy pin hanging base-down below it.
  slackRopeLength: TETHER.slackLength,
  liftRopeLength: 1.85,
} as const;

// Tangle up/down shake recovery during the reset (GDD 03-string-pinsetter,
// REQ-024). Research (real string machines) and the product-owner playtest: a
// genuine tangle is RARE, less than once per ~1000 frames, and only happens when
// a downed pin lies across another pin's cord so the cords snag during the
// cord-tension reel-up and a pin cannot rise to its clearance height. A clean
// rack reels straight up with NO shake. ONLY on a genuine snag does the machine
// run an up/down shake: it pays the cords back out a little (the snagged cluster
// drops), lets gravity swing the snag loose, then reels back up and re-checks.
// The loop is bounded by maxRetries; at the cap the machine force-clears (sets the
// rack regardless) so the reset can never hang. These are first-pass values for
// the playtest gate (Q-010).
export const TANGLE = {
  // The rope length the cords pay back out to on a shake-down (longer than
  // RESET.liftRopeLength, so the snagged pins visibly drop and swing). Shorter
  // than the full slack so the rack stays aloft, not back on the deck.
  shakeRopeLength: 2.4,
  // Frames to pay the cords out on a shake (~0.40s): the visible drop.
  shakeDownFrames: 24,
  // Frames to reel back up after a shake (~0.40s): the re-tug. Snappy so the
  // struggle reads as repeated tugs, not a slow crawl.
  shakeUpFrames: 24,
  // Retry cap: after this many up/down shakes the machine force-clears (sets the
  // rack regardless) so the reset is always bounded.
  maxRetries: 4,
  // Genuine-snag read (REQ-024). After the cord-tension reel-up, a pin whose neck
  // failed to rise to within clearanceTolerance of the lifted clearance height is
  // genuinely snagged: its cord is held low by another pin lying across it, so it
  // could not be reeled up. A clean rack lifts every pin to the clearance, so this
  // never fires; only a real cord snag leaves a pin held low. The clearance height
  // is the lifted neck height (anchor TETHER.topY minus RESET.liftRopeLength); a
  // pin reeled to its cord limit hangs its neck near that height.
  clearanceNeckY: TETHER.topY - RESET.liftRopeLength,
  clearanceTolerance: 0.5,
} as const;

// A pin's centre height at rest on the deck (base on the deck surface). Single
// source for the reset lower target and the detection/rack geometry.
export const PIN_REST_Y = LANE.floorY + LANE.pinHeight / 2;

// Strike victory routine (GDD 04-look-and-feel "juice", REQ-044). A strike is
// genuinely rare in duckpin, so it earns a brief mechanical flourish: a burst of
// debris particles flung up off the pin deck (bolts, sparks, scrap thrown by the
// contraption) plus a quick camera shake, sized to stay short so the loop never
// drags (the GDD warns against long unskippable animations). Pure-sim tunables;
// the visual layer in world3d turns these into meshes and a camera offset, and
// the audio sting (REQ-043) plays alongside. All values are tuned to land the
// burst, settle the shake, and clear well inside the reset settle beat.
export const VICTORY = {
  // How many debris bits the burst spawns. A readable handful, not a fountain.
  debrisCount: 24,
  // Where the burst originates: just above the rack head spot on the deck.
  originY: LANE.floorY + LANE.pinHeight,
  // Lateral/down-lane spread of spawn points around the head spot (metres).
  spawnSpread: 0.35,
  // Initial velocity of a bit: a strong upward kick plus random sideways spray.
  upMin: 2.6,
  upMax: 4.2,
  sidewaysSpeed: 1.8,
  // Debris half-size (metres) and how fast each bit tumbles (radians/sec).
  debrisHalfSize: 0.018,
  spinSpeed: 12,
  // Gravity on the debris (m/s^2, negative is down). Matches the world so the
  // bits arc believably.
  gravity: LANE.gravity,
  // The bits fade and the routine ends after this long (seconds). Kept short so
  // the flourish is over before the next ball, well inside the reset beat.
  durationSeconds: 1.4,
  // Camera shake: peak positional amplitude (metres) that decays to zero over
  // shakeSeconds. The shake is the briefest part so aiming is never disturbed.
  shakeAmplitude: 0.05,
  shakeSeconds: 0.5,
  // Shake oscillation frequency (Hz) on each axis; coprime-ish so x/y differ.
  shakeFreqX: 38,
  shakeFreqY: 47,
  // Debris palette (REQ-041 industrial): hot brass sparks and dark steel scrap.
  sparkColor: 0xffb347,
  scrapColor: 0x6a6d72,
} as const;

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

// Foul-line detection (GDD 02-core-loop, REQ-032). The foul line is the plane at
// the origin (z = 0); the lane runs into -z and the approach is on the +z side.
// A live ball at or in front of this plane (z >= foulLineZ) has crossed the line
// and fouled: an over-the-line release or a ball that comes back across the line.
// A legal ball spawns just inside it (LANE.ballSpawnZ = -0.15, z < 0) and rolls
// into -z, so it never trips the line in normal play. A foul scores zero pinfall
// and leaves the rack standing (Q-012 default A).
export const FOUL = {
  foulLineZ: 0,
} as const;

// Gutter detection (GDD REQ-031). The lane bed runs from x = -LANE.width/2 to
// +LANE.width/2; beyond each edge is a recessed gutter channel. A live ball
// whose centre crosses a bed edge has left the lane and dropped into the gutter,
// so it can no longer reach the pins. Like a foul (REQ-032), a gutter ball is a
// dead ball: it scores zero pinfall and leaves the standing rack untouched. The
// threshold is the bed half-width: once the ball centre is at or past the edge
// it is over the channel and falling in. A normal centred or aimed ball stays
// well inside this, so clean play never trips it.
export const GUTTER = {
  bedEdgeX: LANE.width / 2,
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

// One gutter channel beside the lane, on the given side (-1 left, +1 right). A
// real gutter is just a recessed trough alongside the bed: the floor is a thin
// slab dropped below the bed, and an outer wall closes the far side so a ball
// cannot escape sideways. The inner side of the channel is the lane bed's own
// edge: the bed slab is 0.1m thick, so a ball that has dropped into the recessed
// channel sits below bed level and the bed's edge face keeps it from climbing
// back onto the lane. There is deliberately NO raised inner lip over the bed: a
// lip that rose above the bed surface (the previous geometry) sat on the outer
// strip of the playable bed and acted as a continuous rail, launching a ball that
// drifted to the edge into the air and blocking any ball from leaking into the
// gutter at all. Without it the bed edge IS the gutter mouth, as on a real lane.
function gutterParts(side: -1 | 1): { floor: Box; outerWall: Box } {
  const channelOuterX = LANE.width / 2 + LANE.gutterWidth;
  const channelCenterX = side * (LANE.width / 2 + LANE.gutterWidth / 2);
  const floorTopY = LANE.floorY - LANE.gutterDepth;
  const slab = 0.05; // half-thickness of the channel floor/wall slabs

  return {
    floor: {
      center: { x: channelCenterX, y: floorTopY - slab, z: LANE_RUN_CENTER_Z },
      half: { x: LANE.gutterWidth / 2, y: slab, z: LANE_RUN_HALF_Z },
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

// Both gutter channels (left then right), each a recessed floor + outer wall.
export function gutterBoxes(): Box[] {
  return ([-1, 1] as const).flatMap((side) => {
    const parts = gutterParts(side);
    return [parts.floor, parts.outerWall];
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
