// Builds the CrazyGames version of the game into dist/crazygames/ (zip that folder's contents
// and upload it at https://developer.crazygames.com). Run: node tools/build-crazygames.mjs
//
// The site itself is untouched: this copies index.html + js/ and edits the copy so it meets
// CrazyGames' rules (https://docs.crazygames.com/requirements/intro/):
//   * the anti-framing guard is removed -- CrazyGames shows every game inside an iframe, and the
//     guard would otherwise keep the page blank there;
//   * the Content-Security-Policy meta is removed, since it would block their SDK script and its
//     network calls (on CrazyGames the page lives on their origin, not ours);
//   * their SDK is loaded; js/portal.js reports gameplay start/stop to it;
//   * the Supabase script is left out, so sign-in, shop, skins and leaderboard all switch off
//     (external logins and our own payments aren't allowed there), and their UI is hidden;
//   * the Privacy/Terms links are hidden (no outbound links; nothing personal is collected here);
//   * no service worker, manifest or other site-only files are shipped.
// Play counts aren't reported from there either: js/stats.js only reports from pigsgonnablow.com.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'dist/crazygames');
const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
const SITE = 'https://www.pigsgonnablow.com';

// Each edit must match exactly once, so a change to index.html that moves one of these fails
// the build loudly instead of shipping a half-converted page.
function replaceOnce(src, pattern, replacement, what){
  const matches = src.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'));
  if (!matches || matches.length !== 1) throw new Error(`build-crazygames: expected exactly one ${what}, found ${matches ? matches.length : 0}`);
  return src.replace(pattern, replacement);
}

export function convertIndexHtml(html){
  let out = html;
  out = replaceOnce(out, /<html lang="en">/, '<html lang="en" data-portal="crazygames">', '<html> tag');
  out = replaceOnce(out, /<meta http-equiv="Content-Security-Policy"[^>]*>\n/, '', 'CSP meta');
  out = replaceOnce(out, /<!-- The frame-ancestors 'none' above[\s\S]*?-->\n/, '', 'anti-framing comment');
  out = replaceOnce(out, /<style id="antiframeStyle">[\s\S]*?<\/style>\n<script>[\s\S]*?<\/script>\n/, '', 'anti-framing guard');
  out = replaceOnce(out, /<script id="supabaseSdkScript"[^>]*><\/script>\n<script>[\s\S]*?<\/script>\n/, '', 'Supabase script');
  out = replaceOnce(out, /<link rel="manifest" href="manifest.json">\n/, '', 'manifest link');
  // Nothing to submit to here, so the victory screen's second button just ends the run.
  out = replaceOnce(out, /FINISH &amp; SUBMIT/, 'FINISH', 'victory finish button label');
  // CrazyGames requires an in-game Privacy Policy / Terms mention. The pages aren't in the zip,
  // so link to the live site in a new tab instead of navigating the game frame away.
  out = replaceOnce(out, /href="\.\/privacy\.html"/, `href="${SITE}/privacy.html" target="_blank" rel="noopener"`, 'privacy link');
  out = replaceOnce(out, /href="\.\/terms\.html"/, `href="${SITE}/terms.html" target="_blank" rel="noopener"`, 'terms link');
  out = replaceOnce(out, /<\/head>/, `<script src="${SDK_URL}"></script>
<style>
  /* CrazyGames build: no accounts, shop, skins or leaderboard. */
  #viewLeaderboardBtn, #viewShopBtn, #viewMySkinsBtn, #accountBox,
  #scoreSubmitBox, #scoreSubmitStatus, #leaderboardBox { display:none !important; }
  /* CrazyGames tests at 800x450 and wants players one click from gameplay: drop the long story
     and level paragraphs so START fits on screen; the two control lines stay. */
  #overlay > p:nth-of-type(2), #overlay > p:nth-of-type(5) { display:none !important; }
  /* Keep the required Privacy/Terms links on screen at 800x450 without pushing START down. */
  #privacyLinks { position:fixed; right:10px; bottom:6px; margin:0 !important; z-index:5; }
</style>
</head>`, '</head>');
  return out;
}

export function build(){
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  mkdirSync(resolve(OUT, 'js'), { recursive: true });
  writeFileSync(resolve(OUT, 'index.html'), convertIndexHtml(readFileSync(resolve(ROOT, 'index.html'), 'utf8')));
  // Every game module except the vendored Supabase client.
  cpSync(resolve(ROOT, 'js'), resolve(OUT, 'js'), { recursive: true, filter: (src) => !src.includes('/vendor') });
  cpSync(resolve(ROOT, 'icon-192.png'), resolve(OUT, 'icon-192.png'));
  return OUT;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('Built', build());
}
