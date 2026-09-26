// Supabase Auth wrapper: magic-link (passwordless) sign-in plus a one-row-per-user
// `profiles` table for the player's chosen leaderboard display name. Like leaderboard.js,
// Supabase is an optional dependency -- if supabase-js failed to load, every method here
// becomes a no-op so the rest of the game still works.
export function createAuth({ url, anonKey }){
  let sb = null;
  try {
    if (window.supabase) sb = window.supabase.createClient(url, anonKey);
  } catch (e) { sb = null; }

  let session = null;
  let profile = null; // { display_name } or null if not yet chosen
  const listeners = [];

  // REGRESSION: notify() is called from inside init()'s async body (and again from every
  // onAuthStateChange event), and onChange() below calls a freshly-registered listener
  // immediately and synchronously too -- none of that used to be guarded, so an uncaught throw
  // from ANY one listener (leaderboard/shop/myskins/index.html's own dragon-skin sync, all
  // registered via onChange) propagated out as that call's own exception. From inside init()'s
  // async body, that means the promise it returns rejects; both real call sites treat that
  // promise as fire-and-forget (see init()'s callers), so a bug in a single UI-update callback
  // would surface as an unhandledrejection -- popping the global fatal-error banner over what's
  // often a small, unrelated rendering bug -- and it stopped every *other* listener in the same
  // notify() pass from running too. Routing every listener call through this one place keeps one
  // broken callback from taking any of that down.
  function callListener(cb){
    try { cb({ session, profile }); } catch (e) { console.error('[auth] a listener threw:', e); }
  }
  function notify(){
    for (const cb of listeners) callListener(cb);
  }

  async function loadProfile(){
    if (!sb || !session){ profile = null; return; }
    try {
      const { data, error } = await sb
        .from('profiles')
        .select('display_name,avatar,equipped_skin_id,color_filter')
        .eq('user_id', session.user.id)
        .maybeSingle();
      if (error) console.error('[auth] loadProfile failed:', error.message);
      profile = data || null;
    } catch (e) {
      console.error('[auth] loadProfile threw:', e);
      profile = null;
    }
  }

  // Errors here (network hiccup, expired/corrupt stored session, etc.) must never leave the
  // UI stuck mid-render -- always fall through to notify() with whatever state we have, so the
  // account widget renders *something* (worst case, a safe logged-out Login button).
  async function init(){
    if (!sb){ notify(); return; }
    try {
      const { data, error } = await sb.auth.getSession();
      if (error) console.error('[auth] getSession failed:', error.message);
      session = data ? data.session : null;
      if (session) await loadProfile();
    } catch (e) {
      console.error('[auth] init threw:', e);
      session = null;
      profile = null;
    }
    notify();
    sb.auth.onAuthStateChange(async (_event, newSession) => {
      try {
        session = newSession;
        if (session) await loadProfile(); else profile = null;
      } catch (e) {
        console.error('[auth] onAuthStateChange handler threw:', e);
      }
      notify();
    });
  }

  // Registers a callback fired immediately with the current state, then again on every change.
  function onChange(cb){
    listeners.push(cb);
    callListener(cb);
  }

  async function sendMagicLink(email){
    if (!sb) return { error: 'Sign-in unavailable right now.' };
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    return { error: error ? error.message : null };
  }

  async function signOut(){
    if (!sb) return;
    await sb.auth.signOut();
  }

  async function setDisplayName(name){
    if (!sb || !session) return { error: 'Not signed in.' };
    // RPC (security definer), not a raw client upsert -- see supabase_lockdown_direct_writes.sql
    // for why a direct .from('profiles').upsert(...) can no longer work at all: PostgREST
    // compiles an upsert's ON CONFLICT DO UPDATE to include every inserted column, including
    // user_id, so it needs UPDATE privilege on user_id too -- which would let a client
    // reassign the row to someone else's account. The RPC always writes auth.uid() itself.
    const { error } = await sb.rpc('set_display_name', { p_name: name });
    if (error) return { error: error.message };
    await loadProfile(); // re-fetch rather than hand-roll the local copy, so avatar (and any
                          // future profile fields) stay correct instead of going stale/undefined
    notify();
    return { error: null };
  }

  // For callers (e.g. the shop, after equip_skin) that write to `profiles` directly via their
  // own RPC/query rather than through setDisplayName -- the local cache above has no other way
  // to find out, so it would otherwise keep serving stale data until the next sign-in.
  async function refreshProfile(){
    await loadProfile();
    notify();
  }

  function getClient(){ return sb; }
  function getState(){ return { session, profile }; }

  return { init, onChange, sendMagicLink, signOut, setDisplayName, refreshProfile, getClient, getState };
}
