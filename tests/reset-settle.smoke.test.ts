// Physics smoke: every pin comes to rest after a shot and a reset. No pin keeps
// swinging (playtest bug 4: one pin whipped around the screen and never settled).
//
// Root cause: a pin collider is a plain cylinder, so a knocked-down pin lying on
// its side is a perfect roller. With its neck still on its cord, the cord's
// restoring pull plus the belly contact drive a tetherball-style limit cycle, and
// the pin spins about its long axis indefinitely (never reaching the at-rest
// thresholds). Modest body damping (LANE.pinLinearDamping / pinAngularDamping)
// bleeds off that residual spin so the pin settles within the settle window.
//
// Both scenarios run on the real Rapier WASM at a fixed 60fps step, against the
// REAL PinSet (the production cord-reel / cone-seat / recapture / endReset code in
// src/pins.ts), wired the same way main.ts's stepReset wires it:
//
//   (A) the direct repro: a hard-flung, still-tethered pin must reach rest within
//       the settle window. Pre-fix it spins forever (angular speed pinned near
//       1 rad/s, well above the 0.1 at-rest ceiling); post-fix it settles.
//   (B) several full shot+reset cycles (a between-balls respot then a frame-end
//       rerack, carrying held-aloft pins across cycles): each cycle COMPLETES
//       within a bounded number of steps, and afterwards every on-deck pin is AT
//       REST (linear and angular speed at or below the detection thresholds).

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, TETHER, DETECTION, RESET, TANGLE, PIN_REST_Y } from '../src/config.js';
import { PinSet, pinRackPositions } from '../src/pins.js';
import { classifyRack, isRackSnagged } from '../src/detection.js';
import { ResetCycle, type ResetMode, type ResetPhase } from '../src/reset.js';
import type { World3D } from '../src/world3d.js';

beforeAll(async () => {
  await RAPIER.init();
});

const cfg = { ...RESET, ...TANGLE, restY: PIN_REST_Y, seatY: RESET.liftPinY };

// A physics-and-scene-only stand-in for World3D, enough to construct the real
// PinSet (it only reads world.scene and world.physics). No renderer / DOM, so it
// runs headless against the real Rapier WASM.
function makeStandIn(): { scene: THREE.Scene; physics: RAPIER.World } {
  const physics = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
  physics.timestep = 1 / 60;
  const bed = physics.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, -LANE.length / 2),
  );
  physics.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, LANE.length / 2), bed);
  const frontZ = LANE.headSpot.z + 0.15;
  const backZ = LANE.headSpot.z - LANE.pinDeckDepth;
  const deck = physics.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, (frontZ + backZ) / 2),
  );
  physics.createCollider(RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, (frontZ - backZ) / 2), deck);
  return { scene: new THREE.Scene(), physics };
}

// Drives the real PinSet through one reset cycle exactly as main.ts stepReset
// does, then hands the landed pins back at endReset. clearedPins carries the
// between-balls held-aloft pins across cycles (kinematic and aloft).
class Rig {
  readonly world: ReturnType<typeof makeStandIn>;
  readonly pins: PinSet;
  readonly homes = pinRackPositions();
  clearedPins = new Set<number>();

  constructor() {
    this.world = makeStandIn();
    this.pins = new PinSet(this.world as unknown as World3D);
  }

  free(): void {
    this.world.physics.free();
  }

  step(): void {
    this.world.physics.step();
  }

  // Worst-case linear / angular speed among the ON-DECK pins (held-aloft cleared
  // pins are kinematic and not in play).
  worstOnDeckSpeeds(): { maxLin: number; maxAng: number } {
    let maxLin = 0;
    let maxAng = 0;
    for (const s of this.pins.pinStates()) {
      if (s.position.y > DETECTION.deckFootprint.maxCenterY) continue;
      maxLin = Math.max(maxLin, s.linSpeed);
      maxAng = Math.max(maxAng, s.angSpeed);
    }
    return { maxLin, maxAng };
  }

  // One reset cycle to completion. Throws if it ever runs unbounded.
  runReset(mode: ResetMode): number {
    const before = classifyRack(this.pins.pinStates(), DETECTION);
    const fallen = before
      .filter((p) => !p.standing)
      .map((p) => p.pinIndex)
      .filter((index) => mode === 'rerack' || !this.clearedPins.has(index));

    const settled = this.pins.pinStates().map((s) => s.position);
    const all = this.homes.map((_, i) => i);
    const heldAloft = mode === 'rerack' ? fallen : [...new Set([...fallen, ...this.clearedPins])];

    this.pins.beginReset(all);
    const reset = new ResetCycle(cfg);
    reset.start(mode, heldAloft, this.homes, settled);

    const reeled = [...reset.targets];
    let prevPhase: ResetPhase = 'idle';
    let steps = 0;
    const cap =
      reset.totalFrames +
      (TANGLE.shakeDownFrames + TANGLE.shakeUpFrames) * (TANGLE.maxRetries + 2) +
      400;

    while (reset.isRunning) {
      if (steps >= cap) throw new Error(`reset cycle ran unbounded (${mode}) at ${steps} steps`);
      const { targets, reel } = reset.step();
      const phase = reset.phase;

      if (reset.needsSnagVerdict) {
        reset.reportSnag(isRackSnagged(this.pins.pinStates(), TETHER.neckLocalY, TANGLE));
        this.step();
        steps += 1;
        prevPhase = phase;
        continue;
      }

      if (phase === 'seat' && prevPhase !== 'seat') {
        this.pins.recaptureKinematic(reeled);
        reset.updateSettled(this.pins.pinStates().map((s) => s.position));
      }

      if (reel.length > 0) this.pins.reelStep(reel);
      if (targets.length > 0) this.pins.resetStep(targets);

      this.step();
      steps += 1;
      prevPhase = phase;
    }

    this.pins.endReset(reset.landedTargets);
    this.clearedPins = mode === 'rerack' ? new Set() : new Set(reset.heldAloftTargets);
    return steps;
  }

  // Shove the front-row pins sideways so the next reset reads a genuine
  // between-balls respot (standing pins re-spotted, fallen pins held aloft).
  // PinSet keeps its bodies private, so the shove is applied to the dynamic pin
  // bodies found in the world by their down-lane (front-row) position.
  knockFront(): void {
    for (let i = 0; i < 30; i += 1) this.step();
    const frontZ = this.homes[0].z;
    this.world.physics.forEachRigidBody((body) => {
      if (body.bodyType() !== RAPIER.RigidBodyType.Dynamic) return;
      const t = body.translation();
      if (t.z < frontZ - LANE.pinSpacing) return;
      body.setLinvel({ x: 2.5, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: -16 }, true);
    });
    for (let i = 0; i < 150; i += 1) this.step();
  }

  // Topple the head pin in place: a low lateral shove with a strong spin so it
  // lies down ON the deck (not flung off into a gutter), still on its cord. This
  // is the case that left a still-tethered pin spinning about its long axis on its
  // cord forever (a tetherball limit cycle), the swinging pin from playtest bug 4.
  toppleHeadInPlace(): void {
    for (let i = 0; i < 30; i += 1) this.step();
    const head = this.homes[0];
    this.world.physics.forEachRigidBody((body) => {
      if (body.bodyType() !== RAPIER.RigidBodyType.Dynamic) return;
      const t = body.translation();
      if (Math.hypot(t.x - head.x, t.z - head.z) > 0.02) return;
      body.setLinvel({ x: 1.2, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: -9 }, true);
    });
  }
}

describe('every pin comes to rest after a shot and a reset (no swinging pin)', () => {
  it('a toppled, still-tethered on-deck pin settles within the settle window (does not spin forever on its cord)', () => {
    const rig = new Rig();
    for (let i = 0; i < 60; i += 1) rig.step();

    rig.toppleHeadInPlace();
    // Give the shot a generous, bounded window to settle (the live shot watcher and
    // settle window span several hundred frames before a reset). Pre-fix the toppled
    // pin pumps a cord limit cycle and never reaches rest in any window.
    for (let i = 0; i < 480; i += 1) rig.step();

    const { maxLin, maxAng } = rig.worstOnDeckSpeeds();
    expect(maxLin).toBeLessThanOrEqual(DETECTION.atRestLinSpeed);
    expect(maxAng).toBeLessThanOrEqual(DETECTION.atRestAngSpeed);
    rig.free();
  });

  it('runs several full reset cycles (between-balls respot then rerack) and no pin keeps swinging', () => {
    const rig = new Rig();
    for (let i = 0; i < 60; i += 1) rig.step();

    for (let frame = 0; frame < 3; frame += 1) {
      rig.knockFront();

      const betweenSteps = rig.runReset('between-balls');
      expect(betweenSteps).toBeGreaterThan(0);
      for (let i = 0; i < DETECTION.settleMaxFrames; i += 1) rig.step();
      let m = rig.worstOnDeckSpeeds();
      expect(m.maxLin).toBeLessThanOrEqual(DETECTION.atRestLinSpeed);
      expect(m.maxAng).toBeLessThanOrEqual(DETECTION.atRestAngSpeed);

      const rerackSteps = rig.runReset('rerack');
      expect(rerackSteps).toBeGreaterThan(0);
      for (let i = 0; i < DETECTION.settleMaxFrames; i += 1) rig.step();
      m = rig.worstOnDeckSpeeds();
      expect(m.maxLin).toBeLessThanOrEqual(DETECTION.atRestLinSpeed);
      expect(m.maxAng).toBeLessThanOrEqual(DETECTION.atRestAngSpeed);

      // The fresh rack reads as ten standing pins on their home spots.
      const after = classifyRack(rig.pins.pinStates(), DETECTION);
      expect(after.filter((p) => p.standing).length).toBe(10);
    }
    rig.free();
  });
});
