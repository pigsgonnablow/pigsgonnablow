// Hooks for hosting the game on a web game portal (CrazyGames, see tools/build-crazygames.mjs).
// On pigsgonnablow.com there is no portal SDK on the page, so every method here is a no-op and
// the site behaves exactly as before. In the CrazyGames build the SDK script is loaded in
// <head>, and these report gameplay start/stop, which CrazyGames requires once its SDK is
// present (https://docs.crazygames.com/requirements/technical/).
//
// Every call is wrapped: a portal SDK hiccup must never break or stall the game itself.
export function createPortal(win){
  const sdk = win && win.CrazyGames && win.CrazyGames.SDK ? win.CrazyGames.SDK : null;
  let ready = false;
  let playing = false;

  function safe(fn){
    if (!sdk || !ready) return;
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch((e) => console.warn('[portal]', e));
    } catch (e) { console.warn('[portal]', e); }
  }

  async function init(){
    if (!sdk) return false;
    try {
      await sdk.init();
      ready = true;
      safe(() => sdk.game.loadingStop());
    } catch (e) {
      console.warn('[portal] SDK init failed; playing without it:', e);
    }
    return ready;
  }

  // gameplayStart/Stop are only sent on a real state change, so a double call (say, PLAY AGAIN
  // right after a game over) can't send two starts in a row.
  function gameplayStart(){
    if (playing) return;
    playing = true;
    safe(() => sdk.game.gameplayStart());
  }
  function gameplayStop(){
    if (!playing) return;
    playing = false;
    safe(() => sdk.game.gameplayStop());
  }

  return { init, gameplayStart, gameplayStop, isPortal: !!sdk };
}
