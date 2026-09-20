import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// index.html holds the whole game in one inline module, so nothing in it can be imported.
// These are deliberately static checks on the source text -- cheap tripwires for specific bugs
// that have shipped, not a substitute for playing the game.
const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../index.html'), 'utf8');

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
