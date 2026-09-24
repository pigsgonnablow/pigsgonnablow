# Cheeseburger Dragon vs. The Exploding Pig

An installable browser game (PWA). Dragon feeds a pig cheeseburgers, pig explodes, chaos ensues.

## Play it locally
Just open `index.html` in a browser. For the service worker / install prompt to work
properly, serve it over a local server rather than opening the file directly:

```
python3 -m http.server 8000
```
then visit `http://localhost:8000`.

## Deploy to GitHub Pages
1. Push this folder's contents to the **root** of a GitHub repo (see commands below).
2. On GitHub: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**,
   branch `main`, folder `/ (root)`. Save.
3. GitHub gives you a URL like `https://yourusername.github.io/repo-name/`.
4. Open that URL in Chrome on Android → menu (⋮) → **Install app** (or you'll see an
   "Add to Home Screen" banner automatically).

## Tests
The game itself has no build step, but there's dev-only test tooling (`npm install` once):

```
npm test         # vitest: browser modules (jsdom), service worker, index.html tripwires,
                 #   and the supabase_*.sql files run against an in-process Postgres (PGlite)
npm run test:fn  # Deno: the stripe-webhook and create-checkout handlers with a faked Stripe + Supabase
npm run test:all
```

- `tests/sql/` applies the real `supabase_*.sql` files in order and attacks the result as
  `anon` / `authenticated` -- both the write side (direct writes to `profiles`/`scores`/
  `owned_skins`, tampering with the `skins` catalog's prices) and the read side (whose
  profile/entitlement rows each role can actually see). **When you add a schema file, add it
  to `SCHEMA_FILES` there** (the lockdown file must stay last).
- `tests/unit/sw.test.js` fails if a file in `sw.js`'s `ASSETS` changed without a
  `CACHE_NAME` bump (compares against `HEAD` locally, the merge base in CI), and runs the
  real `install`/`activate`/`fetch` handlers against a fake `CacheStorage`.
- `tests/unit/rules.test.js` tests the game's rules, which live in `js/rules.js` as plain
  functions (levels, scoring, shockwave/coin/jump tuning, hit detection, the coin-batch bonus
  heart, wind gusts, burger spawning). Randomness is passed in as an `rng`, so tests script
  exact outcomes. **To change a rule, change it there and update its test**; `index.html` only
  holds state, input and drawing. The tests assert caps/floors/boundaries against the exported
  constants, so retuning a number doesn't break them -- only values marked `pinned:` are literal.
- `tests/unit/movement.test.js` tests the dragon's input/movement math, which lives in
  `js/movement.js` the same way: combining keyboard + joystick input (including the joystick
  deadzone), the frame-rate-independent velocity/pitch easing, clamping to the world rect, the
  joystick's own pointer-to-vector clamp, and the letterbox-aware anchoring shared by the
  joystick/throw button overlays. `index.html` still owns the actual `keys`/joystick/DOM state.
- `tests/unit/index-html.test.js` is static source tripwires -- the inline game script can't be
  imported. Among others it fails if a new per-run state variable is added without being reset
  in `resetGame()`, and if a secret-shaped token (`sk_live_`, `whsec_`, `sb_secret_`,
  `service_role`) ever appears in a browser-shipped file. The game loop and drawing are still
  untested; check those by playing.
- `supabase/functions/{stripe-webhook,create-checkout}/handler.ts` hold the function logic so it can be tested;
  `index.ts` only wires real clients into it.
- CI (`.github/workflows/test.yml`) runs all of the above on every push/PR to `main`.

## Files
- `index.html` — the game
- `manifest.json` — PWA metadata (name, icons, colors)
- `sw.js` — service worker, caches assets for offline play
- `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` — app icons
