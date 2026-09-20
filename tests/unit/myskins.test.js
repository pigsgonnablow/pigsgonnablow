// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMySkins } from '../../js/myskins.js';
import { createFakeSupabase, flush, SESSION } from '../helpers/fakeSupabase.js';

const SKINS = [
  { id: 'pig', name: 'Pig', emoji: 'P', price_cents: 0, color_filter: null },
  { id: 'dragon', name: 'Dragon', emoji: 'D', price_cents: 199, color_filter: 'hue-rotate(90deg)' },
  { id: 'unicorn', name: 'Unicorn', emoji: 'U', price_cents: 299, color_filter: null },
];

let elements;
beforeEach(() => {
  document.body.innerHTML = '<div id="list"></div><p id="status"></p>';
  elements = { listEl: document.getElementById('list'), statusEl: document.getElementById('status') };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function build({ owned = [], equipped = 'pig', session = SESSION, skins = SKINS, rpc } = {}) {
  const fake = createFakeSupabase({
    tables: {
      skins: { select: { data: skins, error: null } },
      owned_skins: { select: { data: owned.map((skin_id) => ({ skin_id })), error: null } },
    },
    rpc,
  });
  const auth = {
    getClient: () => fake.client,
    getState: () => ({ session, profile: session ? { equipped_skin_id: equipped } : null }),
    refreshProfile: vi.fn(async () => {}),
  };
  return { ...fake, auth, ui: createMySkins({ auth, elements }) };
}

const buttons = () => [...elements.listEl.querySelectorAll('button')];

describe('render', () => {
  it('lists free skins plus owned priced skins -- never a priced skin the account does not own', async () => {
    const { ui } = build({ owned: ['dragon'] });
    await ui.render();
    const names = [...elements.listEl.querySelectorAll('.skinName')].map((e) => e.textContent);
    expect(names).toEqual(['Pig', 'Dragon']);
    expect(names).not.toContain('Unicorn');
  });

  it('marks the equipped skin and disables its button; others get EQUIP', async () => {
    const { ui } = build({ owned: ['dragon'], equipped: 'pig' });
    await ui.render();
    const [pigBtn, dragonBtn] = buttons();
    expect(pigBtn.textContent).toBe('EQUIPPED');
    expect(pigBtn.disabled).toBe(true);
    expect(dragonBtn.textContent).toBe('EQUIP');
    expect(dragonBtn.disabled).toBe(false);
  });

  it('asks a signed-out visitor to sign in and never queries the catalog', async () => {
    const { ui, log } = build({ session: null });
    await ui.render();
    expect(elements.statusEl.textContent).toContain('Sign in');
    expect(log.queries).toEqual([]);
  });

  it('shows "unavailable" when supabase never loaded', async () => {
    const ui = createMySkins({ auth: { getClient: () => null, getState: () => ({}) }, elements });
    await ui.render();
    expect(elements.statusEl.textContent).toContain('Unavailable');
  });

  it('HTML in a skin name/emoji is escaped, not parsed', async () => {
    const evil = [{ id: 'pig', name: '<img src=x onerror=alert(1)>', emoji: '<script>x</script>', price_cents: 0, color_filter: null }];
    const { ui } = build({ skins: evil });
    await ui.render();
    expect(elements.listEl.querySelectorAll('img, script')).toHaveLength(0);
    expect(elements.listEl.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('equip', () => {
  it('calls the equip_skin RPC, then refreshes the cached profile, then re-renders', async () => {
    const order = [];
    const { ui, auth, log } = build({
      owned: ['dragon'],
      rpc: { equip_skin: () => { order.push('rpc'); return { data: null, error: null }; } },
    });
    auth.refreshProfile.mockImplementation(async () => { order.push('refresh'); });
    await ui.render();
    const skinQueriesBefore = log.queries.filter((q) => q.table === 'skins').length;
    buttons()[1].click(); // Dragon's EQUIP
    await flush();
    expect(log.rpcs).toEqual([{ name: 'equip_skin', args: { p_skin_id: 'dragon' } }]);
    expect(order).toEqual(['rpc', 'refresh']);
    expect(log.queries.filter((q) => q.table === 'skins').length).toBe(skinQueriesBefore + 1); // re-rendered
  });

  it('REGRESSION: never writes profiles directly (equipping is server-side only)', async () => {
    const { ui, log } = build({ owned: ['dragon'] });
    await ui.render();
    buttons()[1].click();
    await flush();
    expect(log.upserts).toEqual([]);
    expect(log.inserts).toEqual([]);
  });

  it('on a server rejection (e.g. "skin not owned") reports it and does NOT refresh the profile', async () => {
    const { ui, auth } = build({
      owned: ['dragon'],
      rpc: { equip_skin: { data: null, error: { message: 'skin not owned' } } },
    });
    await ui.render();
    buttons()[1].click();
    await flush();
    expect(elements.statusEl.textContent).toContain("Couldn't equip");
    expect(auth.refreshProfile).not.toHaveBeenCalled();
  });
});
