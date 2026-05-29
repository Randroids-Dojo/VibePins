// The ten-pin rack. Spawns ten duckpins in the standard triangle at the head
// spot and keeps their meshes in sync with the physics bodies.
//
// A duckpin is squat and belly-heavy (GDD REQ-026): the collider is a short
// cylinder at the belly radius, and the mass is concentrated low so the pin
// resists toppling and transfers little energy. That low centre of mass is the
// physical reason real strikes stay rare (GDD REQ-030); it is computed here
// rather than scripted.
//
// The triangle (GDD REQ-027) is the standard 1-2-3-4 arrangement: the head pin
// sits on the head spot and the three back rows recede down-lane onto the deck.
// The pure layout/mass helpers are exported so the rack geometry can be unit
// tested without booting the Rapier WASM.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, TETHER, type Vec3 } from './config.js';
import type { World3D } from './world3d.js';
import type { PinKinematics } from './detection.js';

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
  // Fixed, collider-less overhead anchor the cord hangs from. Stored so a later
  // reset slice can reel it in; not added to the scene (it is invisible).
  readonly anchorBody: RAPIER.RigidBody;
  // Visual cord: vertex 0 is the static anchor, vertex 1 tracks the pin neck.
  readonly cord: THREE.Line;
}

export class PinSet {
  private readonly pins: Pin[] = [];
  private readonly geometry: THREE.CylinderGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly cordMaterial: THREE.LineBasicMaterial;

  constructor(private readonly world: World3D) {
    // Squat ivory duckpin: a single shared geometry/material across the rack.
    this.geometry = new THREE.CylinderGeometry(
      LANE.pinBellyRadius,
      LANE.pinBellyRadius,
      LANE.pinHeight,
      20,
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
        .setCollisionGroups(PIN_COLLISION_GROUPS);
      this.world.physics.createCollider(collider, body);

      // Fixed, collider-less overhead anchor directly above the home spot. With
      // no collider it has zero collision presence (cannot hit pins/ball/cords).
      const anchorBody = this.world.physics.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(spot.x, TETHER.topY, spot.z),
      );
      // Slack rope joint: neck (on the pin) to the anchor origin. Slack until the
      // distance hits slackLength, so pins fall and collide freely (REQ-014).
      this.world.physics.createImpulseJoint(
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

      this.pins.push({ mesh, body, anchorBody, cord });
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
