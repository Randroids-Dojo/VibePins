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
import { LANE, SPIN, POWER, GROUP, type Vec3 } from './config.js';
import type { World3D } from './world3d.js';

// Ball membership plus a filter that collides with everything (lane, deck,
// pins). Anchors are collider-less and cords are visual-only, so there is
// nothing spurious for the ball to hit.
const BALL_COLLISION_GROUPS = (GROUP.BALL << 16) | 0xffff;

// Spawn point: lane centre, behind the foul line (z=0), resting on the bed.
export function ballSpawnPosition(): Vec3 {
  return { x: LANE.headSpot.x, y: LANE.floorY + LANE.ballRadius, z: LANE.ballSpawnZ };
}

// Resolve the chosen spin/angle stop (normalized [-1, +1] from the sweep meter)
// into a launch (GDD REQ-034, REQ-036). A stop inside the straight band is a
// straight, no-spin ball. Outside it, the spin ramps from 0 at the band edge to
// its peak at the extreme, giving a lateral launch nudge (the ball points toward
// the chosen side) plus a vertical-axis spin that hooks the roll that way. The
// down-lane speed is the fixed launch speed until the power meter slice (F-007).
//
// Sign: +x is to the right, so a positive stop sends the ball and its hook to
// the right. Yaw about +y spins counter-clockwise viewed from above (rotating
// +z toward +x), which steers a -z roll toward +x, so spinYaw shares the sign.
export function spinFraction(stop: number): number {
  const s = Math.max(-1, Math.min(1, stop));
  if (Math.abs(s) <= SPIN.straightBand) return 0;
  const sign = Math.sign(s);
  // Ramp 0 -> 1 across the band edge to the extreme.
  return sign * ((Math.abs(s) - SPIN.straightBand) / (1 - SPIN.straightBand));
}

// Resolve the chosen power stop (normalized [-1, +1] from the power meter) into
// a down-lane launch speed (GDD REQ-035). The centred sweet-spot band is full
// power (the best shot); outside it the speed ramps down linearly to the minimum
// at the track extreme, so a mistimed stop is a weak push but never a dead ball.
// Symmetric in the stop's sign: only the distance from centre matters for speed.
export function powerSpeed(stop: number): number {
  const d = Math.min(1, Math.abs(stop));
  if (d <= POWER.sweetSpotBand) return POWER.maxSpeed;
  // Fraction from the band edge (0) to the extreme (1).
  const t = (d - POWER.sweetSpotBand) / (1 - POWER.sweetSpotBand);
  return POWER.maxSpeed + t * (POWER.minSpeed - POWER.maxSpeed);
}

// Launch velocity for a given spin/angle and power stop: down-lane (-z) at the
// power-resolved speed, plus the lateral nudge from the spin. With no power stop
// (undefined) the speed is the legacy fixed launch speed; a spin stop of 0 is a
// straight ball. Down-lane speed scales the spin's lateral nudge so the launch
// angle (not just the absolute sideways speed) tracks the chosen spin.
export function ballLaunchVelocity(stop = 0, power?: number): Vec3 {
  const speed = power === undefined ? LANE.ballLaunchSpeed : powerSpeed(power);
  return {
    x: spinFraction(stop) * SPIN.maxLateralSpeed * (speed / LANE.ballLaunchSpeed),
    y: 0,
    z: -speed,
  };
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
  // -v, that equals velocity.z / r. The spin/angle stop (REQ-034, default 0 for
  // the legacy straight shot) adds a lateral launch nudge and a vertical-axis
  // spin that hooks the roll toward the chosen side as it travels (REQ-036).
  // The power stop (REQ-035, default the legacy fixed speed) sets the down-lane
  // speed; the forward roll follows from the resulting velocity.
  launch(stop = 0, power?: number): void {
    const velocity = ballLaunchVelocity(stop, power);
    this.body.setLinvel(velocity, true);
    this.body.setAngvel(
      { x: velocity.z / LANE.ballRadius, y: spinFraction(stop) * SPIN.maxSpinYaw, z: 0 },
      true,
    );
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
