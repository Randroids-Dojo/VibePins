// Owns the Three.js renderer/scene/camera and the Rapier physics world.
// Modeled on the sibling project Hoops' World3D, adapted to Rapier (GDD
// 06-reuse-and-tech, "Scene and physics scaffolding").
//
// Rapier's `-compat` build initialises its WASM asynchronously, so this module
// exposes an async `createWorld3D` factory: callers await it once at boot, and
// the constructed World3D is fully synchronous thereafter (no per-frame cost).

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  LANE,
  SHOT_CAMERA,
  PINSETTER,
  VICTORY,
  MATERIALS,
  gutterBoxes,
  pitBoxes,
  pinsetterRigParts,
  type Box,
  type RigBeam,
  type RigCylinder,
  type SurfaceMaterial,
} from './config.js';
import { pinRackPositions } from './pins.js';
import type { Debris } from './victory.js';

const FIXED_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly physics: RAPIER.World;

  private accumulator = 0;
  private readonly resizeHandler = () => this.handleResize();

  // Strike victory-routine debris meshes (REQ-044). A fixed pool, hidden when no
  // burst is playing, mirrored each frame from the pure VictoryRoutine sim.
  private readonly debrisMeshes: THREE.Mesh[] = [];

  constructor(canvas: HTMLCanvasElement) {
    // Renderer: pixel-ratio cap at 2, soft shadows, sRGB output (Hoops convention).
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Scene: warm, moody machine-room dark with fog for depth (GDD 04-look-and-feel).
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0806);
    this.scene.fog = new THREE.Fog(0x0b0806, LANE.fogNear, LANE.fogFar);

    this.camera = new THREE.PerspectiveCamera(LANE.cameraFov, 1, 0.1, 100);
    this.camera.position.set(LANE.cameraPos.x, LANE.cameraPos.y, LANE.cameraPos.z);
    this.camera.lookAt(LANE.cameraLookAt.x, LANE.cameraLookAt.y, LANE.cameraLookAt.z);

    this.buildLighting();
    this.buildApproach();
    this.buildLane();
    this.buildLaneMarkers();
    this.buildGutters();
    this.buildPit();
    this.buildBallReturn();
    this.buildPinDeck();
    this.buildPinsetterRig();
    this.buildVictoryDebris();

    // Physics world. Gravity straight down; a fixed bed collider gives the
    // ball and pins something to rest on in later slices.
    this.physics = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
    this.physics.timestep = FIXED_STEP;
    this.buildLaneCollider();
    this.buildPinDeckCollider();
    this.buildGutterColliders();
    this.buildPitColliders();

    window.addEventListener('resize', this.resizeHandler);
    this.handleResize();
  }

  private buildLighting(): void {
    // Low warm ambient: enough to read the lane, dark enough to stay moody.
    this.scene.add(new THREE.AmbientLight(0xc79a6a, 0.38));

    // Warm directional fill across the whole lane (GDD 04-look-and-feel palette).
    const key = new THREE.DirectionalLight(0xffd9a0, 1.0);
    key.position.set(1.5, 8, 2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 30;
    this.scene.add(key);

    // Warm industrial work-light hung over the pin deck: the hero light, so the
    // pins glow against the dark venue (GDD 04-look-and-feel, pinsetter drive unit).
    const deckZ = LANE.headSpot.z - 0.4;
    const pinLight = new THREE.SpotLight(0xffc878, 90, 11, 0.7, 0.5, 1.4);
    pinLight.position.set(0, 2.9, LANE.headSpot.z + 0.3);
    pinLight.target.position.set(0, 0, deckZ);
    pinLight.castShadow = true;
    pinLight.shadow.mapSize.set(1024, 1024);
    pinLight.shadow.camera.near = 0.5;
    pinLight.shadow.camera.far = 6;
    this.scene.add(pinLight);
    this.scene.add(pinLight.target);
  }

  private buildLane(): void {
    const geo = new THREE.BoxGeometry(LANE.width, 0.1, LANE.length);
    const mat = this.surfaceMaterial(MATERIALS.oiledWoodLane);
    const bed = new THREE.Mesh(geo, mat);
    bed.position.set(0, LANE.floorY - 0.05, -LANE.length / 2);
    bed.receiveShadow = true;
    this.scene.add(bed);
  }

  // The approach floor behind the foul line (toward the camera), where the
  // bowler stands and the ball return sits. Slightly wider than the lane.
  private buildApproach(): void {
    const geo = new THREE.BoxGeometry(LANE.width + 0.6, 0.1, LANE.approachDepth);
    const mat = this.surfaceMaterial(MATERIALS.approachWood);
    const approach = new THREE.Mesh(geo, mat);
    approach.position.set(0, LANE.floorY - 0.05, LANE.approachDepth / 2);
    approach.receiveShadow = true;
    this.scene.add(approach);
  }

  // The ball return: a short steel rail beside the approach. The real ball rests
  // here at the start of the shot and is picked up by the setup sequence.
  private buildBallReturn(): void {
    const p = SHOT_CAMERA.ballReturnPos;
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.12, 0.7),
      this.surfaceMaterial(MATERIALS.brushedSteel),
    );
    rail.position.set(p.x, LANE.floorY + 0.06, p.z);
    rail.castShadow = true;
    rail.receiveShadow = true;
    this.scene.add(rail);
  }

  // Flat inlay markers on the lane surface: the foul line, a row of guide dots
  // just past it, and the seven aiming arrows in a chevron down-lane. As on a
  // real lane, the arrows are the player's visual aiming reference; the lateral
  // alignment control itself lives in the shot-setup camera (src/camera.ts).
  // Positions derive from the lane width so they stay centred.
  private buildLaneMarkers(): void {
    const y = LANE.floorY + 0.006; // sit just above the bed to avoid z-fighting
    const inlay = this.surfaceMaterial(MATERIALS.inlayWood);

    // Foul line across the lane at z = 0.
    const foul = new THREE.Mesh(
      new THREE.BoxGeometry(LANE.width, 0.012, 0.04),
      this.surfaceMaterial(MATERIALS.foulLine),
    );
    foul.position.set(0, y, 0);
    this.scene.add(foul);

    // Arrow x positions across the lane (board 5/10/15/20 layout, mirrored).
    const xs = [-0.41, -0.27, -0.137, 0, 0.137, 0.27, 0.41];

    // Aiming arrows: small darts pointing down-lane, centre arrow deepest so the
    // row forms a chevron (~3.7 to 4.6m past the foul line).
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.14);
    arrowShape.lineTo(-0.05, -0.06);
    arrowShape.lineTo(0.05, -0.06);
    arrowShape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);
    for (const x of xs) {
      const step = Math.round(Math.abs(x) / 0.137); // 0 centre .. 3 outer
      const arrow = new THREE.Mesh(arrowGeo, inlay);
      arrow.rotation.x = -Math.PI / 2; // lay flat, apex toward the pins (-z)
      arrow.position.set(x, y, -4.57 + step * 0.3);
      this.scene.add(arrow);
    }

    // Guide dots just past the foul line.
    const dotGeo = new THREE.CircleGeometry(0.022, 16);
    for (const x of xs) {
      const dot = new THREE.Mesh(dotGeo, inlay);
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(x, y, -0.9);
      this.scene.add(dot);
    }
  }

  // The gutters: a recessed channel along each side of the bed (REQ-031). Dark
  // steel troughs, in keeping with the industrial palette. The shared geometry
  // (gutterBoxes) is the same set of boxes the colliders use.
  private buildGutters(): void {
    const mat = this.surfaceMaterial(MATERIALS.blackenedSteel);
    for (const box of gutterBoxes()) {
      this.scene.add(this.boxMesh(box, mat));
    }
  }

  // The back pit behind the pin deck (followup F-004): a recessed catch with a
  // back wall and side walls so a ball clearing the rack comes to rest.
  private buildPit(): void {
    const mat = this.surfaceMaterial(MATERIALS.castIron);
    for (const box of pitBoxes()) {
      this.scene.add(this.boxMesh(box, mat));
    }
  }

  private buildGutterColliders(): void {
    for (const box of gutterBoxes()) this.addStaticBox(box);
  }

  private buildPitColliders(): void {
    for (const box of pitBoxes()) this.addStaticBox(box);
  }

  // The visible string-pinsetter rig over the pin deck (GDD REQ-040): the frame
  // of beams, the per-pin guide tubes and winding drums on cross-shafts, and the
  // overhead drive unit the cords hang from. Pure set dressing (no colliders);
  // the layout is derived from the rack home spots so the rig sits exactly above
  // the pins the cords already anchor to (TETHER.topY). Materials follow the
  // industrial palette (REQ-041): painted-red frame, blackened-steel drums/tubes
  // and shafts, dark cast-iron drive unit.
  private buildPinsetterRig(): void {
    const rig = pinsetterRigParts(pinRackPositions());

    const frameMat = new THREE.MeshStandardMaterial({
      color: PINSETTER.frameColor,
      roughness: 0.55,
      metalness: 0.45,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: PINSETTER.steelColor,
      roughness: 0.4,
      metalness: 0.7,
    });
    const driveMat = new THREE.MeshStandardMaterial({
      color: PINSETTER.driveColor,
      roughness: 0.6,
      metalness: 0.6,
    });

    for (const beam of rig.beams) this.scene.add(this.rigBeamMesh(beam, frameMat));
    for (const shaft of rig.shafts) this.scene.add(this.rigCylinderMesh(shaft, steelMat));
    for (const drum of rig.drums) this.scene.add(this.rigCylinderMesh(drum, steelMat));
    for (const tube of rig.guideTubes) this.scene.add(this.rigCylinderMesh(tube, steelMat));
    this.scene.add(this.rigBeamMesh(rig.driveUnit, driveMat));
    this.buildMachineAccents(rig.driveUnit);
  }

  // The machine's accent details on the drive unit (GDD 04-look-and-feel,
  // REQ-041: "accent colour comes from the machine, not signage"). An aged-brass
  // trim band runs across the front face of the cast-iron drive housing, and an
  // amber indicator lamp glows on it: the polished-brass glint and the amber
  // indicator the palette calls for, sourced from the machine rather than any
  // sign. The lamp is emissive so it reads as lit against the dim machine room.
  private buildMachineAccents(driveUnit: RigBeam): void {
    const frontZ = driveUnit.center.z + driveUnit.half.z; // toward the camera (+z)

    // Brass trim band: a thin wide bar across the front of the housing.
    const brass = new THREE.Mesh(
      new THREE.BoxGeometry(driveUnit.half.x * 1.6, 0.04, 0.03),
      this.surfaceMaterial(MATERIALS.agedBrass),
    );
    brass.position.set(
      driveUnit.center.x,
      driveUnit.center.y + driveUnit.half.y * 0.4,
      frontZ + 0.015,
    );
    brass.castShadow = true;
    this.scene.add(brass);

    // Amber indicator lamp: a small glowing dome above the brass band.
    const lampMat = this.surfaceMaterial(MATERIALS.amberLamp);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), lampMat);
    lamp.position.set(
      driveUnit.center.x,
      driveUnit.center.y + driveUnit.half.y * 0.7,
      frontZ + 0.02,
    );
    this.scene.add(lamp);
  }

  // The strike victory-routine debris pool (REQ-044). One small cube per bit,
  // pre-built and hidden; a burst un-hides and positions them each frame from
  // the pure sim. Even bits are hot-brass sparks, odd bits dark steel scrap, so
  // the burst reads as the contraption flinging scrap (industrial palette,
  // REQ-041). The sparks are emissive so they glow against the dark venue.
  private buildVictoryDebris(): void {
    const geo = new THREE.BoxGeometry(
      VICTORY.debrisHalfSize * 2,
      VICTORY.debrisHalfSize * 2,
      VICTORY.debrisHalfSize * 2,
    );
    const sparkMat = new THREE.MeshStandardMaterial({
      color: VICTORY.sparkColor,
      emissive: VICTORY.sparkColor,
      emissiveIntensity: 0.9,
      roughness: 0.4,
      metalness: 0.6,
    });
    const scrapMat = new THREE.MeshStandardMaterial({
      color: VICTORY.scrapColor,
      roughness: 0.5,
      metalness: 0.8,
    });
    for (let i = 0; i < VICTORY.debrisCount; i += 1) {
      const mesh = new THREE.Mesh(geo, i % 2 === 0 ? sparkMat : scrapMat);
      mesh.castShadow = true;
      mesh.visible = false;
      this.debrisMeshes.push(mesh);
      this.scene.add(mesh);
    }
  }

  // Mirror the live debris states onto the pool and (un)hide unused meshes.
  // Called every frame with the routine's current debris (empty when idle, so
  // every mesh hides once the burst ends).
  syncVictoryDebris(debris: readonly Debris[]): void {
    for (let i = 0; i < this.debrisMeshes.length; i += 1) {
      const mesh = this.debrisMeshes[i];
      const bit = debris[i];
      if (!bit) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(bit.position.x, bit.position.y, bit.position.z);
      mesh.rotation.set(bit.rotation.x, bit.rotation.y, bit.rotation.z);
    }
  }

  // A shadow-casting box mesh from a RigBeam (centre + half-extents).
  private rigBeamMesh(beam: RigBeam, mat: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(beam.half.x * 2, beam.half.y * 2, beam.half.z * 2),
      mat,
    );
    mesh.position.set(beam.center.x, beam.center.y, beam.center.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // A cylindrical rig part (guide tube, drum, or cross-shaft). Three.js cylinders
  // stand on +y by default; an 'x' axis part is rotated a quarter turn about z to
  // lie across the lane.
  private rigCylinderMesh(part: RigCylinder, mat: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(part.radius, part.radius, part.length, 16),
      mat,
    );
    mesh.position.set(part.center.x, part.center.y, part.center.z);
    if (part.axis === 'x') mesh.rotation.z = Math.PI / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // Build a Three.js standard material from a palette entry (REQ-041). Emissive
  // lamps carry their glow; plain surfaces leave emissive at the default black.
  private surfaceMaterial(spec: SurfaceMaterial): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: spec.roughness,
      metalness: spec.metalness,
    });
    if (spec.emissive !== undefined) {
      mat.emissive = new THREE.Color(spec.emissive);
      mat.emissiveIntensity = spec.emissiveIntensity ?? 1;
    }
    return mat;
  }

  // A shadow-receiving box mesh from a shared Box (centre + half-extents).
  private boxMesh(box: Box, mat: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(box.half.x * 2, box.half.y * 2, box.half.z * 2),
      mat,
    );
    mesh.position.set(box.center.x, box.center.y, box.center.z);
    mesh.receiveShadow = true;
    return mesh;
  }

  // A fixed cuboid collider from a shared Box (centre + half-extents).
  private addStaticBox(box: Box): void {
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(box.center.x, box.center.y, box.center.z),
    );
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(box.half.x, box.half.y, box.half.z),
      body,
    );
  }

  // The pin deck sits behind the lane bed, since the lane length runs only to
  // the head spot while the triangle's back rows recede further down-lane. A
  // small forward overlap keeps the head pin off the bed/deck seam. Its top is
  // coplanar with the lane bed at floorY.
  private buildPinDeck(): void {
    const geo = new THREE.BoxGeometry(LANE.width, 0.1, this.deckSpan.length);
    const mat = this.surfaceMaterial(MATERIALS.brushedSteel);
    const deck = new THREE.Mesh(geo, mat);
    deck.position.set(0, LANE.floorY - 0.05, this.deckSpan.centerZ);
    deck.receiveShadow = true;
    this.scene.add(deck);
  }

  private get deckSpan(): { centerZ: number; length: number } {
    const frontZ = LANE.headSpot.z + 0.15;
    const backZ = LANE.headSpot.z - LANE.pinDeckDepth;
    return { centerZ: (frontZ + backZ) / 2, length: frontZ - backZ };
  }

  private buildPinDeckCollider(): void {
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, this.deckSpan.centerZ),
    );
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, this.deckSpan.length / 2),
      body,
    );
  }

  private buildLaneCollider(): void {
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, LANE.floorY - 0.05, -LANE.length / 2),
    );
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(LANE.width / 2, 0.05, LANE.length / 2),
      body,
    );
  }

  // Advance physics by real elapsed time using a fixed timestep accumulator.
  step(dt: number): void {
    this.accumulator += Math.min(dt, FIXED_STEP * MAX_STEPS_PER_FRAME);
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.physics.step();
      this.accumulator -= FIXED_STEP;
      steps += 1;
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  handleResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.renderer.dispose();
    this.physics.free();
  }
}

// Await once at boot: initialises the Rapier WASM, then builds the world.
export async function createWorld3D(canvas: HTMLCanvasElement): Promise<World3D> {
  await RAPIER.init();
  return new World3D(canvas);
}
