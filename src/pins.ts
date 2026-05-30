// The ten-pin rack. Spawns ten duckpins in the standard triangle at the head
// spot and keeps their meshes in sync with the physics bodies.
//
// A duckpin is squat and belly-heavy (GDD REQ-026): the collider is a short
// cylinder at the belly radius, and the mass is concentrated low so the pin
// resists toppling and transfers little energy. That low centre of mass, plus
// the low-restitution PIN_PHYSICS contact material (GDD REQ-030: pins barely
// bounce off each other, so the collision chain dies out fast), is the physical
// reason real strikes stay rare; both are config-driven rather than scripted.
//
// The triangle (GDD REQ-027) is the standard 1-2-3-4 arrangement: the head pin
// sits on the head spot and the three back rows recede down-lane onto the deck.
// The pure layout/mass helpers are exported so the rack geometry can be unit
// tested without booting the Rapier WASM.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER, PIN_PHYSICS, type Vec3 } from './config.js';
import type { World3D } from './world3d.js';
import type { PinKinematics } from './detection.js';
import type { ResetTarget, ReelTarget } from './reset.js';

const UPRIGHT = { x: 0, y: 0, z: 0, w: 1 };

// Duckpin silhouette as normalized control points, base to top. Each point is
// (fraction of pin height from the base, radius as a fraction of the belly
// radius). A duckpin is short and squat: a small flat foot, a fat belly low in
// the body, a pinched-in neck above it, then a small rounded crown. This reads
// clearly as a duckpin rather than the tall taper of a tenpin (GDD REQ-026,
// look-and-feel: squat, belly-heavy pins). The neck pinch sits just below the
// cord anchor (TETHER.neckLocalY is pinHeight * 0.3 above centre, i.e. 0.8 of
// the height from the base), so the cord visibly leaves the narrow neck.
const DUCKPIN_SILHOUETTE: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.0],   // closed base centre, so the lathe caps the foot
  [0.0, 0.52],  // flat foot rim
  [0.05, 0.62], // base fillet
  [0.18, 0.86], // belly rising
  [0.34, 1.0],  // widest point: the fat belly, low in the body
  [0.5, 0.92],  // belly falling away
  [0.66, 0.6],  // shoulder pulling in
  [0.78, 0.43], // neck: the narrow waist below the crown
  [0.88, 0.52], // crown flaring back out
  [0.96, 0.46], // rounded top shoulder
  [1.0, 0.0],   // closed crown centre, so the lathe caps the top
];

// Build the LatheGeometry profile for a duckpin of the given height and belly
// radius. Returns points in the mesh's local frame: y runs from -height/2 (the
// base) to +height/2 (the top), x is the radius at that height. Pure and
// Three-only so the silhouette can be unit tested without the renderer.
export function duckpinProfilePoints(
  height: number,
  bellyRadius: number,
): THREE.Vector2[] {
  return DUCKPIN_SILHOUETTE.map(
    ([t, r]) => new THREE.Vector2(r * bellyRadius, (t - 0.5) * height),
  );
}

// Down-lane distance between triangle rows. The pins are on a triangular grid
// with `pinSpacing` between neighbours, so the row-to-row gap is the triangle
// height for that spacing.
const ROW_GAP = LANE.pinSpacing * (Math.sqrt(3) / 2);

// Belly sits below the geometric centre; this fraction of the pin height is how
// far the centre of mass drops, making the pin bottom-heavy.
const BELLY_DROP = 0.18;

// The standard triangle, head pin first: row r (0..3) holds r+1 pins, centred
// on the lane and receding one ROW_GAP further down-lane per row. y rests the
// pin base on the deck surface.
export function pinRackPositions(): Vec3[] {
  const positions: Vec3[] = [];
  const y = LANE.floorY + LANE.pinHeight / 2;
  for (let row = 0; row < 4; row += 1) {
    const z = LANE.headSpot.z - row * ROW_GAP;
    for (let i = 0; i <= row; i += 1) {
      const x = (i - row / 2) * LANE.pinSpacing;
      positions.push({ x: LANE.headSpot.x + x, y, z });
    }
  }
  return positions;
}

export interface PinMassProperties {
  readonly mass: number;
  readonly centerOfMass: Vec3;
  readonly principalAngularInertia: Vec3;
}

// Mass properties for a solid cylinder of the pin's belly radius and height,
// with the centre of mass dropped toward the belly (GDD REQ-026). Standard
// cylinder inertia about its own centre: Iy spins about the upright axis, Ix/Iz
// about the horizontal axes.
export function pinMassProperties(): PinMassProperties {
  const m = LANE.pinMass;
  const r = LANE.pinBellyRadius;
  const h = LANE.pinHeight;
  const iy = 0.5 * m * r * r;
  const ixz = (1 / 12) * m * (3 * r * r + h * h);
  return {
    mass: m,
    centerOfMass: { x: 0, y: -h * BELLY_DROP, z: 0 },
    principalAngularInertia: { x: ixz, y: iy, z: ixz },
  };
}

// The cord attaches at the pin's neck: a local-frame point above the body centre
// (GDD REQ-013). It rotates with the pin, so it tracks the neck as the pin tumbles.
export function neckLocalAnchor(): Vec3 {
  return { x: 0, y: TETHER.neckLocalY, z: 0 };
}

// Each pin's overhead anchor sits at a fixed point directly above its home spot
// (GDD REQ-013, REQ-015). Pure, so the rest/worst-case slack geometry is testable.
export function tetherAnchorPositions(): Vec3[] {
  return pinRackPositions().map((spot) => ({ x: spot.x, y: TETHER.topY, z: spot.z }));
}

// Pin membership tag plus a filter that collides with everything, so future
// ball/string/gutter slices can select pins without re-tagging them here.
const PIN_COLLISION_GROUPS = (GROUP.PIN << 16) | 0xffff;

// Scratch objects reused every frame in sync() to avoid per-pin allocation.
const _neck = new THREE.Vector3();

interface Pin {
  readonly mesh: THREE.Mesh;
  readonly body: RAPIER.RigidBody;
  // Fixed, collider-less overhead anchor the cord hangs from. Not added to the
  // scene (it is invisible).
  readonly anchorBody: RAPIER.RigidBody;
  // The rope joint between the pin neck and the anchor. Mutable so the reset can
  // reel the cord in (shorten its max length) to drag the pin up by the neck. A
  // rope joint's length is not settable at runtime in the compat build, so a reel
  // step removes this joint and creates a shorter one in its place.
  joint: RAPIER.ImpulseJoint;
  // The current rope length, so a reel step skips the remove/recreate when the
  // length is unchanged (the common case once a phase holds at one length).
  ropeLength: number;
  // Visual cord: vertex 0 is the static anchor, vertex 1 tracks the pin neck.
  readonly cord: THREE.Line;
}

export class PinSet {
  private readonly pins: Pin[] = [];
  private readonly geometry: THREE.LatheGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly cordMaterial: THREE.LineBasicMaterial;

  constructor(private readonly world: World3D) {
    // Squat ivory duckpin: a single shared lathe geometry across the rack,
    // revolved from the duckpin silhouette (fat low belly pinching to a neck and
    // a small crown) so the pins read as duckpins, not plain cylinders. The
    // collider stays a simple belly-radius cylinder (below): this is the visual
    // mesh only, so the tuned scatter/cord/detection physics is untouched.
    this.geometry = new THREE.LatheGeometry(
      duckpinProfilePoints(LANE.pinHeight, LANE.pinBellyRadius),
      24,
    );
    this.material = new THREE.MeshStandardMaterial({
      color: 0xeae2d0,
      roughness: 0.4,
      metalness: 0.05,
    });
    // Shared thin cord material; each cord has its own 2-vertex geometry.
    this.cordMaterial = new THREE.LineBasicMaterial({
      color: TETHER.cordColor,
      transparent: true,
      opacity: 0.7,
    });

    const mass = pinMassProperties();
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const neckLocal = neckLocalAnchor();
    for (const spot of pinRackPositions()) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(spot.x, spot.y, spot.z);
      this.world.scene.add(mesh);

      const body = this.world.physics.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(spot.x, spot.y, spot.z),
      );
      const collider = RAPIER.ColliderDesc.cylinder(
        LANE.pinHeight / 2,
        LANE.pinBellyRadius,
      )
        .setMassProperties(
          mass.mass,
          mass.centerOfMass,
          mass.principalAngularInertia,
          identity,
        )
        // Low energy transfer keeps duckpin strikes rare (GDD REQ-030): the
        // pins barely bounce off each other, so the collision chain dies out
        // fast instead of spraying the rack like tenpin.
        .setFriction(PIN_PHYSICS.friction)
        .setRestitution(PIN_PHYSICS.restitution)
        .setCollisionGroups(PIN_COLLISION_GROUPS);
      this.world.physics.createCollider(collider, body);

      // Fixed, collider-less overhead anchor directly above the home spot. With
      // no collider it has zero collision presence (cannot hit pins/ball/cords).
      const anchorBody = this.world.physics.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(spot.x, TETHER.topY, spot.z),
      );
      // Slack rope joint: neck (on the pin) to the anchor origin. Slack until the
      // distance hits slackLength, so pins fall and collide freely (REQ-014).
      const joint = this.world.physics.createImpulseJoint(
        RAPIER.JointData.rope(TETHER.slackLength, neckLocal, { x: 0, y: 0, z: 0 }),
        body,
        anchorBody,
        true,
      );

      // Cord: vertex 0 is the static anchor, vertex 1 the neck (rest position).
      const cordGeo = new THREE.BufferGeometry();
      cordGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(
          new Float32Array([
            spot.x, TETHER.topY, spot.z,
            spot.x, spot.y + TETHER.neckLocalY, spot.z,
          ]),
          3,
        ),
      );
      const cord = new THREE.Line(cordGeo, this.cordMaterial);
      // Endpoints span far down-lane; skip frustum culling so cords never vanish.
      cord.frustumCulled = false;
      this.world.scene.add(cord);

      this.pins.push({ mesh, body, anchorBody, joint, ropeLength: TETHER.slackLength, cord });
    }
  }

  // Per-pin kinematic snapshot for the standing/fallen detector (REQ-016/017).
  // Reads each body's transform and velocities into plain values so the detector
  // stays pure and Rapier-free.
  pinStates(): PinKinematics[] {
    return this.pins.map((pin) => {
      const t = pin.body.translation();
      const r = pin.body.rotation();
      const lv = pin.body.linvel();
      const av = pin.body.angvel();
      return {
        position: { x: t.x, y: t.y, z: t.z },
        rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
        linSpeed: Math.hypot(lv.x, lv.y, lv.z),
        angSpeed: Math.hypot(av.x, av.y, av.z),
      };
    });
  }

  // Begin a reset. The cord-tension lift keeps the pins DYNAMIC (the cord reels
  // them up by the neck, gravity makes them hang and swing), so this just wakes
  // them so the reeling cord acts immediately. No teleport, no snap-upright.
  beginReset(pinIndices: readonly number[]): void {
    for (const i of pinIndices) this.pins[i].body.wakeUp();
  }

  // Reel each pin's cord to the given length (REQ-024 cord-tension lift). As the
  // rope's max length shortens below the anchor-to-neck distance, the constraint
  // drags the pin up BY ITS NECK; the belly-heavy pin hangs base-down and swings
  // under gravity. The rope joint's length is not settable at runtime in the
  // compat build, so a length change removes the joint and creates a shorter one
  // in its place (skipped when the length is unchanged, the common steady-state).
  reelStep(reels: readonly ReelTarget[]): void {
    const neckLocal = neckLocalAnchor();
    for (const reel of reels) {
      const pin = this.pins[reel.pinIndex];
      if (pin.ropeLength === reel.ropeLength) continue;
      this.world.physics.removeImpulseJoint(pin.joint, true);
      pin.joint = this.world.physics.createImpulseJoint(
        RAPIER.JointData.rope(reel.ropeLength, neckLocal, { x: 0, y: 0, z: 0 }),
        pin.body,
        pin.anchorBody,
        true,
      );
      pin.ropeLength = reel.ropeLength;
      pin.body.wakeUp();
    }
  }

  // Apply one step of reset targets: carry each targeted pin to the given centre,
  // upright. Used only for the kinematic reposition / lower phases, after the
  // cord-tension lift has hung the rack aloft. Pins not in the target list are
  // untouched (respot in place, REQ-021).
  resetStep(targets: readonly ResetTarget[]): void {
    for (const target of targets) {
      const body = this.pins[target.pinIndex].body;
      body.setNextKinematicTranslation({ x: target.x, y: target.y, z: target.z });
      body.setNextKinematicRotation(UPRIGHT);
    }
  }

  // Capture the given pins as kinematic at their current hanging pose so the reset
  // can carry them home cleanly after the cord-tension lift (the reposition /
  // lower phases). Snaps the cord back to slack so the now-kinematic carry is not
  // fighting a short rope.
  recaptureKinematic(pinIndices: readonly number[]): void {
    for (const i of pinIndices) {
      const pin = this.pins[i];
      pin.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.restoreCord(pin);
    }
  }

  // Restore a pin's cord to its at-throw slack length (the inverse of reeling it
  // in). Used when a pin is handed back to play or captured for the carry so it is
  // not left on a short reeled rope.
  private restoreCord(pin: Pin): void {
    if (pin.ropeLength === TETHER.slackLength) return;
    this.world.physics.removeImpulseJoint(pin.joint, true);
    pin.joint = this.world.physics.createImpulseJoint(
      RAPIER.JointData.rope(TETHER.slackLength, neckLocalAnchor(), { x: 0, y: 0, z: 0 }),
      pin.body,
      pin.anchorBody,
      true,
    );
    pin.ropeLength = TETHER.slackLength;
  }

  // Hand the given pins back to the dynamics, at rest, with their cords restored
  // to slack. Call when the reset completes; the pins are then standing on their
  // home spots under gravity, free on slack cords as in normal play.
  endReset(pinIndices: readonly number[]): void {
    for (const i of pinIndices) {
      const pin = this.pins[i];
      this.restoreCord(pin);
      pin.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      pin.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      pin.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  // Copy each body's transform onto its mesh, then drag the cord's lower end to
  // the pin neck. Call once per rendered frame after stepping physics.
  sync(): void {
    for (const pin of this.pins) {
      const t = pin.body.translation();
      const r = pin.body.rotation();
      pin.mesh.position.set(t.x, t.y, t.z);
      pin.mesh.quaternion.set(r.x, r.y, r.z, r.w);

      // Neck world position: the local neck point rotated by the pin and offset
      // to its centre. Vertex 0 (the anchor) is static, so only vertex 1 moves.
      _neck.set(0, TETHER.neckLocalY, 0).applyQuaternion(pin.mesh.quaternion);
      const pos = pin.cord.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(1, t.x + _neck.x, t.y + _neck.y, t.z + _neck.z);
      pos.needsUpdate = true;
    }
  }
}
