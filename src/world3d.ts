// Owns the Three.js renderer/scene/camera and the Rapier physics world.
// Modeled on the sibling project Hoops' World3D, adapted to Rapier (GDD
// 06-reuse-and-tech, "Scene and physics scaffolding").
//
// Rapier's `-compat` build initialises its WASM asynchronously, so this module
// exposes an async `createWorld3D` factory: callers await it once at boot, and
// the constructed World3D is fully synchronous thereafter (no per-frame cost).

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE, SHOT_CAMERA } from './config.js';

const FIXED_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly physics: RAPIER.World;

  private accumulator = 0;
  private readonly resizeHandler = () => this.handleResize();

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
    this.buildBallReturn();
    this.buildPinDeck();

    // Physics world. Gravity straight down; a fixed bed collider gives the
    // ball and pins something to rest on in later slices.
    this.physics = new RAPIER.World({ x: 0, y: LANE.gravity, z: 0 });
    this.physics.timestep = FIXED_STEP;
    this.buildLaneCollider();
    this.buildPinDeckCollider();

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
    const mat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.5, metalness: 0.1 });
    const bed = new THREE.Mesh(geo, mat);
    bed.position.set(0, LANE.floorY - 0.05, -LANE.length / 2);
    bed.receiveShadow = true;
    this.scene.add(bed);
  }

  // The approach floor behind the foul line (toward the camera), where the
  // bowler stands and the ball return sits. Slightly wider than the lane.
  private buildApproach(): void {
    const geo = new THREE.BoxGeometry(LANE.width + 0.6, 0.1, LANE.approachDepth);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.8, metalness: 0.05 });
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
      new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.5 }),
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
    const inlay = new THREE.MeshStandardMaterial({ color: 0x241607, roughness: 0.7, metalness: 0.05 });

    // Foul line across the lane at z = 0.
    const foul = new THREE.Mesh(
      new THREE.BoxGeometry(LANE.width, 0.012, 0.04),
      new THREE.MeshStandardMaterial({ color: 0x140d06, roughness: 0.85 }),
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

  // The pin deck sits behind the lane bed, since the lane length runs only to
  // the head spot while the triangle's back rows recede further down-lane. A
  // small forward overlap keeps the head pin off the bed/deck seam. Its top is
  // coplanar with the lane bed at floorY.
  private buildPinDeck(): void {
    const geo = new THREE.BoxGeometry(LANE.width, 0.1, this.deckSpan.length);
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.4 });
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
