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

describe('sw.js fetch handler', () => {
  // Evaluate sw.js against a fake service-worker global so the real handler runs.
  function loadSw() {
    const handlers = {};
    const self = {
      location: { origin: 'https://www.pigsgonnablow.com' },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting() {}, clients: { claim() {} },
    };
    const caches = { match: async () => undefined, open: async () => ({ put() {}, addAll() {} }), keys: async () => [] };
    new Function('self', 'caches', 'fetch', read('sw.js'))(self, caches, async () => ({ ok: true, clone: () => ({}) }));
    return handlers.fetch;
  }
  const fire = (fetchHandler, url, method = 'GET') => {
    let responded = false;
    fetchHandler({ request: { url, method }, respondWith: () => { responded = true; } });
    return responded;
  };

  it('REGRESSION: never intercepts cross-origin requests (Supabase API responses must not be cached forever)', () => {
    const h = loadSw();
    expect(fire(h, 'https://ljnshaoruygijgtcokwv.supabase.co/rest/v1/scores?select=*')).toBe(false);
  });

  it('never intercepts non-GET requests', () => {
    const h = loadSw();
    expect(fire(h, 'https://www.pigsgonnablow.com/index.html', 'POST')).toBe(false);
  });

  it('does handle same-origin GETs', () => {
    const h = loadSw();
    expect(fire(h, 'https://www.pigsgonnablow.com/index.html')).toBe(true);
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
