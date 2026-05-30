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
    expect(storage.store[KEY]).toBe(
      JSON.stringify({ audioEnabled: false, tutorialSeen: false, playerName: '', matchCredentials: {} }),
    );
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

describe('Settings: persisted tutorial-seen flag (REQ-047)', () => {
  it('defaults tutorial unseen so a new player gets the coach', () => {
    expect(new Settings(fakeStorage()).tutorialSeen).toBe(false);
  });

  it('setTutorialSeen writes and reports the explicit value', () => {
    const settings = new Settings(fakeStorage());
    settings.setTutorialSeen(true);
    expect(settings.tutorialSeen).toBe(true);
    settings.setTutorialSeen(false);
    expect(settings.tutorialSeen).toBe(false);
  });

  it('persists the tutorial-seen flag across instances (survives a session)', () => {
    const storage = fakeStorage();
    new Settings(storage).setTutorialSeen(true);
    expect(new Settings(storage).tutorialSeen).toBe(true);
  });

  it('persists tutorial-seen alongside audio in one payload', () => {
    const storage = fakeStorage();
    const settings = new Settings(storage);
    settings.setTutorialSeen(true);
    expect(storage.store[KEY]).toBe(
      JSON.stringify({ audioEnabled: true, tutorialSeen: true, playerName: '', matchCredentials: {} }),
    );
  });

  it('ignores a non-boolean tutorialSeen and keeps the default', () => {
    const settings = new Settings(fakeStorage({ [KEY]: JSON.stringify({ tutorialSeen: 'yes' }) }));
    expect(settings.tutorialSeen).toBe(false);
  });

  it('reads a persisted unseen flag without disturbing audio', () => {
    const settings = new Settings(
      fakeStorage({ [KEY]: JSON.stringify({ audioEnabled: false, tutorialSeen: true }) }),
    );
    expect(settings.audioEnabled).toBe(false);
    expect(settings.tutorialSeen).toBe(true);
  });
});

describe('Settings: persisted leaderboard player name (REQ-057)', () => {
  it('defaults to an empty name for a brand-new player', () => {
    expect(new Settings(fakeStorage()).playerName).toBe('');
  });

  it('setPlayerName writes and reports the value', () => {
    const settings = new Settings(fakeStorage());
    settings.setPlayerName('ACE');
    expect(settings.playerName).toBe('ACE');
  });

  it('persists the player name across instances (survives a session)', () => {
    const storage = fakeStorage();
    new Settings(storage).setPlayerName('PIN PAL');
    expect(new Settings(storage).playerName).toBe('PIN PAL');
  });

  it('ignores a non-string playerName and keeps the default', () => {
    const settings = new Settings(fakeStorage({ [KEY]: JSON.stringify({ playerName: 42 }) }));
    expect(settings.playerName).toBe('');
  });

  it('persists the name alongside the other settings without disturbing them', () => {
    const settings = new Settings(
      fakeStorage({ [KEY]: JSON.stringify({ audioEnabled: false, tutorialSeen: true, playerName: 'BOB' }) }),
    );
    expect(settings.audioEnabled).toBe(false);
    expect(settings.tutorialSeen).toBe(true);
    expect(settings.playerName).toBe('BOB');
  });
});

describe('Settings: persisted per-match seat credentials (REQ-052)', () => {
  it('returns null for a match this device has never claimed a seat in', () => {
    expect(new Settings(fakeStorage()).matchCredential('m1')).toBeNull();
  });

  it('stores and reports a seat credential keyed by match id', () => {
    const settings = new Settings(fakeStorage());
    settings.setMatchCredential('m1', { seat: 2, secret: 'sek', name: 'Bo' });
    expect(settings.matchCredential('m1')).toEqual({ seat: 2, secret: 'sek', name: 'Bo' });
    expect(settings.matchCredential('other')).toBeNull();
  });

  it('persists credentials across instances so reopening resumes the seat', () => {
    const storage = fakeStorage();
    new Settings(storage).setMatchCredential('m1', { seat: 1, secret: 'sek-1', name: 'Ann' });
    expect(new Settings(storage).matchCredential('m1')).toEqual({ seat: 1, secret: 'sek-1', name: 'Ann' });
  });

  it('keeps multiple match credentials side by side', () => {
    const settings = new Settings(fakeStorage());
    settings.setMatchCredential('m1', { seat: 1, secret: 'a', name: 'Ann' });
    settings.setMatchCredential('m2', { seat: 2, secret: 'b', name: 'Bo' });
    expect(settings.matchCredential('m1')?.seat).toBe(1);
    expect(settings.matchCredential('m2')?.seat).toBe(2);
  });

  it('drops malformed credential entries from a hand-edited payload', () => {
    const settings = new Settings(
      fakeStorage({
        [KEY]: JSON.stringify({
          matchCredentials: {
            good: { seat: 1, secret: 's', name: 'Ann' },
            bad: { seat: 'one', secret: 's' },
            alsoBad: 42,
          },
        }),
      }),
    );
    expect(settings.matchCredential('good')).toEqual({ seat: 1, secret: 's', name: 'Ann' });
    expect(settings.matchCredential('bad')).toBeNull();
    expect(settings.matchCredential('alsoBad')).toBeNull();
  });
});
