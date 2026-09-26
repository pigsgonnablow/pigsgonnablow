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

// Anonymous submission goes through the submit-score Edge Function (see
// supabase_scores_rate_limit_by_ip.sql for why: it's the only thing that sees this caller's
// real IP, which is what lets the server rate-limit per caller instead of globally). Every test
// below supplies its own `functions['submit-score']` result rather than relying on
// createFakeSupabase()'s default ({ data: null, error: null }), since a real submit-score
// success looks like { data: { ok: true }, error: null } -- `data: null` is what a *failure*
// looks like here.
const OK = { data: { ok: true }, error: null };

describe('submitting', () => {
  it("guest submit calls submit-score with ONLY { name, score }", async () => {
    const { client, log } = createFakeSupabase({ functions: { 'submit-score': OK } });
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(420);
    elements.nameInput.value = 'Bob';
    elements.submitBtn.click();
    await flush();
    expect(log.invokes).toEqual([{ name: 'submit-score', opts: { body: { name: 'Bob', score: 420 } } }]);
    expect(Object.keys(log.invokes[0].opts.body).sort()).toEqual(['name', 'score']);
    expect(log.rpcs).toEqual([]);
    expect(log.inserts).toEqual([]);
    expect(elements.statusEl.textContent).toBe('Submitted!');
  });

  it('trims and caps guest names at 12 characters', async () => {
    const { client, log } = createFakeSupabase({ functions: { 'submit-score': OK } });
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(1);
    elements.nameInput.value = '   abcdefghijklmnop   ';
    elements.submitBtn.click();
    await flush();
    expect(log.invokes[0].opts.body.name).toBe('abcdefghijkl');
  });

  it('rejects an empty guest name without contacting the server', async () => {
    const { client, log } = createFakeSupabase({ functions: { 'submit-score': OK } });
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(1);
    elements.nameInput.value = '   ';
    elements.submitBtn.click();
    await flush();
    expect(log.invokes).toEqual([]);
    expect(elements.statusEl.textContent).toBe('Enter a name first.');
  });

  it('a second click after a successful submit does nothing', async () => {
    const { client, log } = createFakeSupabase({ functions: { 'submit-score': OK } });
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(5);
    elements.nameInput.value = 'Bob';
    elements.submitBtn.click();
    await flush();
    elements.submitBtn.click();
    await flush();
    expect(log.invokes).toHaveLength(1);
  });

  it("REGRESSION: after submitting, the guest's own row is the one highlighted (you!)", async () => {
    // Signed-in rows are matched by user_id; a guest row has none, so it's matched by the
    // name+score that was just submitted. A same-name row from someone else's run must not
    // steal the highlight.
    const board = [
      { user_id: null, name: 'Bob', score: 9000, avatar: null, color_filter: null }, // a different Bob
      { user_id: null, name: 'Bob', score: 420, avatar: null, color_filter: null },  // this run
    ];
    const { client } = createFakeSupabase({
      tables: { scores: { select: { data: board, error: null } } },
      functions: { 'submit-score': OK },
    });
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(420);
    elements.nameInput.value = 'Bob';
    elements.submitBtn.click();
    await flush();
    const strong = elements.listEl.querySelectorAll('strong');
    expect(strong).toHaveLength(1);
    expect(strong[0].textContent).toBe('Bob — 420 (you!)');
  });

  it('a new run clears the previous run\'s highlight and lets the player submit again', async () => {
    const board = [{ user_id: null, name: 'Bob', score: 420, avatar: null, color_filter: null }];
    const { client, log } = createFakeSupabase({
      tables: { scores: { select: { data: board, error: null } } },
      functions: { 'submit-score': OK },
    });
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(420);
    elements.nameInput.value = 'Bob';
    elements.submitBtn.click();
    await flush();
    expect(log.invokes).toHaveLength(1);

    lb.onGameOver(50); // next run -- alreadySubmitted/justSubmittedName must reset
    await flush();
    expect(elements.listEl.querySelectorAll('strong')).toHaveLength(0);
    expect(elements.submitBtn.disabled).toBe(false);
    elements.nameInput.value = 'Bob';
    elements.submitBtn.click();
    await flush();
    expect(log.invokes.map((i) => i.opts.body.score)).toEqual([420, 50]);
  });

  it('a failed guest submit (server error) re-enables the button', async () => {
    const { client } = createFakeSupabase({
      functions: { 'submit-score': { data: null, error: { message: 'denied' } } },
    });
    const lb = createLeaderboard({ auth: makeAuth(client), elements });
    lb.onGameOver(5);
    elements.nameInput.value = 'Bob';
    elements.submitBtn.click();
    await flush();
    expect(elements.submitBtn.disabled).toBe(false);
    expect(elements.statusEl.textContent).toContain("Couldn't submit");
  });

  it('a failed guest submit (rate-limited: ok:false with no error) re-enables the button', async () => {
    const { client } = createFakeSupabase({
      functions: { 'submit-score': { data: { ok: false, error: 'too many' }, error: null } },
    });
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
