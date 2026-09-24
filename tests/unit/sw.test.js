import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// Normalise CRLF: on Windows the working tree is CRLF while `git show` returns LF, which would
// otherwise make an untouched ASSETS block compare as "changed".
const parseSw = (raw) => parseSwSrc(raw.replace(/\r\n/g, '\n'));
const parseSwSrc = (src) => ({
  cacheName: /const CACHE_NAME = '([^']+)'/.exec(src)?.[1],
  assetsBlock: /const ASSETS = \[([\s\S]*?)\];/.exec(src)?.[1],
  assets: [...(/const ASSETS = \[([\s\S]*?)\];/.exec(src)?.[1] ?? '').matchAll(/'\.\/([^']*)'/g)]
    .map((m) => m[1] || 'index.html'),
});

const sw = parseSw(read('sw.js'));
const sw_CACHE = sw.cacheName;

describe('sw.js ASSETS', () => {
  it('parses (guards the parser the other tests rely on)', () => {
    expect(sw.cacheName).toMatch(/^burger-pig-v\d+$/);
    expect(sw.assets.length).toBeGreaterThan(5);
  });

  it('every listed asset exists on disk (a missing file makes cache.addAll reject and breaks the install)', () => {
    for (const a of sw.assets) expect(existsSync(resolve(ROOT, a)), a).toBe(true);
  });

  it('covers every shipped js module -- a new module missing here silently breaks offline mode', () => {
    for (const f of readdirSync(resolve(ROOT, 'js')).filter((f) => f.endsWith('.js'))) {
      expect(sw.assets, `js/${f}`).toContain(`js/${f}`);
    }
  });
});

// Evaluate sw.js against a fake service-worker global so the real handlers run.
// `store` is a { [cacheName]: Map(url -> response) } stand-in for the CacheStorage, so a test
// can assert on what actually ended up cached (and under which cache name) rather than just
// on which calls were made.
function loadSw({ store = {}, fetchImpl } = {}) {
  const handlers = {};
  const waits = [];
  const self = {
    location: { origin: 'https://www.pigsgonnablow.com' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting() { self.skipWaitingCalled = true; },
    clients: { claim() { self.claimCalled = true; } },
  };
  const cacheFor = (name) => {
    store[name] = store[name] || new Map();
    const m = store[name];
    return {
      async addAll(urls) { for (const u of urls) m.set(u, { ok: true, precached: true }); },
      async put(request, response) { m.set(request.url ?? request, response); },
    };
  };
  const caches = {
    async match(request) {
      for (const m of Object.values(store)) if (m.has(request.url ?? request)) return m.get(request.url ?? request);
      return undefined;
    },
    async open(name) { return cacheFor(name); },
    async keys() { return Object.keys(store); },
    async delete(name) { return delete store[name]; },
  };
  const fetchFn = fetchImpl || (async () => ({ ok: true, clone: () => ({ body: 'fresh' }), body: 'fresh' }));
  new Function('self', 'caches', 'fetch', read('sw.js'))(self, caches, fetchFn);
  // event.waitUntil just needs to hand the promise back so a test can await the work.
  const event = (extra) => ({ waitUntil: (p) => waits.push(p), ...extra });
  return {
    self, store, handlers, event,
    settle: () => Promise.all(waits.splice(0)),
    fire: (type, extra) => { const e = event(extra); handlers[type](e); return e; },
  };
}

describe('sw.js fetch handler', () => {
  const fire = (sw, url, method = 'GET') => {
    let responded = null;
    sw.handlers.fetch({ request: { url, method }, respondWith: (p) => { responded = p; } });
    return responded;
  };

  it('REGRESSION: never intercepts cross-origin requests (Supabase API responses must not be cached forever)', () => {
    expect(fire(loadSw(), 'https://ljnshaoruygijgtcokwv.supabase.co/rest/v1/scores?select=*')).toBe(null);
  });

  it('never intercepts non-GET requests', () => {
    expect(fire(loadSw(), 'https://www.pigsgonnablow.com/index.html', 'POST')).toBe(null);
  });

  it('does handle same-origin GETs', () => {
    expect(fire(loadSw(), 'https://www.pigsgonnablow.com/index.html')).not.toBe(null);
  });

  it('serves a precached asset from the cache without going to the network', async () => {
    let fetched = 0;
    const sw = loadSw({
      store: { [sw_CACHE]: new Map([['https://www.pigsgonnablow.com/js/iso.js', { ok: true, body: 'cached' }]]) },
      fetchImpl: async () => { fetched++; return { ok: true, clone: () => ({}) }; },
    });
    const res = await fire(sw, 'https://www.pigsgonnablow.com/js/iso.js');
    expect(res.body).toBe('cached');
    expect(fetched).toBe(0);
  });

  it('caches a fresh same-origin response under the CURRENT cache name', async () => {
    const sw = loadSw();
    await fire(sw, 'https://www.pigsgonnablow.com/js/iso.js');
    await sw.settle();
    await new Promise((r) => setTimeout(r, 0)); // the cache.put chain isn't awaited by the handler
    expect([...(sw.store[sw_CACHE] ?? new Map()).keys()]).toEqual(['https://www.pigsgonnablow.com/js/iso.js']);
  });

  it('REGRESSION: a failed response (404/500) is never written to the cache', async () => {
    // Caching a 404 would poison offline mode for that asset until the next CACHE_NAME bump.
    const sw = loadSw({ fetchImpl: async () => ({ ok: false, status: 404, clone: () => ({}) }) });
    const res = await fire(sw, 'https://www.pigsgonnablow.com/js/typo.js');
    await new Promise((r) => setTimeout(r, 0));
    expect(res.status).toBe(404);
    expect(Object.values(sw.store).every((m) => m.size === 0)).toBe(true);
  });

  it('offline with the asset already cached: answered from the cache, network never attempted', async () => {
    // `cached || fetch(...)` short-circuits before fetch is ever called, so this is the path
    // that actually keeps the PWA playable offline -- not any fallback in the fetch branch.
    let fetched = 0;
    const sw = loadSw({
      store: { [sw_CACHE]: new Map([['https://www.pigsgonnablow.com/index.html', { ok: true, body: 'cached' }]]) },
      fetchImpl: async () => { fetched++; throw new TypeError('Failed to fetch'); },
    });
    expect((await fire(sw, 'https://www.pigsgonnablow.com/index.html')).body).toBe('cached');
    expect(fetched).toBe(0);
  });

  it('REGRESSION: offline with nothing cached surfaces as a real network error, not a silent undefined', async () => {
    // Previously the fetch branch ended in `.catch(() => cached)`, which -- since `cached` is
    // only ever falsy by the time that branch runs -- swallowed the real network failure and
    // resolved to `undefined` instead of rejecting. That would have made the browser treat a
    // failed navigation as a successful response with no body.
    const sw = loadSw({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await expect(fire(sw, 'https://www.pigsgonnablow.com/js/uncached.js')).rejects.toThrow('Failed to fetch');
  });
});

describe('sw.js install / activate', () => {
  it('install precaches exactly the ASSETS list, into the current cache', async () => {
    const s = loadSw();
    s.fire('install');
    await s.settle();
    expect(Object.keys(s.store)).toEqual([sw_CACHE]);
    // exactly the paths listed in ASSETS, verbatim -- nothing dropped, nothing extra
    const listed = [...sw.assetsBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...s.store[sw_CACHE].keys()]).toEqual(listed);
    expect(s.self.skipWaitingCalled).toBe(true); // new version takes over without a second visit
  });

  it('REGRESSION: activate deletes every OTHER cache and keeps the current one', async () => {
    // This is what makes a CACHE_NAME bump actually take effect -- without it the old
    // version's entries stay around and caches.match can keep answering from them.
    const s = loadSw({ store: { 'burger-pig-v1': new Map([['/x', {}]]), 'burger-pig-v21': new Map(), [sw_CACHE]: new Map() } });
    s.fire('activate');
    await s.settle();
    expect(Object.keys(s.store)).toEqual([sw_CACHE]);
    expect(s.self.claimCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// REGRESSION: "missed service-worker cache bump". The service worker serves cached assets
// first, so a change to any listed file that ships without a CACHE_NAME bump is invisible to
// returning players until they clear site data. This has shipped as a bug twice (v20->v21
// was a catch-up for an unbumped commit).
//
// Compares the working tree against a base ref:
//   locally      -> HEAD            (so uncommitted edits to a cached file need a bump too)
//   CI (PRs)     -> SW_GUARD_BASE = the merge base with main
//   CI (pushes)  -> SW_GUARD_BASE = the previous commit on the branch
// Skipped (with a reason) when git or the base ref isn't available.
// ---------------------------------------------------------------------------------------
describe('REGRESSION: cache version is bumped whenever a cached asset changes', () => {
  const base = process.env.SW_GUARD_BASE || 'HEAD';
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  let ready = true;
  try { git('rev-parse', '--verify', `${base}^{commit}`); } catch { ready = false; }

  it.skipIf(!ready)(`(vs ${base})`, () => {
    const changed = git('diff', '--name-only', base).split('\n').filter(Boolean);
    const cachedChanged = changed.filter((f) => sw.assets.includes(f));

    let baseSw = null;
    try { baseSw = parseSw(git('show', `${base}:sw.js`)); } catch { /* sw.js is new -> nothing to compare */ }

    // Editing the ASSETS list itself changes what install() caches, so it needs a bump too;
    // editing only the fetch/activate logic does not (browsers re-install a byte-changed sw.js).
    const assetsListChanged = baseSw ? baseSw.assetsBlock !== sw.assetsBlock : false;

    if (cachedChanged.length === 0 && !assetsListChanged) return; // nothing cached changed
    if (!baseSw) return;

    expect(
      sw.cacheName,
      `These cached files changed vs ${base}: ${[...cachedChanged, ...(assetsListChanged ? ['sw.js (ASSETS list)'] : [])].join(', ')}.\n` +
        `Bump CACHE_NAME in sw.js (currently '${sw.cacheName}') or returning players will keep the old files.`,
    ).not.toBe(baseSw.cacheName);
  });
});
