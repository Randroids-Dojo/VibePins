// Owns the Three.js renderer/scene/camera and the Rapier physics world.
// Modeled on the sibling project Hoops' World3D, adapted to Rapier (GDD
// 06-reuse-and-tech, "Scene and physics scaffolding").
//
// Rapier's `-compat` build initialises its WASM asynchronously, so this module
// exposes an async `createWorld3D` factory: callers await it once at boot, and
// the constructed World3D is fully synchronous thereafter (no per-frame cost).

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LANE } from './config.js';

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

    // Scene: dark venue with fog for depth (GDD 04-look-and-feel).
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.Fog(0x05060a, 8, LANE.length * 1.4);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    this.camera.position.set(LANE.cameraPos.x, LANE.cameraPos.y, LANE.cameraPos.z);
    this.camera.lookAt(LANE.cameraLookAt.x, LANE.cameraLookAt.y, LANE.cameraLookAt.z);

    this.buildLighting();
    this.buildLane();
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
    this.scene.add(new THREE.AmbientLight(0xb89a78, 0.45));

    // Warm industrial work-light overhead (GDD 04-look-and-feel palette).
    const key = new THREE.DirectionalLight(0xffe8c4, 1.1);
    key.position.set(1.5, 8, 2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 30;
    this.scene.add(key);
  }

  private buildLane(): void {
    const geo = new THREE.BoxGeometry(LANE.width, 0.1, LANE.length);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.5, metalness: 0.1 });
    const bed = new THREE.Mesh(geo, mat);
    bed.position.set(0, LANE.floorY - 0.05, -LANE.length / 2);
    bed.receiveShadow = true;
    this.scene.add(bed);
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
