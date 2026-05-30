// Carry-through integration smoke (GDD REQ-030 scatter, REQ-014 slack cord).
// Runs the real Rapier WASM (no renderer) against the SAME colliders world3d
// builds (bed, pin deck, gutters, pit) and the tethered rack, launching the ball
// with the ACTUAL game launch params main.ts feeds in (spin stop, power stop,
// stance offset), including LANE.ballLaunchTopspin, so it reflects real play.
//
// A human playtest found that on a decent pocket hit the ball stopped dead at the
// head pin and only the front pin fell (playtest bug 4): the ball was launched at
// full rolling-without-slip topspin, which gripped the head pin and climbed it,
// popping the ball ~0.8m up and over the whole rack. The fix reduces the launch
// topspin so the ball drives THROUGH the pocket low and carries into the row
// behind. This smoke proves, across a spread of representative pocket throws, that
//   (a) the ball travels PAST the head pin (its z goes beyond the head spot), and
//   (b) at least one pin directly behind the head pin (the row-1 / row-2 pack)
//       topples, not just the head pin alone,
// for a healthy fraction of throws. It fails against the over-damped (full-
// topspin) tuning, where the ball flies over and leaves the back rows standing.
//
// A separate test keeps the duckpin strike-rarity honest: a dead-centre straight
// ball must NOT clear the rack (no cheap strikes), so the fix did not turn the
// game into tenpin.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  LANE,
  GROUP,
  TETHER,
  PIN_PHYSICS,
  SPIN,
  gutterBoxes,
  pitBoxes,
  laneSurfaceSpan,
  type Box,
} from '../src/config.js';
import { ballSpawnPosition, ballLaunchVelocity, spinFraction } from '../src/ball.js';
import { pinRackPositions, pinMassProperties, neckLocalAnchor } from '../src/pins.js';

beforeAll(async () => {
  await RAPIER.init();
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const FRONT_Z = LANE.headSpot.z + 0.15;
const BACK_Z = LANE.headSpot.z - LANE.pinDeckDepth;

// Rack layout (head pin first): index 0 is the head pin; indices 1..2 are the
// row directly behind it, 3..5 the next row, 6..9 the back row. "Behind the head
// pin" is anything past the head pin (index >= 1).
const PINS_BEHIND_HEAD = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function makeWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  world.timestep = 1 / 60;
  return world;
}

function addStaticBox(world: RAPIER.World, box: Box): void {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(box.center.x, box.center.y, box.center.z),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(box.half.x, box.half.y, box.half.z), body);
}

// Exactly the colliders world3d builds: the single continuous lane-surface slab
// (foul line to deck back, one slab with no internal seam, the deck-lip fix),
// the gutters, and the pit (the pit's back wall is what stops a carried-through
// ball, matching real play).
function addLane(world: RAPIER.World): void {
  const span = laneSurfaceSpan();
  const surface = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, span.centerZ),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, span.length / 2), surface);
  for (const box of gutterBoxes()) addStaticBox(world, box);
  for (const box of pitBoxes()) addStaticBox(world, box);
}

function addTetheredRack(world: RAPIER.World): RAPIER.RigidBody[] {
  const mass = pinMassProperties();
  return pinRackPositions().map((spot) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(spot.x, spot.y, spot.z),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2, LANE.pinBellyRadius)
        .setMassProperties(mass.mass, mass.centerOfMass, mass.principalAngularInertia, IDENTITY)
        .setFriction(PIN_PHYSICS.friction)
        .setRestitution(PIN_PHYSICS.restitution)
        .setCollisionGroups((GROUP.PIN << 16) | 0xffff),
      body,
    );
    const anchor = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(spot.x, TETHER.topY, spot.z),
    );
    // Slack rope joint, exactly as the rack builds it: the cord stays slack during
    // the throw (REQ-014) so a struck pin falls freely and transfers momentum.
    world.createImpulseJoint(
      RAPIER.JointData.rope(TETHER.slackLength, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
      body,
      anchor,
      true,
    );
    return body;
  });
}

const upAxisY = (body: RAPIER.RigidBody): number => {
  const r = body.rotation();
  return 1 - 2 * (r.x * r.x + r.z * r.z);
};

interface ThrowResult {
  // Did the ball travel past the head pin spot (its z went beyond the head spot)?
  readonly carriedPastHead: boolean;
  // Highest the ball rose while over the deck region. A ball that DRIVES THROUGH
  // the pocket stays low (near the bed); a ball that CLIMBS the head pin and pops
  // over the rack spikes well above pin height. This is what distinguishes a real
  // carry-through from the fly-over bug, since a popped ball lands in the pit and
  // would otherwise read as "past the head pin" too.
  readonly maxYOverDeck: number;
  // Did at least one pin behind the head pin topple (not just the head pin)?
  readonly knockedBehind: boolean;
  // Final standing count, to read strike rarity.
  readonly standing: number;
}

// A ball that drives through the pocket low never rises far above the bed; one
// that climbs the head pin and sails over the rack spikes past pin height. A
// duckpin pin is ~0.24m tall, so an over-deck peak under this clears "drove
// through" from "flew over" with margin (drive-through peaks ~0.5, fly-over ~0.7+).
const CARRY_MAX_Y = 0.58;

// Throw the ball with the SAME params main.ts feeds launch(): a spin stop, a power
// stop, and a stance offset, including LANE.ballLaunchTopspin. Returns whether the
// ball carried past the head pin and toppled a pin behind it, plus the standing
// count once everything resolves.
function throwShot(stop: number, power: number, lateralOffset: number): ThrowResult {
  const world = makeWorld();
  addLane(world);
  const pins = addTetheredRack(world);
  for (let i = 0; i < 60; i += 1) world.step(); // settle the rack

  const spawn = ballSpawnPosition();
  const ball = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x + lateralOffset, spawn.y, spawn.z)
      .setCcdEnabled(true)
      .setLinearDamping(LANE.ballLinearDamping)
      .setAngularDamping(LANE.ballAngularDamping),
  );
  world.createCollider(
    RAPIER.ColliderDesc.ball(LANE.ballRadius)
      .setMass(LANE.ballMass)
      .setFriction(LANE.ballFriction)
      .setRestitution(LANE.ballRestitution)
      .setCollisionGroups((GROUP.BALL << 16) | 0xffff),
    ball,
  );
  // Mirror Ball.launch(): the resolved launch velocity, the reduced forward
  // topspin, and the chosen-side yaw spin.
  const velocity = ballLaunchVelocity(stop, power, lateralOffset);
  ball.setLinvel(velocity, true);
  ball.setAngvel(
    {
      x: (velocity.z / LANE.ballRadius) * LANE.ballLaunchTopspin,
      y: spinFraction(stop) * SPIN.maxSpinYaw,
      z: 0,
    },
    true,
  );

  let minBallZ = Infinity;
  let maxYOverDeck = 0;
  const minUp = pins.map(() => 1);
  for (let i = 0; i < 480; i += 1) {
    world.step();
    const t = ball.translation();
    minBallZ = Math.min(minBallZ, t.z);
    if (t.z < FRONT_Z) maxYOverDeck = Math.max(maxYOverDeck, t.y);
    pins.forEach((pin, j) => {
      minUp[j] = Math.min(minUp[j], upAxisY(pin));
    });
  }

  const toppled = (i: number): boolean => minUp[i] < 0.6;
  const standing = pins.filter((pin, i) => {
    const t = pin.translation();
    const onDeck = t.x > -LANE.width / 2 && t.x < LANE.width / 2 && t.z > BACK_Z && t.z < FRONT_Z;
    return !toppled(i) && onDeck;
  }).length;

  const result: ThrowResult = {
    carriedPastHead: minBallZ < LANE.headSpot.z,
    maxYOverDeck,
    knockedBehind: PINS_BEHIND_HEAD.some(toppled),
    standing,
  };
  world.free();
  return result;
}

describe('a good pocket hit carries past the head pin into the pack (REQ-030)', () => {
  // A spread of representative pocket throws the actual control scheme produces:
  // good power (centred stop = full speed), modest spin, slight stance into the
  // pocket. Not one hand-picked perfect shot, so it reflects real play.
  const throws: ReadonlyArray<{ stop: number; power: number; offset: number; label: string }> = [
    { stop: 0, power: 0, offset: 0, label: 'straight, centred' },
    { stop: 0.15, power: 0, offset: 0.04, label: 'slight right pocket' },
    { stop: -0.15, power: 0, offset: -0.04, label: 'slight left pocket' },
    { stop: 0.2, power: 0, offset: 0.06, label: 'right pocket' },
    { stop: -0.2, power: 0, offset: -0.06, label: 'left pocket' },
    { stop: 0.1, power: 0, offset: 0.05, label: 'right pocket, soft spin' },
    { stop: -0.1, power: 0, offset: -0.05, label: 'left pocket, soft spin' },
  ];

  let results: { label: string; r: ThrowResult }[] = [];
  beforeAll(() => {
    results = throws.map((t) => ({ label: t.label, r: throwShot(t.stop, t.power, t.offset) }));
  });

  it('drives the ball low through the pocket into a pin behind it on most throws', () => {
    // The defining fix: the ball must drive THROUGH the head pin (past the head
    // spot, staying low rather than popping over the rack) AND knock a pin behind
    // it, not stall and drop only the front pin. Require this for a healthy
    // majority of the representative pocket throws (the odd hard hook can miss the
    // rack and is allowed to). Against the full-topspin tuning the ball climbed the
    // head pin and sailed over (maxYOverDeck spikes past CARRY_MAX_Y), so it fails.
    const carried = results.filter(
      (x) => x.r.carriedPastHead && x.r.maxYOverDeck < CARRY_MAX_Y && x.r.knockedBehind,
    ).length;
    expect(carried).toBeGreaterThanOrEqual(Math.ceil(results.length * 0.6));
  });

  it('keeps the ball low through the rack on a straight pocket shot (no fly-over)', () => {
    // A straight centred shot used to climb the head pin and sail ~0.8m over the
    // rack, leaving only the front pin down. It must now stay low and clear several.
    const straight = results.find((x) => x.label === 'straight, centred')!.r;
    expect(straight.maxYOverDeck).toBeLessThan(CARRY_MAX_Y);
    expect(straight.knockedBehind).toBe(true);
    expect(10 - straight.standing).toBeGreaterThanOrEqual(2);
  });
});

describe('duckpin strikes stay hard after the carry-through fix (REQ-030)', () => {
  it('a dead-centre straight pocket shot does not strike', () => {
    // The carry-through fix must not turn duckpin into tenpin: a dead-straight
    // full-power ball still has to leave pins standing. Strikes have to be worked
    // for with spin and angle, never handed out for aiming at the one.
    const r = throwShot(0, 0, 0);
    expect(r.standing).toBeGreaterThan(0);
  });

  it('no representative pocket throw clears the whole rack', () => {
    // Across the same spread of good throws, none should be a clean ten-pin strike.
    const throws = [
      [0, 0, 0],
      [0.15, 0, 0.04],
      [-0.15, 0, -0.04],
      [0.2, 0, 0.06],
      [-0.2, 0, -0.06],
    ] as const;
    const strikes = throws.filter(([s, p, o]) => throwShot(s, p, o).standing === 0).length;
    expect(strikes).toBe(0);
  });
});
