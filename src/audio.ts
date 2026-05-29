// Procedural Web Audio engine for VibePins (GDD 04-look-and-feel, audio; REQ-043).
// Ported in spirit from Hoops' AudioEngine: it synthesizes every sound from
// oscillators and noise buffers rather than shipping audio files, lazily creates
// the AudioContext on the first user gesture, resumes a suspended context, and
// respects a global enable toggle wired to the persisted audio setting (REQ-046).
//
// The palette is mechanical, not musical-arcade: the dull woody knock of squat
// duckpins, a wood rumble and release thunk for the ball, the signature
// string-reset servo whir, and small mechanical flourishes for spares and the
// rare strike. The Web Audio API is built into the browser, so this adds no
// dependency.
//
// Testability: the context is created through an injectable factory, so a
// headless test can pass a fake AudioContext and assert that enabled/suspended
// state gates whether sound nodes get built, without a real browser.

// The slice of the Web Audio API this engine actually uses. Declaring it locally
// keeps the engine testable with a minimal fake and avoids depending on the DOM
// lib's full AudioContext surface.
export interface AudioCtxLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNode;
  state: AudioContextState;
  resume(): Promise<void>;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
  createBiquadFilter(): BiquadFilterNode;
  createBufferSource(): AudioBufferSourceNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
}

// Factory that mints a context, or null when Web Audio is unavailable. The
// default reads the standard (or webkit-prefixed) constructor off window.
export type AudioCtxFactory = () => AudioCtxLike | null;

function defaultFactory(): AudioCtxLike | null {
  try {
    const w = window as unknown as {
      AudioContext?: new () => AudioContext;
      webkitAudioContext?: new () => AudioContext;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    return new Ctor() as unknown as AudioCtxLike;
  } catch {
    return null;
  }
}

export class AudioEngine {
  private ctx: AudioCtxLike | null = null;
  private initialized = false;
  private enabled: boolean;
  private readonly factory: AudioCtxFactory;

  // Start enabled by default so the first gesture can make sound; callers pass
  // the persisted setting so a muted player stays muted across reloads.
  constructor(enabled = true, factory: AudioCtxFactory = defaultFactory) {
    this.enabled = enabled;
    this.factory = factory;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  // Whether a context exists yet. Mostly for tests and diagnostics.
  get isInitialized(): boolean {
    return this.initialized;
  }

  // Create the context on first call. Browsers block audio until a user gesture,
  // so this is invoked from the first click/key, not at construction.
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.ctx = this.factory();
    if (!this.ctx) {
      // No Web Audio (old browser, blocked context): the engine stays silent but
      // every play* call remains a safe no-op.
      this.enabled = false;
    }
  }

  // Browsers suspend the context until a gesture and re-suspend on tab hide. Call
  // this from the same gesture handlers that drive the game so sound stays alive.
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      // resume() returns a promise; we do not await it. A rejection (no gesture
      // yet) is harmless: the next gesture tries again.
      void this.ctx.resume().catch(() => {});
    }
  }

  // Flip the global enable flag and report the new value, so a caller can update
  // a toggle's label and aria-pressed in one step (mirrors Settings.toggleAudio).
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  // True only when sound can actually be produced right now.
  private get live(): boolean {
    return this.enabled && this.ctx !== null;
  }

  // A short filtered noise burst: the shared body of clatter and rumble sounds.
  private noiseBurst(
    duration: number,
    filterType: BiquadFilterType,
    filterFreq: number,
    peakGain: number,
    startAt = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime + startAt;
    const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      // Fade the noise out over its length so each grain decays rather than clicks off.
      data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peakGain, now);
    gain.gain.linearRampToValueAtTime(0, now + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start(now);
    source.stop(now + duration);
  }

  // A short decaying tone: the shared body of mechanical clicks, twangs, and bells.
  private tone(
    type: OscillatorType,
    startFreq: number,
    endFreq: number,
    duration: number,
    peakGain: number,
    startAt = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime + startAt;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, now);
    if (endFreq !== startFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), now + duration);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peakGain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration);
  }

  // Pin clatter: the dull, woody knock of squat duckpins (low energy, less
  // scatter than tenpins). A low-passed noise thud under a couple of muted woody
  // taps. Scales loudness with how many pins fell so a single tap is quiet and a
  // big count is a satisfying knock.
  playPinClatter(pinsDowned = 1): void {
    if (!this.live) return;
    const count = Math.max(1, Math.min(10, pinsDowned));
    const intensity = 0.12 + (count / 10) * 0.18;
    this.noiseBurst(0.18, 'lowpass', 320, intensity);
    // A few short woody taps, more taps for a bigger count.
    const taps = Math.min(4, 1 + Math.floor(count / 3));
    for (let i = 0; i < taps; i++) {
      this.tone('triangle', 180 - i * 12, 90, 0.09, 0.1, 0.01 + i * 0.025);
    }
  }

  // Ball roll: a short rumble down the wood as the ball is launched.
  playBallRoll(): void {
    if (!this.live) return;
    this.noiseBurst(0.5, 'lowpass', 180, 0.12);
  }

  // Release thunk: the ball leaving the hand and meeting the lane on launch.
  playBallThunk(): void {
    if (!this.live) return;
    this.noiseBurst(0.12, 'lowpass', 140, 0.22);
    this.tone('sine', 110, 60, 0.14, 0.18);
  }

  // String reset: the signature sound bed. A servo whir (rising sawtooth under a
  // bandpassed noise), a taut-cord twang, clicking relays, and the rack thunking
  // home. This is the machine's voice; it plays while the pinsetter reels pins up.
  playStringReset(): void {
    if (!this.live) return;
    // Servo whir: a rising filtered tone plus motor noise.
    this.tone('sawtooth', 90, 220, 0.55, 0.08);
    this.noiseBurst(0.55, 'bandpass', 900, 0.06);
    // Taut-cord twang partway through the lift.
    this.tone('triangle', 320, 180, 0.18, 0.09, 0.25);
    // A couple of relay clicks.
    this.tone('square', 1100, 1100, 0.03, 0.07, 0.15);
    this.tone('square', 1100, 1100, 0.03, 0.07, 0.4);
    // The rack thunks home at the end.
    this.noiseBurst(0.12, 'lowpass', 200, 0.18, 0.5);
  }

  // Strike sting: a satisfying mechanical flourish on the rare strike. A short
  // ratchet run into a pair of brassy bells with a steam-hiss tail.
  playStrike(): void {
    if (!this.live) return;
    // Ratchet run: quick rising clicks.
    for (let i = 0; i < 5; i++) {
      this.tone('square', 700 + i * 120, 700 + i * 120, 0.025, 0.06, i * 0.04);
    }
    // Brassy bells (a bright mechanical chord, not an arcade jingle).
    [523.25, 783.99].forEach((freq) => {
      this.tone('triangle', freq, freq * 0.98, 0.6, 0.16, 0.22);
    });
    // Steam-hiss tail.
    this.noiseBurst(0.4, 'highpass', 4000, 0.05, 0.25);
  }

  // Spare flourish: a smaller mechanical cue than the strike. A single bell over
  // a short relay click.
  playSpare(): void {
    if (!this.live) return;
    this.tone('square', 900, 900, 0.03, 0.06);
    this.tone('triangle', 587.33, 575, 0.4, 0.13, 0.05);
  }

  // UI click: a crisp relay-style click for menu buttons and meter stops.
  playClick(): void {
    if (!this.live) return;
    this.tone('square', 1000, 1000, 0.05, 0.08);
  }
}
