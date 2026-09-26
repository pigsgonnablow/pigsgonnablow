// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ensureAudio } from '../../js/audio.js';

function fakeAudioContext(resumeResult) {
  return class {
    constructor(){ this.state = 'suspended'; }
    resume(){ return resumeResult(); }
  };
}

afterEach(() => {
  delete window.AudioContext;
  delete window.webkitAudioContext;
});

describe('ensureAudio', () => {
  // REGRESSION: resume() returns a promise that can reject (InvalidStateError, a browser
  // refusing to resume outside a fresh user gesture, etc.) -- ensureAudio() is called on
  // ordinary in-game actions, not just an explicit "enable sound" click, so an uncaught
  // rejection here used to surface as a global unhandledrejection and pop the fatal-error
  // banner over a perfectly playable game (audio just staying muted is the correct, non-fatal
  // outcome instead).
  it('a rejected resume() is caught, not left to become an unhandled rejection', async () => {
    window.AudioContext = fakeAudioContext(() => Promise.reject(new Error('InvalidStateError')));
    ensureAudio(); // creates the context (state: suspended)
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e.reason; };
    window.addEventListener('unhandledrejection', onUnhandled);
    try {
      ensureAudio(); // triggers the suspended-state resume() branch
      await new Promise((r) => setTimeout(r, 0)); // let the rejection (if any) surface
      expect(unhandled).toBeNull();
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled);
    }
  });
});
