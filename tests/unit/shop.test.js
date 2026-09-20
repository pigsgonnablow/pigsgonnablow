// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createShop } from '../../js/shop.js';
import { createFakeSupabase, flush, SESSION } from '../helpers/fakeSupabase.js';

const SKINS = [
  { id: 'pig', name: 'Pig', emoji: 'P', price_cents: 0, color_filter: null },
  { id: 'dragon', name: 'Dragon', emoji: 'D', price_cents: 199, color_filter: null },
  { id: 'unicorn', name: 'Unicorn', emoji: 'U', price_cents: 100000, color_filter: null },
];

let elements;
beforeEach(() => {
  document.body.innerHTML = '<div id="list"></div><p id="status"></p>';
  elements = { listEl: document.getElementById('list'), statusEl: document.getElementById('status') };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

function build({ owned = [], session = SESSION, functions } = {}) {
  const fake = createFakeSupabase({
    tables: {
      skins: { select: { data: SKINS, error: null } },
      owned_skins: { select: { data: owned.map((skin_id) => ({ skin_id })), error: null } },
    },
    functions,
  });
  const auth = { getClient: () => fake.client, getState: () => ({ session, profile: null }) };
  return { ...fake, shop: createShop({ auth, elements }) };
}

const cards = () => [...elements.listEl.querySelectorAll('.skinCard')];
const priceOf = (card) => card.querySelector('.skinPrice').textContent;
const btnOf = (card) => card.querySelector('button');

describe('render', () => {
  it('formats prices as dollars.cents with no drift', async () => {
    const { shop } = build();
    await shop.render();
    expect(cards().map(priceOf)).toEqual(['Owned', '$1.99', '$1000.00']); // free skin counts as owned
  });

  it('free and already-owned skins are disabled OWNED; unowned priced skins are BUY', async () => {
    const { shop } = build({ owned: ['dragon'] });
    await shop.render();
    const [pig, dragon, unicorn] = cards().map(btnOf);
    expect([pig.textContent, pig.disabled]).toEqual(['OWNED', true]);
    expect([dragon.textContent, dragon.disabled]).toEqual(['OWNED', true]);
    expect([unicorn.textContent, unicorn.disabled]).toEqual(['BUY', false]);
  });

  it('signed out: BUY is disabled with a hint, and the owned-skins table is never queried', async () => {
    const { shop, log } = build({ session: null });
    await shop.render();
    const unicorn = btnOf(cards()[2]);
    expect(unicorn.disabled).toBe(true);
    expect(unicorn.title).toBe('Sign in to buy');
    expect(elements.statusEl.textContent).toContain('Sign in');
    expect(log.queries.some((q) => q.table === 'owned_skins')).toBe(false);
  });

  it('shows "unavailable" when supabase never loaded', async () => {
    const shop = createShop({ auth: { getClient: () => null, getState: () => ({}) }, elements });
    await shop.render();
    expect(elements.statusEl.textContent).toContain('unavailable');
  });
});

describe('buy', () => {
  it('invokes create-checkout with only the skin id (never a user id) and redirects to the returned URL', async () => {
    const loc = { href: 'https://www.pigsgonnablow.com/' };
    vi.stubGlobal('location', loc);
    const { shop, log } = build({
      functions: { 'create-checkout': { data: { url: 'https://checkout.stripe.com/c/pay/cs_1' }, error: null } },
    });
    await shop.render();
    btnOf(cards()[2]).click();
    await flush();
    expect(log.invokes).toEqual([{ name: 'create-checkout', opts: { body: { skin_id: 'unicorn' } } }]);
    expect(window.location.href).toBe('https://checkout.stripe.com/c/pay/cs_1');
  });

  it('on failure, shows an error and re-enables the button', async () => {
    const { shop } = build({ functions: { 'create-checkout': { data: null, error: { message: 'boom' } } } });
    await shop.render();
    const btn = btnOf(cards()[2]);
    btn.click();
    await flush();
    expect(elements.statusEl.textContent).toContain("Couldn't start checkout");
    expect(btn.disabled).toBe(false);
  });

  it('a response with no url is treated as a failure, not a redirect to "undefined"', async () => {
    const loc = { href: 'https://www.pigsgonnablow.com/' };
    vi.stubGlobal('location', loc);
    const { shop } = build({ functions: { 'create-checkout': { data: {}, error: null } } });
    await shop.render();
    btnOf(cards()[2]).click();
    await flush();
    expect(window.location.href).toBe('https://www.pigsgonnablow.com/');
    expect(elements.statusEl.textContent).toContain("Couldn't start checkout");
  });
});
