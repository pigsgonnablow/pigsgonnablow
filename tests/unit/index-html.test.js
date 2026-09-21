import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// index.html holds the whole game in one inline module, so nothing in it can be imported.
// These are deliberately static checks on the source text -- cheap tripwires for specific bugs
// that have shipped, not a substitute for playing the game.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');

// Returns the text of the {...} block starting at the first `{` after `start` (brace-balanced).
function blockAfter(start) {
  const i = html.indexOf(start);
  if (i < 0) throw new Error(`could not find "${start}" in index.html`);
  const open = html.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}' && --depth === 0) return html.slice(open, k + 1);
  }
  throw new Error(`unbalanced braces after "${start}"`);
}

describe('Content-Security-Policy', () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  const directive = (name) => new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`).exec(csp)?.[1].trim().split(/\s+/) ?? [];

  it('is present', () => expect(csp).toBeTruthy());

  it("connect-src allows exactly the project's SUPABASE_URL (two hardcoded copies that must not drift)", () => {
    const supabaseUrl = /const SUPABASE_URL = '([^']+)'/.exec(html)?.[1];
    expect(supabaseUrl).toMatch(/^https:\/\/[a-z0-9]+\.supabase\.co$/);
    expect(directive('connect-src')).toContain(supabaseUrl);
  });

  it("forbids framing and <base> hijacking", () => {
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'none'"]);
  });

  it("does not open default-src or connect-src to arbitrary origins", () => {
    expect(directive('default-src')).toEqual(["'self'"]);
    expect(directive('connect-src').filter((s) => s === '*' || s === 'https:' || s === 'http:')).toEqual([]);
  });
});

describe("REGRESSION: leaving a game screen hides the in-game overlays (#warning lives outside #hud)", () => {
  const paths = {
    endGame: () => blockAfter('function endGame('),
    showVictoryScreen: () => blockAfter('function showVictoryScreen('),
    'exit button handler': () => blockAfter("exitBtn.addEventListener('click'"),
  };

  for (const [name, body] of Object.entries(paths)) {
    it(`${name} hides the HUD and the warning banner`, () => {
      const src = body();
      expect(src).toContain("hudEl.classList.add('hidden')");
      expect(src).toContain("warningEl.style.display = 'none'");
    });
  }

  it('endGame and showVictoryScreen also hide the wind indicator', () => {
    expect(paths.endGame()).toContain("windIndicatorEl.classList.add('hidden')");
    expect(paths.showVictoryScreen()).toContain("windIndicatorEl.classList.add('hidden')");
  });

  it('resuming after the victory screen brings the HUD back', () => {
    expect(blockAfter('function resumeAfterVictory(')).toContain("hudEl.classList.remove('hidden')");
  });
});

describe('REGRESSION: the dragon-skin variables are declared BEFORE auth.onChange is registered', () => {
  // auth.onChange fires its callback synchronously during registration (see the matching test
  // in auth.test.js), and that callback assigns these three. Declaring them after the
  // registration is a real temporal-dead-zone ReferenceError thrown from inside the startup
  // IIFE -- which once aborted the rest of the script and left every button on the page
  // (START, SHOP, LOGIN) dead, with nothing obvious in the console.
  const onChangeAt = html.indexOf('auth.onChange(');

  it('auth.onChange is registered exactly once, and after the declarations', () => {
    expect(onChangeAt).toBeGreaterThan(0);
    expect(html.indexOf('auth.onChange(', onChangeAt + 1)).toBe(-1);
    for (const decl of ['let dragonEmoji', 'let dragonFilter', 'let dragonIsRed']) {
      const at = html.indexOf(decl);
      expect(at, decl).toBeGreaterThan(0);
      expect(at, decl).toBeLessThan(onChangeAt);
    }
  });
});

describe('REGRESSION: the post-Checkout return waits for auth before rendering the shop', () => {
  // auth.init() is fire-and-forget at startup. Rendering the shop before the signed-in
  // session/profile has been restored made every Owned/Equipped row on that first render
  // (the one a buyer sees immediately after paying) wrong or blank.
  const block = html.slice(html.indexOf("get('checkout')"), html.indexOf("get('checkout')") + 1200);

  it('shop.render() is chained off authReady, not called directly', () => {
    expect(block).toMatch(/authReady[\s\S]*?shop\.render\(\)/);
    expect(block).not.toMatch(/^\s*shop\.render\(\);/m);
  });

  it('the ?checkout= param is stripped so a refresh cannot re-show the message', () => {
    expect(block).toContain('history.replaceState');
  });
});

describe('no server-side secret is shipped to the browser', () => {
  // The Supabase key in index.html is deliberately public (RLS is the real boundary), but a
  // service-role key / Stripe secret / webhook secret pasted in here instead would hand every
  // visitor full database write access -- and there is nothing in a browser that would
  // complain. The Edge Functions' own secrets live in Supabase's env, never in this repo.
  const shipped = ['index.html', 'sw.js', ...readdirSync(resolve(ROOT, 'js')).map((f) => `js/${f}`)];

  it.each(shipped)('%s contains no secret-shaped token', (file) => {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    for (const pattern of [/\bsk_(live|test)_/, /\bwhsec_/, /\bsb_secret_/, /service_role/, /\bSUPABASE_SERVICE_ROLE_KEY\b/]) {
      expect(src, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  it("index.html's Supabase key is a publishable one", () => {
    const key = /const SUPABASE_ANON_KEY = '([^']+)'/.exec(html)?.[1];
    expect(key).toMatch(/^sb_publishable_/);
  });
});
