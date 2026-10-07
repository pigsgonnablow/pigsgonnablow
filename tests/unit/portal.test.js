import { describe, it, expect, vi } from 'vitest';
import { createPortal } from '../../js/portal.js';

function fakeSdk({ initFails = false } = {}) {
  const calls = [];
  const SDK = {
    init: vi.fn(async () => { calls.push('init'); if (initFails) throw new Error('nope'); }),
    game: {
      loadingStop: () => calls.push('loadingStop'),
      gameplayStart: () => calls.push('gameplayStart'),
      gameplayStop: () => calls.push('gameplayStop'),
    },
  };
  return { win: { CrazyGames: { SDK } }, calls };
}

describe('createPortal', () => {
  it('is a silent no-op on our own site, where no portal SDK is loaded', async () => {
    const portal = createPortal({});
    expect(portal.isPortal).toBe(false);
    expect(await portal.init()).toBe(false);
    expect(() => { portal.gameplayStart(); portal.gameplayStop(); }).not.toThrow();
  });

  it('initializes the SDK, ends loading, then reports gameplay start/stop', async () => {
    const { win, calls } = fakeSdk();
    const portal = createPortal(win);
    expect(await portal.init()).toBe(true);
    portal.gameplayStart();
    portal.gameplayStop();
    expect(calls).toEqual(['init', 'loadingStop', 'gameplayStart', 'gameplayStop']);
  });

  it('never sends two starts or two stops in a row', async () => {
    const { win, calls } = fakeSdk();
    const portal = createPortal(win);
    await portal.init();
    portal.gameplayStart(); portal.gameplayStart();
    portal.gameplayStop(); portal.gameplayStop();
    expect(calls.filter((c) => c.startsWith('gameplay'))).toEqual(['gameplayStart', 'gameplayStop']);
  });

  it('a failed SDK init leaves the game playable and sends nothing further', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { win, calls } = fakeSdk({ initFails: true });
    const portal = createPortal(win);
    expect(await portal.init()).toBe(false);
    portal.gameplayStart();
    expect(calls).toEqual(['init']);
  });

  it('an SDK call that throws never reaches the game', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { win } = fakeSdk();
    win.CrazyGames.SDK.game.gameplayStart = () => { throw new Error('boom'); };
    const portal = createPortal(win);
    await portal.init();
    expect(() => portal.gameplayStart()).not.toThrow();
  });
});
