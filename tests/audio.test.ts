import { describe, it, expect } from 'vitest';
import { AudioEngine, type AudioCtxLike } from '../src/audio.js';

// A fake AudioContext that records how many sound nodes were created and started,
// so a headless test can assert that an engine produces (or suppresses) sound
// without a real browser. Every created node is a no-op stub whose methods just
// return so the engine's synthesis code runs end to end.

interface FakeCtx extends AudioCtxLike {
  started: number; // oscillators + buffer sources started
  connected: number; // nodes connected into the graph
  resumeCalls: number;
}

function makeParam() {
  return {
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  };
}

function fakeContext(state: AudioContextState = 'running'): FakeCtx {
  const ctx = {
    currentTime: 0,
    sampleRate: 44100,
    destination: {} as AudioNode,
    state,
    started: 0,
    connected: 0,
    resumeCalls: 0,
    async resume() {
      ctx.resumeCalls++;
      ctx.state = 'running';
    },
    createOscillator() {
      return {
        type: 'sine',
        frequency: makeParam(),
        connect: () => {
          ctx.connected++;
        },
        start: () => {
          ctx.started++;
        },
        stop() {},
      } as unknown as OscillatorNode;
    },
    createGain() {
      return {
        gain: makeParam(),
        connect: () => {
          ctx.connected++;
        },
      } as unknown as GainNode;
    },
    createBiquadFilter() {
      return {
        type: 'lowpass',
        frequency: makeParam(),
        Q: makeParam(),
        connect: () => {
          ctx.connected++;
        },
      } as unknown as BiquadFilterNode;
    },
    createBufferSource() {
      return {
        buffer: null,
        connect: () => {
          ctx.connected++;
        },
        start: () => {
          ctx.started++;
        },
        stop() {},
      } as unknown as AudioBufferSourceNode;
    },
    createBuffer(_channels: number, length: number) {
      const data = new Float32Array(length);
      return { getChannelData: () => data } as unknown as AudioBuffer;
    },
  };
  return ctx as unknown as FakeCtx;
}

// Build an engine wired to a fresh fake context, returning both so a test can
// inspect node counts. Defaults to initialized so play* calls can run.
function makeEngine(opts: { enabled?: boolean; state?: AudioContextState; init?: boolean } = {}) {
  const ctx = fakeContext(opts.state);
  const engine = new AudioEngine(opts.enabled ?? true, () => ctx);
  if (opts.init !== false) engine.init();
  return { engine, ctx };
}

const SOUNDS: Array<(e: AudioEngine) => void> = [
  (e) => e.playPinClatter(7),
  (e) => e.playBallRoll(),
  (e) => e.playBallThunk(),
  (e) => e.playStringReset(),
  (e) => e.playStrike(),
  (e) => e.playSpare(),
  (e) => e.playClick(),
];

describe('AudioEngine: procedural mechanical sound engine (REQ-043)', () => {
  it('does not create a context at construction (lazy init on first gesture)', () => {
    let calls = 0;
    const engine = new AudioEngine(true, () => {
      calls++;
      return fakeContext();
    });
    expect(calls).toBe(0);
    expect(engine.isInitialized).toBe(false);
    engine.init();
    expect(calls).toBe(1);
    expect(engine.isInitialized).toBe(true);
  });

  it('init is idempotent: a second call does not mint another context', () => {
    let calls = 0;
    const engine = new AudioEngine(true, () => {
      calls++;
      return fakeContext();
    });
    engine.init();
    engine.init();
    expect(calls).toBe(1);
  });

  it('every sound builds and starts nodes connected to the destination when live', () => {
    for (const play of SOUNDS) {
      const { engine, ctx } = makeEngine();
      play(engine);
      expect(ctx.started).toBeGreaterThan(0);
      expect(ctx.connected).toBeGreaterThan(0);
    }
  });

  it('produces no sound when disabled', () => {
    for (const play of SOUNDS) {
      const { engine, ctx } = makeEngine({ enabled: false });
      play(engine);
      expect(ctx.started).toBe(0);
    }
  });

  it('produces no sound before init (no context yet)', () => {
    const { engine, ctx } = makeEngine({ init: false });
    engine.playPinClatter(10);
    expect(ctx.started).toBe(0);
  });

  it('setEnabled gates sound at runtime', () => {
    const { engine, ctx } = makeEngine({ enabled: true });
    engine.setEnabled(false);
    expect(engine.isEnabled).toBe(false);
    engine.playStrike();
    expect(ctx.started).toBe(0);
    engine.setEnabled(true);
    engine.playStrike();
    expect(ctx.started).toBeGreaterThan(0);
  });

  it('starting disabled stays silent until enabled', () => {
    const { engine, ctx } = makeEngine({ enabled: false });
    engine.playBallRoll();
    expect(ctx.started).toBe(0);
    engine.setEnabled(true);
    engine.playBallRoll();
    expect(ctx.started).toBeGreaterThan(0);
  });

  it('resume() resumes a suspended context and is a no-op when running', () => {
    const { engine, ctx } = makeEngine({ state: 'suspended' });
    engine.resume();
    expect(ctx.resumeCalls).toBe(1);
    // Now running: resume should not call again.
    engine.resume();
    expect(ctx.resumeCalls).toBe(1);
  });

  it('disables itself and stays a safe no-op when Web Audio is unavailable', () => {
    const engine = new AudioEngine(true, () => null);
    engine.init();
    expect(engine.isInitialized).toBe(true);
    expect(engine.isEnabled).toBe(false);
    // Must not throw even with no context.
    expect(() => {
      engine.resume();
      engine.playStrike();
      engine.playPinClatter(10);
    }).not.toThrow();
  });

  it('louder clatter for a bigger pin count creates more nodes', () => {
    const small = makeEngine();
    small.engine.playPinClatter(1);
    const big = makeEngine();
    big.engine.playPinClatter(10);
    // More taps stack for a bigger count, so more nodes start.
    expect(big.ctx.started).toBeGreaterThan(small.ctx.started);
  });
});
