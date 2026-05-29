// Pin standing/fallen detection (GDD 03-string-pinsetter, REQ-016, REQ-017,
// REQ-022). A pin counts as standing only if it is upright within tolerance AND
// at rest AND still on the deck footprint; otherwise it is fallen. A settle
// window waits for the whole rack to stop moving before counting, so a pin
// caught mid-tumble is never miscounted.
//
// This module is pure: no Three.js, no Rapier. It takes plain kinematics
// snapshots so it is fully unit testable. PinSet.pinStates() produces the
// snapshots from the physics bodies; the classifier decides what "standing"
// means and the SettleWindow decides when to evaluate it.

import type { PinSet } from './pins.js';

export interface PinKinematics {
  readonly position: { x: number; y: number; z: number };
  readonly rotation: { x: number; y: number; z: number; w: number };
  readonly linSpeed: number;
  readonly angSpeed: number;
}

export interface DeckFootprint {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly maxCenterY: number;
}

export interface StandingThresholds {
  readonly standingUpAxisThreshold: number;
  readonly atRestLinSpeed: number;
  readonly atRestAngSpeed: number;
  readonly deckFootprint: DeckFootprint;
}

export interface PinState {
  readonly pinIndex: number;
  readonly standing: boolean;
}

export interface SettleResult {
  readonly settled: boolean;
  readonly timedOut: boolean;
  readonly pins: PinState[];
  readonly standingCount: number;
  readonly fallenCount: number;
}

// Y component of the body's local up-axis after rotation. 1 upright, -1 inverted.
// Matches the formula used in PinSet.sync and the physics smokes.
export function getUpAxisY(rotation: { x: number; z: number }): number {
  return 1 - 2 * (rotation.x * rotation.x + rotation.z * rotation.z);
}

// Is the pin centre within the deck footprint (in x,z and not lifted above it)?
export function isOnDeck(position: { x: number; y: number; z: number }, footprint: DeckFootprint): boolean {
  return (
    position.x >= footprint.minX &&
    position.x <= footprint.maxX &&
    position.z >= footprint.minZ &&
    position.z <= footprint.maxZ &&
    position.y <= footprint.maxCenterY
  );
}

// The standing predicate (REQ-016, REQ-022): upright AND at rest AND on deck.
// A hanging pin is lifted above maxCenterY (or off the footprint), so it fails
// isOnDeck and reads fallen with no special case.
export function classifyPinStanding(state: PinKinematics, thresholds: StandingThresholds): boolean {
  const upright = getUpAxisY(state.rotation) >= thresholds.standingUpAxisThreshold;
  return upright && atRest(state, thresholds) && isOnDeck(state.position, thresholds.deckFootprint);
}

export function classifyRack(states: readonly PinKinematics[], thresholds: StandingThresholds): PinState[] {
  return states.map((state, pinIndex) => ({ pinIndex, standing: classifyPinStanding(state, thresholds) }));
}

// At rest when both speeds are at or below their thresholds. Inclusive, to
// match the inclusive (>=) upright check; the threshold is the resting ceiling.
function atRest(state: PinKinematics, thresholds: StandingThresholds): boolean {
  return state.linSpeed <= thresholds.atRestLinSpeed && state.angSpeed <= thresholds.atRestAngSpeed;
}

function summarize(pins: PinState[], timedOut: boolean): SettleResult {
  const standingCount = pins.filter((p) => p.standing).length;
  return { settled: true, timedOut, pins, standingCount, fallenCount: pins.length - standingCount };
}

const PENDING: SettleResult = { settled: false, timedOut: false, pins: [], standingCount: 0, fallenCount: 0 };

// Frame-counting state machine that defers classification until the whole rack
// holds rest for atRestFrames, or resolves at maxFrames as a hard timeout
// (REQ-017). Drive step() once per fixed physics step. Pure: no clock, no Rapier.
export class SettleWindow {
  private elapsed = 0;
  private restRun = 0;
  private latched: SettleResult | null = null;

  constructor(
    private readonly thresholds: StandingThresholds,
    private readonly atRestFrames: number,
    private readonly maxFrames: number,
  ) {}

  // Begin a fresh settle (call when a new ball is thrown).
  reset(): void {
    this.elapsed = 0;
    this.restRun = 0;
    this.latched = null;
  }

  step(states: readonly PinKinematics[]): SettleResult {
    if (this.latched) return this.latched;

    this.elapsed += 1;
    const rackAtRest = states.every((state) => atRest(state, this.thresholds));
    this.restRun = rackAtRest ? this.restRun + 1 : 0;

    const sustained = this.restRun >= this.atRestFrames;
    const timedOut = this.elapsed >= this.maxFrames;
    if (sustained || timedOut) {
      this.latched = summarize(classifyRack(states, this.thresholds), timedOut && !sustained);
      return this.latched;
    }
    return PENDING;
  }
}

// Instantaneous snapshot classification of a live rack. NOTE: this reads the
// rack at one instant; use SettleWindow as the authoritative gate during play,
// since a fast-spinning pin can momentarily look upright and on deck.
export function detectPins(pinSet: PinSet, thresholds: StandingThresholds): PinState[] {
  return classifyRack(pinSet.pinStates(), thresholds);
}
