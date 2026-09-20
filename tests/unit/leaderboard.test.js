// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLeaderboard } from '../../js/leaderboard.js';
import { createFakeSupabase, deferred, flush, SESSION } from '../helpers/fakeSupabase.js';

function makeElements() {
  document.body.innerHTML = `
    <div id="box"><input id="name"><button id="submit">Submit</button></div>
    <p id="status"></p><ol id="list"></ol>`;
  return {
    submitBox: document.getElementById('box'),
    nameInput: document.getElementById('name'),
    submitBtn: document.getElementById('submit'),
    statusEl: document.getElementById('status'),
    listEl: document.getElementById('list'),
  };
}

// Minimal stand-in for js/auth.js's public surface (only what leaderboard.js reads).
function makeAuth(sb, state = { session: null, profile: null }) {
  return { getClient: () => sb, getState: () => state };
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({
  user_id: `u${i}`, name: `Player${i}`, score: 1000 - i, avatar: 'P', color_filter: null,
}));

let elements;
beforeEach(() => { elements = makeElements(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('render', () => {
  it('renders one <li> per row, best first as returned', async () => {
    const { client } = createFakeSupabase({ tables: { scores: { select: { data: rows(10), error: null } } } });
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    await lb.render();
    expect(elements.listEl.querySelectorAll('li')).toHaveLength(10);
    expect(elements.listEl.textContent).toContain('Player0 — 1000');
  });

  it("highlights the signed-in user's own row with (you!)", async () => {
    const { client } = createFakeSupabase({ tables: { scores: { select: { data: rows(3), error: null } } } });
    const auth = makeAuth(client, { session: { user: { id: 'u1' } }, profile: {} });
    const lb = createLeaderboard({ auth, elements });
    await lb.render();
    const strong = elements.listEl.querySelectorAll('strong');
    expect(strong).toHaveLength(1);
    expect(strong[0].textContent).toContain('Player1');
    expect(strong[0].textContent).toContain('(you!)');
  });

  it('shows an empty-state message', async () => {
    const { client } = createFakeSupabase({ tables: { scores: { select: { data: [], error: null } } } });
    await createLeaderboard({ auth: makeAuth(client), elements }).render();
    expect(elements.listEl.textContent).toContain('No scores yet');
  });

  it('shows "unavailable" on a fetch error', async () => {
    const { client } = createFakeSupabase({ tables: { scores: { select: { data: null, error: { message: 'x' } } } } });
    await createLeaderboard({ auth: makeAuth(client), elements }).render();
    expect(elements.listEl.textContent).toContain('Leaderboard unavailable');
  });

  it('degrades without throwing when supabase never loaded', async () => {
    const lb = createLeaderboard({ auth: makeAuth(null), elements });
    await lb.render();
    expect(elements.listEl.textContent).toContain('Leaderboard unavailable');
    lb.onGameOver(10);
    elements.nameInput.value = 'bob'; // after onGameOver, which clears the box for the new run
    elements.submitBtn.click();
    await flush();
    expect(elements.statusEl.textContent).toContain('unavailable');
  });

  it('a slow, stale render loses to a newer one', async () => {
    const first = deferred();
    const second = deferred();
    const pending = [first, second];
    const { client } = createFakeSupabase({ tables: { scores: { select: () => pending.shift().promise } } });
    const lb = createLeaderboard({ auth: makeAuth(client), elements });

    const p1 = lb.render(); // will be resolved LAST
    const p2 = lb.render(); // newest render
    second.resolve({ data: [{ user_id: 'n', name: 'Newest', score: 2, avatar: null }], error: null });
    await p2;
    first.resolve({ data: [{ user_id: 'o', name: 'Oldest', score: 1, avatar: null }], error: null });
    await p1;

    expect(elements.listEl.textContent).toContain('Newest');
    expect(elements.listEl.textContent).not.toContain('Oldest');
  });
});

describe('REGRESSION: stored XSS via leaderboard rows', () => {
  it('a hostile color_filter / avatar / name never becomes markup', async () => {
    const hostile = [{
      user_id: 'evil',
      name: '<img src=x onerror="alert(1)">',
      score: 999,
      avatar: '<script>alert(2)</script>',
      color_filter: 'x" onmouseover="alert(3)" data-x="',
    }];
    const { client } = createFakeSupabase({ tables: { scores: { select: { data: hostile, error: null } } } });
    await createLeaderboard({ auth: makeAuth(client), elements }).render();

    const list = elements.listEl;
    expect(list.querySelectorAll('img, script, iframe, svg')).toHaveLength(0);
    // No element anywhere in the board may carry an event-handler attribute...
    for (const el of list.querySelectorAll('*')) {
      for (const attr of el.attributes) expect(attr.name).not.toMatch(/^on/i);
    }
    // ...and the hostile strings must appear only as inert text.
    expect(list.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(list.textContent).toContain('<script>alert(2)</script>');
    // The avatar span may only ever carry a style attribute -- nothing smuggled in beside it.
    const span = list.querySelector('span');
    expect(span).not.toBeNull();
    expect([...span.attributes].map((a) => a.name).filter((n) => n !== 'style')).toEqual([]);
  });
});

describe('submitting', () => {
  it("guest submit sends ONLY { name, score } -- anon's column grant allows nothing else", async () => {
    const { client, log } = createFakeSupabase();
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(420);
    elements.nameInput.value = 'Bob';
    elements.submitBtn.click();
    await flush();
    expect(log.inserts).toEqual([{ table: 'scores', row: { name: 'Bob', score: 420 } }]);
    expect(Object.keys(log.inserts[0].row).sort()).toEqual(['name', 'score']);
    expect(log.rpcs).toEqual([]);
    expect(elements.statusEl.textContent).toBe('Submitted!');
  });

  it('trims and caps guest names at 12 characters', async () => {
    const { client, log } = createFakeSupabase();
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(1);
    elements.nameInput.value = '   abcdefghijklmnop   ';
    elements.submitBtn.click();
    await flush();
    expect(log.inserts[0].row.name).toBe('abcdefghijkl');
  });

  it('rejects an empty guest name without contacting the server', async () => {
    const { client, log } = createFakeSupabase();
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(1);
    elements.nameInput.value = '   ';
    elements.submitBtn.click();
    await flush();
    expect(log.inserts).toEqual([]);
    expect(elements.statusEl.textContent).toBe('Enter a name first.');
  });

  it('a second click after a successful submit does nothing', async () => {
    const { client, log } = createFakeSupabase();
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(5);
    elements.nameInput.value = 'Bob';
    elements.submitBtn.click();
    await flush();
    elements.submitBtn.click();
    await flush();
    expect(log.inserts).toHaveLength(1);
  });

  it('a failed guest submit re-enables the button', async () => {
    const { client } = createFakeSupabase({ tables: { scores: { insert: { error: { message: 'denied' } } } } });
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(5);
    elements.nameInput.value = 'Bob';
    elements.submitBtn.click();
    await flush();
    expect(elements.submitBtn.disabled).toBe(false);
    expect(elements.statusEl.textContent).toContain("Couldn't submit");
  });
});

describe('onGameOver routing by auth state', () => {
  const signedIn = { session: SESSION, profile: { display_name: 'Me' } };

  it('signed in with a profile: auto-submits via the RPC, never a direct insert', async () => {
    const { client, log } = createFakeSupabase({ rpc: { submit_personal_best: { data: 500, error: null } } });
    const lb = createLeaderboard({ auth: makeAuth(client, signedIn), elements });
    lb.onGameOver(500);
    await flush();
    expect(log.rpcs).toEqual([{ name: 'submit_personal_best', args: { p_score: 500 } }]);
    expect(log.inserts).toEqual([]);
    expect(log.upserts).toEqual([]);
    expect(elements.submitBox.style.display).toBe('none');
    expect(elements.statusEl.textContent).toBe('New personal best!');
  });

  it('reports when the run did not beat the existing best (RPC returns null)', async () => {
    const { client } = createFakeSupabase({ rpc: { submit_personal_best: { data: null, error: null } } });
    createLeaderboard({ auth: makeAuth(client, signedIn), elements }).onGameOver(10);
    await flush();
    expect(elements.statusEl.textContent).toContain("Didn't beat your personal best");
  });

  it('an RPC error is reported, and the board is still re-rendered', async () => {
    const { client, log } = createFakeSupabase({ rpc: { submit_personal_best: { data: null, error: { message: 'boom' } } } });
    createLeaderboard({ auth: makeAuth(client, signedIn), elements }).onGameOver(10);
    await flush();
    expect(elements.statusEl.textContent).toContain("Couldn't submit");
    // once from onGameOver's own render, once from the error path
    expect(log.queries.filter((q) => q.table === 'scores' && q.op === 'select').length).toBeGreaterThanOrEqual(2);
  });

  it('signed in but no profile yet: hides the box and submits nothing', async () => {
    const { client, log } = createFakeSupabase();
    createLeaderboard({ auth: makeAuth(client, { session: SESSION, profile: null }), elements }).onGameOver(10);
    await flush();
    expect(elements.submitBox.style.display).toBe('none');
    expect(log.rpcs).toEqual([]);
    expect(log.inserts).toEqual([]);
  });

  it('signed out: shows the name box and clears any previous name', async () => {
    const { client, log } = createFakeSupabase();
    elements.nameInput.value = 'left over';
    createLeaderboard({ auth: makeAuth(client), elements }).onGameOver(10);
    await flush();
    expect(elements.submitBox.style.display).toBe('');
    expect(elements.nameInput.value).toBe('');
    expect(log.rpcs).toEqual([]);
  });
});
