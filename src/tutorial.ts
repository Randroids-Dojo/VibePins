// First-run control tutorial (GDD 06-reuse-and-tech#shell, GDD 08-controls,
// REQ-047). VibePins' three-step throw (line up, spin, power) is precise but not
// self-evident on shot one, so a brand-new player gets a minimal coach the first
// time they play. Per design pillar 4 and the reuse manifest, this stays minimal:
// one short hint per step, advancing as the player confirms each step, gone after
// the first throw. No wall of text, no canvas overlay (the shell is DOM-driven;
// Hoops' canvas tutorial does not port).
//
// Pure: this module is just the state machine and the per-step copy. It holds no
// DOM, no clock, and no storage. The shell (src/main.ts) drives it from the same
// confirm flow that runs the throw, reads the current hint, and renders/hides the
// DOM coach panel. The seen flag is persisted by Settings (src/settings.ts), so
// this class is told whether to arm on construction and reports when the player
// has finished the first throw so the caller can persist it. Keeping it pure
// means the step sequence and copy are unit-testable without a browser.

// The three throw steps the coach walks through, in order. Each maps one-to-one
// to a confirm in the aiming phase: lock the line, stop the spin meter, stop the
// power meter (which releases the ball).
export type TutorialStep = 'lineup' | 'spin' | 'power';

const STEPS: readonly TutorialStep[] = ['lineup', 'spin', 'power'] as const;

export interface TutorialHint {
  step: TutorialStep;
  // 1-based position for a readable "Step N of 3" label.
  index: number;
  total: number;
  // Short label and instruction shown in the coach panel. Kept to one line each
  // so the panel never becomes a wall of text (pillar 4).
  label: string;
  instruction: string;
}

const HINTS: Record<TutorialStep, { label: string; instruction: string }> = {
  lineup: {
    label: 'Line up',
    instruction: 'Left / right to aim, then confirm to lock your line.',
  },
  spin: {
    label: 'Spin',
    instruction: 'Confirm to stop the spin meter. Center is straight, sides curve.',
  },
  power: {
    label: 'Power',
    instruction: 'Confirm to stop the power meter and throw.',
  },
};

export class Tutorial {
  // True while the coach should be shown and advanced. Off once the first throw
  // finishes (this session) or if the player has already seen it (prior session).
  private armed: boolean;
  // Index into STEPS of the step currently being coached.
  private stepIndex = 0;

  // seen: whether the player has already completed the tutorial in a prior
  // session (from persisted settings). When true the coach never arms.
  constructor(seen: boolean) {
    this.armed = !seen;
  }

  get active(): boolean {
    return this.armed;
  }

  get step(): TutorialStep {
    return STEPS[this.stepIndex];
  }

  // Arm the coach for a fresh game and reset to the first step. No-op once the
  // player has finished the tutorial, so replaying a game after learning the
  // controls does not bring the coach back.
  begin(): void {
    if (!this.armed) return;
    this.stepIndex = 0;
  }

  // Re-arm the coach from the start, regardless of prior completion. Used when
  // the player explicitly asks to replay the tutorial from the menu.
  replay(): void {
    this.armed = true;
    this.stepIndex = 0;
  }

  // Advance to the next step after the player confirms the current one. Returns
  // true if this confirm completed the final step (the throw), which the caller
  // uses to retire and persist the tutorial. No-op (returns false) when inactive.
  advance(): boolean {
    if (!this.armed) return false;
    if (this.stepIndex >= STEPS.length - 1) {
      this.armed = false;
      return true;
    }
    this.stepIndex += 1;
    return false;
  }

  // The hint for the current step, or null when the coach is not active so the
  // caller can hide the panel.
  hint(): TutorialHint | null {
    if (!this.armed) return null;
    const step = this.step;
    const copy = HINTS[step];
    return {
      step,
      index: this.stepIndex + 1,
      total: STEPS.length,
      label: copy.label,
      instruction: copy.instruction,
    };
  }
}
