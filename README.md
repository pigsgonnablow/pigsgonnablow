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

## Deploying a schema change (Supabase)
The `supabase_*.sql` files in the repo root are the source of truth `tests/sql/` runs against
(see below) -- keep editing/adding those as before. To actually apply a change to the live
project, use the Supabase CLI (installed as a dev dependency, so `npx`/`npm run` reach it with
no global install) instead of pasting into the SQL Editor by hand:

```
cp supabase_whatever_schema.sql supabase/migrations/$(date +%Y%m%d%H%M%S)_whatever_schema.sql
npm run db:diff   # supabase db push --dry-run -- shows what WOULD run, touches nothing
npm run db:push   # supabase db push -- actually applies it, and only what hasn't run yet
```

`supabase migration list` shows which migrations are applied locally vs. on the live project --
useful for confirming a fix you committed actually made it to the database (this is what
surfaced, on 2026-09-26, that an earlier round of hardening had been committed but never
actually run). Every file here needs to be safe to re-run (idempotent): `create table if not
exists`, `create or replace function`, `drop policy if exists` before `create policy` (Postgres
has no `create policy if not exists`), `alter table ... add column if not exists`, etc. -- the
existing files are all written this way; keep new ones consistent.

Edge Function code changes need their own deploy, independent of both the above and of
`git push` (which only updates the static site via GitHub Pages):
```
npx supabase functions deploy stripe-webhook --no-verify-jwt
npx supabase functions deploy create-checkout
```

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
  functions (levels, scoring, shockwave/coin/jump tuning, hit detection, pickup/feed radii, the
  coin-batch bonus heart, wind gusts, burger spawning). Randomness is passed in as an `rng`, so
  tests script exact outcomes. **To change a rule, change it there and update its test**;
  `index.html` only holds state, input and drawing. The tests assert caps/floors/boundaries
  against the exported constants, so retuning a number doesn't break them -- only values marked
  `pinned:` are literal.
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
