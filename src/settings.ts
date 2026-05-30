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

// The per-device credential bound to one seat of one match (GDD 05 identity,
// REQ-052). The secret authorizes that seat's submissions; it must persist so a
// player who closes the tab and reopens the match resumes the same seat without
// re-claiming. Keyed by match id in the settings store.
export interface MatchCredential {
  // 1-based seat this device owns in the match.
  seat: number;
  // The per-seat secret minted by the server on create/join. Authorizes PATCH
  // submissions for this seat (sent via the X-Match-Secret header).
  secret: string;
  // The display name this device claimed the seat under, echoed by the server.
  name: string;
}

export interface SettingsState {
  // Whether the procedural audio engine is allowed to make sound. Defaults on;
  // the player can mute from the menu. Persisted across sessions.
  audioEnabled: boolean;
  // Whether the camera chases the ball down the lane during the watching phase
  // (REQ-033 follow-cam polish). Defaults off so the standard fixed bowler view
  // is the baseline; the player opts in from the menu. Only affects the watching
  // phase: aiming/spin/power and the settle/reset beat keep the normal pose.
  ballCam: boolean;
  // Whether the player has seen the first-run control tutorial (REQ-047).
  // Defaults false so a brand-new player gets the coach on their first game;
  // set true after the first throw so it never nags again. Replayable from the
  // menu, which clears it back to false.
  tutorialSeen: boolean;
  // The display name the player submits scores under (REQ-057). Persisted so the
  // name entry on the summary screen pre-fills with the last name used. Empty
  // until the player first types one.
  playerName: string;
  // Per-match seat credentials (REQ-052), keyed by match id, so reopening a
  // match on the same device resumes the same seat. Pruned only by the store's
  // own writes; the server's week-long TTL bounds how long any entry stays live.
  matchCredentials: Record<string, MatchCredential>;
  // Match ids whose completed line this device has already posted to the global
  // leaderboard (REQ-058). Persisted so re-opening a finished match (which the
  // complete view does on every refresh) cannot double-post the same line.
  matchPostedToBoard: string[];
}

const DEFAULTS: SettingsState = {
  audioEnabled: true,
  ballCam: false,
  tutorialSeen: false,
  playerName: '',
  matchCredentials: {},
  matchPostedToBoard: [],
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
      ballCam: typeof data.ballCam === 'boolean' ? data.ballCam : DEFAULTS.ballCam,
      tutorialSeen: typeof data.tutorialSeen === 'boolean' ? data.tutorialSeen : DEFAULTS.tutorialSeen,
      playerName: typeof data.playerName === 'string' ? data.playerName : DEFAULTS.playerName,
      matchCredentials: parseMatchCredentials(data.matchCredentials),
      matchPostedToBoard: parseMatchPosted(data.matchPostedToBoard),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// Parse the persisted match-credential map, dropping any entry whose shape does
// not match (a hand-edited or older payload cannot inject malformed seats).
function parseMatchCredentials(raw: unknown): Record<string, MatchCredential> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, MatchCredential> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const cred = value as Partial<MatchCredential>;
    if (typeof cred.seat === 'number' && typeof cred.secret === 'string' && typeof cred.name === 'string') {
      out[id] = { seat: cred.seat, secret: cred.secret, name: cred.name };
    }
  }
  return out;
}

// Parse the persisted set of match ids whose line this device already posted
// (REQ-058), keeping only non-empty string ids and dropping duplicates so a
// hand-edited payload cannot bloat the guard.
function parseMatchPosted(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id === 'string' && id) seen.add(id);
  }
  return [...seen];
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

  get ballCam(): boolean {
    return this.state.ballCam;
  }

  // Flip the ball-cam flag, persist, and return the new value so a caller can
  // update the toggle's label/aria-pressed in one step (mirrors toggleAudio).
  toggleBallCam(): boolean {
    this.state = { ...this.state, ballCam: !this.state.ballCam };
    this.save();
    return this.state.ballCam;
  }

  // Set the ball-cam flag explicitly and persist.
  setBallCam(enabled: boolean): void {
    this.state = { ...this.state, ballCam: enabled };
    this.save();
  }

  get tutorialSeen(): boolean {
    return this.state.tutorialSeen;
  }

  // Set the tutorial-seen flag explicitly and persist. Called with true after
  // the first throw completes the coach, and with false when the player chooses
  // to replay the tutorial from the menu.
  setTutorialSeen(seen: boolean): void {
    this.state = { ...this.state, tutorialSeen: seen };
    this.save();
  }

  get playerName(): string {
    return this.state.playerName;
  }

  // Set the display name used for leaderboard submissions and persist it so the
  // next summary screen pre-fills with it (REQ-057). The raw input is stored
  // verbatim; the server sanitizes it on submit, and the field is length-capped
  // in the markup, so no extra trimming is needed here.
  setPlayerName(name: string): void {
    this.state = { ...this.state, playerName: name };
    this.save();
  }

  // The credential this device holds for a match, or null when this device has
  // never claimed a seat in it (a fresh recipient opening a handoff link).
  matchCredential(matchId: string): MatchCredential | null {
    return this.state.matchCredentials[matchId] ?? null;
  }

  // Persist the seat credential a create/join handed back, so reopening the
  // match on this device resumes the same seat (REQ-052, REQ-055 resume).
  setMatchCredential(matchId: string, cred: MatchCredential): void {
    this.state = {
      ...this.state,
      matchCredentials: { ...this.state.matchCredentials, [matchId]: cred },
    };
    this.save();
  }

  // Whether this device has already posted its line for a finished match to the
  // global leaderboard (REQ-058). The complete view re-renders on every refresh,
  // so the post path checks this first and skips when true.
  hasPostedMatchToBoard(matchId: string): boolean {
    return this.state.matchPostedToBoard.includes(matchId);
  }

  // Record that this device posted its line for a match, so a later view of the
  // same finished match does not post it again (REQ-058). Idempotent.
  markMatchPostedToBoard(matchId: string): void {
    if (this.state.matchPostedToBoard.includes(matchId)) return;
    this.state = {
      ...this.state,
      matchPostedToBoard: [...this.state.matchPostedToBoard, matchId],
    };
    this.save();
  }

  // Clear the posted flag for a match so a failed post can be retried on the
  // next view (REQ-058). The caller marks before the network round trip to block
  // a synchronous double-post, then unmarks here if the post did not succeed.
  unmarkMatchPostedToBoard(matchId: string): void {
    if (!this.state.matchPostedToBoard.includes(matchId)) return;
    this.state = {
      ...this.state,
      matchPostedToBoard: this.state.matchPostedToBoard.filter((id) => id !== matchId),
    };
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
