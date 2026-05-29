import { describe, it, expect } from 'vitest';
import { Settings, type StorageLike } from '../src/settings.js';

// A fake localStorage so the store can be tested without a browser. It also lets
// a test inject a malformed or pre-seeded payload and assert persistence.
function fakeStorage(seed: Record<string, string> = {}): StorageLike & { store: Record<string, string> } {
  const store: Record<string, string> = { ...seed };
  return {
    store,
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = value;
    },
  };
}

const KEY = 'vibepins-settings-v1';

describe('Settings: persisted audio-enable toggle (REQ-046)', () => {
  it('defaults audio on when storage is empty', () => {
    expect(new Settings(fakeStorage()).audioEnabled).toBe(true);
  });

  it('toggling audio flips the value and reports the new state', () => {
    const settings = new Settings(fakeStorage());
    expect(settings.toggleAudio()).toBe(false);
    expect(settings.audioEnabled).toBe(false);
    expect(settings.toggleAudio()).toBe(true);
    expect(settings.audioEnabled).toBe(true);
  });

  it('persists the toggle to storage', () => {
    const storage = fakeStorage();
    const settings = new Settings(storage);
    settings.toggleAudio();
    expect(storage.store[KEY]).toBe(JSON.stringify({ audioEnabled: false }));
  });

  it('reloads a persisted value across instances (survives a session)', () => {
    const storage = fakeStorage();
    new Settings(storage).setAudioEnabled(false);
    expect(new Settings(storage).audioEnabled).toBe(false);
  });

  it('setAudioEnabled writes the explicit value', () => {
    const settings = new Settings(fakeStorage());
    settings.setAudioEnabled(false);
    expect(settings.audioEnabled).toBe(false);
    settings.setAudioEnabled(true);
    expect(settings.audioEnabled).toBe(true);
  });

  it('falls back to defaults on a malformed payload', () => {
    expect(new Settings(fakeStorage({ [KEY]: 'not json' })).audioEnabled).toBe(true);
  });

  it('ignores a non-boolean audioEnabled and keeps the default', () => {
    const settings = new Settings(fakeStorage({ [KEY]: JSON.stringify({ audioEnabled: 'yes' }) }));
    expect(settings.audioEnabled).toBe(true);
  });

  it('survives a throwing storage by staying in memory', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const settings = new Settings(throwing);
    expect(settings.audioEnabled).toBe(true); // load swallowed the throw
    expect(settings.toggleAudio()).toBe(false); // save swallowed the throw
    expect(settings.audioEnabled).toBe(false);
  });
});
