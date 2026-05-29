// Persisted player settings (GDD 06-reuse-and-tech, REQ-046). Values survive
// reloads via localStorage. The shape mirrors Hoops' settings module, but
// VibePins does not yet depend on VibeKit, so this uses localStorage directly
// rather than VibeKit's readStorage/writeStorage. Audio enable is the first
// (and currently only) setting: the look-and-feel audio engine (REQ-043) reads
// it when it lands.
//
// Pure-ish: the store reads/writes localStorage on construction and on every
// mutation, but it tolerates a missing or throwing storage (private-mode
// browsers, server-side, tests) by falling back to the in-memory defaults. That
// keeps the rest of the shell from having to know whether persistence worked.

const STORAGE_KEY = 'vibepins-settings-v1';

export interface SettingsState {
  // Whether the procedural audio engine is allowed to make sound. Defaults on;
  // the player can mute from the menu. Persisted across sessions.
  audioEnabled: boolean;
}

const DEFAULTS: SettingsState = {
  audioEnabled: true,
};

// A minimal storage port so the store works without a real localStorage (tests,
// SSR, private mode). The browser's localStorage satisfies this shape.
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Parse a persisted blob into a settings state, ignoring anything malformed and
// filling gaps from the defaults. Unknown keys are dropped so an old or hand-
// edited payload cannot inject surprise fields.
function parse(raw: string | null): SettingsState {
  if (!raw) return { ...DEFAULTS };
  try {
    const data = JSON.parse(raw) as Partial<Record<keyof SettingsState, unknown>>;
    return {
      audioEnabled: typeof data.audioEnabled === 'boolean' ? data.audioEnabled : DEFAULTS.audioEnabled,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// Resolve a usable storage: the provided one, else the browser's localStorage,
// else null (so the store runs purely in memory).
function resolveStorage(provided?: StorageLike): StorageLike | null {
  if (provided) return provided;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Accessing localStorage can throw in sandboxed iframes; fall through.
  }
  return null;
}

export class Settings {
  private readonly storage: StorageLike | null;
  private state: SettingsState;

  constructor(storage?: StorageLike) {
    this.storage = resolveStorage(storage);
    this.state = this.load();
  }

  get audioEnabled(): boolean {
    return this.state.audioEnabled;
  }

  // Flip the audio-enable flag, persist, and return the new value so a caller can
  // update a toggle's label/aria-pressed in one step.
  toggleAudio(): boolean {
    this.state = { ...this.state, audioEnabled: !this.state.audioEnabled };
    this.save();
    return this.state.audioEnabled;
  }

  // Set the audio-enable flag explicitly and persist.
  setAudioEnabled(enabled: boolean): void {
    this.state = { ...this.state, audioEnabled: enabled };
    this.save();
  }

  private load(): SettingsState {
    if (!this.storage) return { ...DEFAULTS };
    try {
      return parse(this.storage.getItem(STORAGE_KEY));
    } catch {
      return { ...DEFAULTS };
    }
  }

  private save(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // A full or read-only storage must not break gameplay; the value stays in
      // memory for this session.
    }
  }
}
