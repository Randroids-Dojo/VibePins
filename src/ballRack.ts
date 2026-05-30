// The physical ball rack / return cradle (REQ-039). A queue of dynamic Rapier
// ball bodies physically held at rest in the static cradle (src/config.ts
// ballCradleBoxes): they sit on the trough floor, nestled against each other and
// the front end stop, retained laterally by the side walls. This replaces PR
// #66's decorative ball meshes resting on the floor with real physics: the
// just-thrown ball returns up the runway, rolls into the back of the queue,
// bumps it, and the whole queue settles forward against the stop (the
// bump-and-settle of a Pins Mechanical return).
//
// Stability is the design constraint (RULE 10, and the PR #63 swinging-pin
// lesson): the balls carry the same linear/angular damping as the playable ball
// plus low restitution, and Rapier sleeps them once at rest, so the queue comes
// to a hard stop instead of jittering or creeping forever. The cradle floor is
// level (not a perpetual slope), so a settled queue has nothing driving it.
//
// The front of the queue is the pickup slot: the live playable Ball rests there
// between shots and is lifted by the shot-setup pickup, so this rack holds the
// QUEUED balls behind the front slot (the spares waiting their turn). The
// front-of-queue position is exposed so the pickup and the queue advance stay
// in lockstep with the live ball.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, GROUP, ballCradleBoxes, ballCradleRestPositions, type Vec3 } from './config.js';
import type { World3D } from './world3d.js';

// Same membership as the playable ball so the queued balls collide with the
// cradle, the playable ball, and each other (filter collides with everything).
const BALL_COLLISION_GROUPS = (GROUP.BALL << 16) | 0xffff;

// The dynamic queued balls sit BEHIND the front pickup slot, which is held by
// the live playable ball. So the rack owns one fewer body than the cradle holds.
function queuedRestPositions(): Vec3[] {
  return ballCradleRestPositions().slice(1);
}

export class BallRack {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly bodies: RAPIER.RigidBody[] = [];
  private readonly geometry: THREE.SphereGeometry;
  private readonly material: THREE.MeshStandardMaterial;

  constructor(private readonly world: World3D) {
    // Static cradle colliders: the trough floor, side walls, front/back stops.
    for (const box of ballCradleBoxes()) {
      const body = this.world.physics.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(box.center.x, box.center.y, box.center.z),
      );
      this.world.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(box.half.x, box.half.y, box.half.z)
          .setFriction(LANE.ballFriction)
          .setRestitution(LANE.ballRestitution),
        body,
      );
    }

    // Dynamic queued balls, same dark polished look as the playable ball.
    this.geometry = new THREE.SphereGeometry(LANE.ballRadius, 24, 12);
    this.material = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.35, metalness: 0.5 });
    for (const rest of queuedRestPositions()) {
      this.bodies.push(this.spawnBall(rest));
    }
  }

  private spawnBall(at: Vec3): RAPIER.RigidBody {
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.position.set(at.x, at.y, at.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.world.scene.add(mesh);
    this.meshes.push(mesh);

    const body = this.world.physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
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
      body,
    );
    return body;
  }

  // Sync the queued ball meshes from their physics bodies. Called each frame
  // alongside the playable ball and the pins.
  sync(): void {
    for (let i = 0; i < this.bodies.length; i += 1) {
      const t = this.bodies[i].translation();
      const r = this.bodies[i].rotation();
      this.meshes[i].position.set(t.x, t.y, t.z);
      this.meshes[i].quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}
