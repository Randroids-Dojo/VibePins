// Shared real-Rapier rack helpers for the reset smoke tests. The cord-tension
// reset reels each pin's rope joint in (the compat build cannot set a rope length
// at runtime, so a reel removes and recreates the joint), so the smokes need a
// pin-plus-anchor-plus-mutable-joint record and a reelPin helper, mirroring
// PinSet.reelStep. Extracted here so reset.smoke and tangle-recovery.smoke share
// one definition rather than duplicating it.

import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER } from '../../src/config.js';
import { pinRackPositions, pinMassProperties, neckLocalAnchor } from '../../src/pins.js';
import type { PinKinematics } from '../../src/detection.js';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const PIN_GROUPS = (GROUP.PIN << 16) | 0xffff;

// A pin, its overhead anchor, and the mutable rope joint between them.
export interface RackPin {
  body: RAPIER.RigidBody;
  anchor: RAPIER.RigidBody;
  joint: RAPIER.ImpulseJoint;
  ropeLength: number;
}

// The ten-pin rack on its slack cords, matching PinSet's rope geometry.
export function addRack(world: RAPIER.World): RackPin[] {
  const mass = pinMassProperties();
  return pinRackPositions().map((spot) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(spot.x, spot.y, spot.z));
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2, LANE.pinBellyRadius)
        .setMassProperties(mass.mass, mass.centerOfMass, mass.principalAngularInertia, IDENTITY)
        .setCollisionGroups(PIN_GROUPS),
      body,
    );
    const anchor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(spot.x, TETHER.topY, spot.z));
    const joint = world.createImpulseJoint(
      RAPIER.JointData.rope(TETHER.slackLength, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
      body,
      anchor,
      true,
    );
    return { body, anchor, joint, ropeLength: TETHER.slackLength };
  });
}

// Reel a pin's cord to a new length (PinSet.reelStep equivalent): the rope's max
// length shortens, so the constraint drags the pin up by the neck.
export function reelPin(world: RAPIER.World, pin: RackPin, length: number): void {
  if (pin.ropeLength === length) return;
  world.removeImpulseJoint(pin.joint, true);
  pin.joint = world.createImpulseJoint(
    RAPIER.JointData.rope(length, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
    pin.body,
    pin.anchor,
    true,
  );
  pin.ropeLength = length;
  pin.body.wakeUp();
}

// Plain kinematics snapshot of the rack for the pure detectors.
export function kinematics(pins: RackPin[]): PinKinematics[] {
  return pins.map(({ body }) => {
    const t = body.translation();
    const r = body.rotation();
    const lv = body.linvel();
    const av = body.angvel();
    return {
      position: { x: t.x, y: t.y, z: t.z },
      rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
      linSpeed: Math.hypot(lv.x, lv.y, lv.z),
      angSpeed: Math.hypot(av.x, av.y, av.z),
    };
  });
}
