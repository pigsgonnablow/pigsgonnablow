// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAuth } from '../../js/auth.js';
import { createFakeSupabase, flush, SESSION } from '../helpers/fakeSupabase.js';

const profileRow = { display_name: 'Me', avatar: 'P', equipped_skin_id: 'pig', color_filter: null };

function build(results = {}) {
  const fake = createFakeSupabase(results);
  window.supabase = { createClient: () => fake.client };
  const auth = createAuth({ url: 'https://x.supabase.co', anonKey: 'anon' });
  const states = [];
  auth.onChange((s) => states.push(s));
  return { auth, states, ...fake };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { delete window.supabase; });

describe('init', () => {
  it('with no supabase-js loaded, still notifies (signed-out) instead of hanging', async () => {
    delete window.supabase;
    const auth = createAuth({ url: 'u', anonKey: 'k' });
    const states = [];
    auth.onChange((s) => states.push(s));
    await auth.init();
    expect(states.at(-1)).toEqual({ session: null, profile: null });
    expect(await auth.setDisplayName('x')).toEqual({ error: 'Not signed in.' });
  });

  it('a getSession that throws still ends in a notify() with no session', async () => {
    const { auth, states } = build({ auth: { getSession: () => { throw new Error('corrupt session'); } } });
    await auth.init();
    expect(states.at(-1)).toEqual({ session: null, profile: null });
  });

  it('a stored session loads the profile', async () => {
    const { auth, states } = build({
      auth: { getSession: { data: { session: SESSION }, error: null } },
      tables: { profiles: { select: { data: profileRow, error: null } } },
    });
    await auth.init();
    expect(states.at(-1)).toEqual({ session: SESSION, profile: profileRow });
  });

  it('reacts to a later sign-in (magic link) and sign-out', async () => {
    const { auth, states, emitAuthChange } = build({
      tables: { profiles: { select: { data: profileRow, error: null } } },
    });
    await auth.init();
    await emitAuthChange('SIGNED_IN', SESSION);
    expect(states.at(-1)).toEqual({ session: SESSION, profile: profileRow });
    await emitAuthChange('SIGNED_OUT', null);
    expect(states.at(-1)).toEqual({ session: null, profile: null });
  });
});

describe('setDisplayName', () => {
  async function signedIn(extra = {}) {
    const b = build({
      auth: { getSession: { data: { session: SESSION }, error: null } },
      tables: { profiles: { select: { data: profileRow, error: null } } },
      ...extra,
    });
    await b.auth.init();
    return b;
  }

  it('REGRESSION: goes through the set_display_name RPC, never a direct profiles write', async () => {
    const { auth, log } = await signedIn({ rpc: { set_display_name: { data: null, error: null } } });
    const res = await auth.setDisplayName('Newname');
    expect(res).toEqual({ error: null });
    expect(log.rpcs).toEqual([{ name: 'set_display_name', args: { p_name: 'Newname' } }]);
    // the pre-lockdown implementation was a client-side .from('profiles').upsert(...)
    expect(log.upserts).toEqual([]);
    expect(log.inserts).toEqual([]);
  });

  it('re-fetches the profile and notifies listeners on success', async () => {
    const { auth, states, log } = await signedIn({ rpc: { set_display_name: { data: null, error: null } } });
    const before = states.length;
    const selectsBefore = log.queries.filter((q) => q.table === 'profiles').length;
    await auth.setDisplayName('Newname');
    expect(log.queries.filter((q) => q.table === 'profiles').length).toBe(selectsBefore + 1);
    expect(states.length).toBe(before + 1);
  });

  it('surfaces the server error and does not touch local state', async () => {
    const { auth, states, log } = await signedIn({
      rpc: { set_display_name: { data: null, error: { message: 'display name must be 1-12 characters' } } },
    });
    const before = states.length;
    const selectsBefore = log.queries.filter((q) => q.table === 'profiles').length;
    const res = await auth.setDisplayName('waytoolongname!!');
    expect(res).toEqual({ error: 'display name must be 1-12 characters' });
    expect(states.length).toBe(before);
    expect(log.queries.filter((q) => q.table === 'profiles').length).toBe(selectsBefore);
  });

  it('refuses when signed out, without calling the server', async () => {
    const { auth, log } = build();
    await auth.init();
    expect(await auth.setDisplayName('x')).toEqual({ error: 'Not signed in.' });
    expect(log.rpcs).toEqual([]);
  });
});

describe('sign-in / sign-out', () => {
  it('sendMagicLink passes the email and a redirect back to this page', async () => {
    const { auth, log } = build();
    const res = await auth.sendMagicLink('a@b.co');
    expect(res).toEqual({ error: null });
    const [name, args] = log.authCalls.find((c) => Array.isArray(c));
    expect(name).toBe('signInWithOtp');
    expect(args.email).toBe('a@b.co');
    expect(args.options.emailRedirectTo).toBe(window.location.origin + window.location.pathname);
  });

  it('sendMagicLink returns the error message on failure', async () => {
    const { auth } = build({ auth: { signInWithOtp: { error: { message: 'rate limited' } } } });
    expect(await auth.sendMagicLink('a@b.co')).toEqual({ error: 'rate limited' });
  });

  it('refreshProfile re-reads and notifies', async () => {
    const { auth, states } = build({
      auth: { getSession: { data: { session: SESSION }, error: null } },
      tables: { profiles: { select: { data: profileRow, error: null } } },
    });
    await auth.init();
    const before = states.length;
    await auth.refreshProfile();
    await flush();
    expect(states.length).toBe(before + 1);
  });
});
