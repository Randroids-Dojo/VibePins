// The bowling ball (GDD REQ-028, REQ-029). A palm-sized sphere with no finger
// holes that rolls down the lane under physics from a launch velocity.
//
// This slice gives the ball a fixed down-lane launch so it rolls into the pins;
// aim, spin, and power (the three-step control scheme, REQ-033 to REQ-036) and
// the gutters (REQ-031) and foul line (REQ-032) are later slices. Mirrors the
// PinSet pattern: constructed with the World3D, owns one mesh + one dynamic
// body, and syncs the mesh from the body each frame.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, type Vec3 } from './config.js';
import type { World3D } from './world3d.js';

// Ball membership plus a filter that collides with everything (lane, deck,
// pins). Anchors are collider-less and cords are visual-only, so there is
// nothing spurious for the ball to hit.
const BALL_COLLISION_GROUPS = (GROUP.BALL << 16) | 0xffff;

// Spawn point: lane centre, behind the foul line (z=0), resting on the bed.
export function ballSpawnPosition(): Vec3 {
  return { x: LANE.headSpot.x, y: LANE.floorY + LANE.ballRadius, z: LANE.ballSpawnZ };
}

// Launch velocity: straight down-lane toward the pins (-z). No lateral aim or
// lift in this slice.
export function ballLaunchVelocity(): Vec3 {
  return { x: 0, y: 0, z: -LANE.ballLaunchSpeed };
}

export class Ball {
  private readonly mesh: THREE.Mesh;
  private readonly body: RAPIER.RigidBody;

  constructor(private readonly world: World3D) {
    const spawn = ballSpawnPosition();

    // Dark polished sphere, no finger holes (REQ-028).
    const geometry = new THREE.SphereGeometry(LANE.ballRadius, 32, 16);
    const material = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.35, metalness: 0.5 });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.position.set(spawn.x, spawn.y, spawn.z);
    this.world.scene.add(this.mesh);

    // CCD on: at 8 m/s the ball moves ~0.13m per fixed step, larger than the
    // 0.1m bed/deck thickness, so without it the ball could tunnel through.
    this.body = this.world.physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setCcdEnabled(true)
        .setLinearDamping(LANE.ballLinearDamping)
        .setAngularDamping(LANE.ballAngularDamping),
    );
    this.world.physics.createCollider(
      RAPIER.ColliderDesc.ball(LANE.ballRadius)
        .setMass(LANE.ballMass)
        .setFriction(LANE.ballFriction)
        .setRestitution(LANE.ballRestitution)
        .setCollisionGroups(BALL_COLLISION_GROUPS),
      this.body,
    );
  }

  // Send the ball down-lane with a matching forward roll so it rolls rather
  // than skids off the line. Rolling without slip for motion along -z means an
  // angular velocity about the x-axis of omega_x = -v / r; since velocity.z is
  // -v, that equals velocity.z / r.
  launch(): void {
    const velocity = ballLaunchVelocity();
    this.body.setLinvel(velocity, true);
    this.body.setAngvel({ x: velocity.z / LANE.ballRadius, y: 0, z: 0 }, true);
  }

  // Carry the ball kinematically during the shot-setup sequence (pickup, walk-up).
  // While kinematic it ignores gravity and is positioned each frame by holdAt.
  grab(): void {
    this.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  }

  holdAt(pos: Vec3): void {
    this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
    this.body.setNextKinematicRotation({ x: 0, y: 0, z: 0, w: 1 });
  }

  // Hand the ball back to the dynamics so it can be thrown (then call launch()).
  release(): void {
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  }

  sync(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}
