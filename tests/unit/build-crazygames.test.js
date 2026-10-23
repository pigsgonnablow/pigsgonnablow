import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertIndexHtml } from '../../tools/build-crazygames.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const out = convertIndexHtml(html);

describe('CrazyGames build of index.html', () => {
  it('drops the anti-framing guard (CrazyGames always shows games in an iframe)', () => {
    expect(out).not.toContain('antiframeStyle');
    expect(out).not.toContain('top.location');
  });

  it('drops the CSP meta (it would block the SDK) and loads the SDK', () => {
    expect(out).not.toContain('Content-Security-Policy');
    expect(out).toContain('<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>');
  });

  it('leaves Supabase out, so sign-in, shop and our own payments are off', () => {
    expect(out).not.toContain('js/vendor/supabase.js');
  });

  it('marks the page as a portal build and hides accounts, shop, skins and leaderboard', () => {
    expect(out).toContain('<html lang="en" data-portal="crazygames">');
    for (const id of ['viewLeaderboardBtn', 'viewShopBtn', 'viewMySkinsBtn', 'accountBox', 'scoreSubmitBox', 'leaderboardBox']) {
      expect(out).toMatch(new RegExp(`#${id}[,\\s]`));
      expect(html, `${id} must still exist in index.html`).toContain(`id="${id}"`);
    }
  });

  it('keeps the Privacy Policy and Terms links visible, pointing at the live site in a new tab', () => {
    expect(out).not.toMatch(/#privacyLinks,/);
    expect(out).toMatch(/#privacyLinks \{ position:fixed/);
    expect(out).toContain('href="https://www.pigsgonnablow.com/privacy.html" target="_blank" rel="noopener"');
    expect(out).toContain('href="https://www.pigsgonnablow.com/terms.html" target="_blank" rel="noopener"');
    expect(out).not.toContain('href="./privacy.html"');
  });

  it('the main site keeps its protections (only the copy is changed)', () => {
    expect(html).toContain('antiframeStyle');
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain('sdk.crazygames.com');
  });
});
