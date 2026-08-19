# Changelog

Running log of notable changes, kept during dev sessions for reference.

## 2026-08-19

- Added an in-run "✕ EXIT" button (top-left of the HUD, under the score) that stops the
  current run and returns to the title screen.
- Added a skin shop: a "🛒 SHOP" button next to LEADERBOARD on the title screen opens a
  screen listing all catalog skins, showing Owned/Equipped state and letting a signed-in
  player equip anything they own via the `equip_skin` RPC. Buying isn't wired up yet
  (no Stripe Checkout/webhook exists server-side), so priced skins show a disabled
  "COMING SOON" button for now. New files: `js/shop.js`, `supabase_skins_schema.sql`
  (run in the Supabase SQL editor -- adds the `skins` catalog, `owned_skins`
  entitlements table, and `profiles.equipped_skin_id`; seeded with the free default
  dragon plus two Stripe-sandbox-priced test skins).
- Fixed the shop's "Equipped" state never showing (buttons stuck on "EQUIP" even for the
  currently-equipped skin). Two bugs: `auth.js` never fetched `profiles.equipped_skin_id`
  at all, and even after fixing that, `equip_skin`'s RPC writes straight to the DB while
  `auth.js` caches the profile in memory -- nothing told it to refetch after an equip.
  Added `auth.refreshProfile()`, called by the shop right after a successful equip.
- Gave the dragon 4-direction facing instead of always facing right. Left/right mirror
  the glyph horizontally (and fixed a bug where left/right were backwards, since the
  raw dragon emoji's native artwork already faces left). Up/down don't rotate the glyph
  90° (that just made it lie on its side) -- instead the dragon pitches ~26deg with a
  slight scale-up, eased in over a few frames, so climbing/diving reads as a deliberate
  bank rather than a glitch. Left/right facing persists through pure up/down input so it
  never loses its profile.
- Retuned the pig's shockwave so late-game runs stop feeling unwinnable: radius cap
  420->300 (was nearly spanning the 600px-wide play area once maxed), radius growth
  20/round->10/round, speed cap 26->20, speed growth 0.8/round->0.5/round. Also slowed
  how fast the pig needs fewer burgers to explode (feed-difficulty threshold every 120
  score->every 200 score), so the harder feed rate and the harder shockwave stop
  compounding as quickly.
- Coins now despawn slightly faster in later rounds (same round-survived counter the
  shockwave uses): 8s lifetime at the start, shrinking ~0.2s per round survived, floored
  at ~5s so it stays a mild nudge rather than becoming punishing.

## 2026-08-18

- Fixed frame-rate-dependent physics: all per-frame movement/timers in `update()` (dragon
  movement, invulnerability, projectiles, pig jump/shock/cooldown, coins, particles, spawn
  timer, clouds) now scale by real elapsed time instead of assuming a fixed 60fps, so gameplay
  speed and scores are consistent across devices/refresh rates.
- Made the pig's explosion shockwave radius smaller at the start of a run and grow more
  noticeably each explosion, to ease up the early game. `SHOCK_RADIUS_BASE` 260→170,
  `SHOCK_RADIUS_GROWTH_PER_ROUND` 15→20 (cap unchanged at 420).
- Fixed a leaderboard race condition where a just-submitted score (e.g. a new #1) could get
  wiped back out of the displayed list if the game-over screen's initial board fetch resolved
  after the post-submit fetch. Added a render generation token so stale fetches never overwrite
  newer ones, and the player's own row is now bolded with "(you!)" after submitting.
- Added optional accounts (magic-link email sign-in via Supabase Auth), from the start screen.
  Signed-in players get one persistent "personal best" row on the leaderboard (auto-submitted
  on game over, no typing) that only updates when a new score beats their stored best; playing
  a lot no longer fills the board with duplicate names. Anonymous opt-in submission still works
  unchanged for players who don't sign in. New files: `js/auth.js`,
  `supabase_accounts_schema.sql` (needs to be run in the Supabase SQL editor, and the site's
  URL added to Supabase Auth's Redirect URLs allow-list before magic links will work).
- Made the account widget's login button an actual button (was a small underlined text link)
  so it's obviously clickable.
- Hardened `js/auth.js` session/profile restore on page load: a network hiccup or stray error
  while restoring a saved session used to silently leave the account widget blank (none of
  Login / pick-a-name / Playing-as showing). Now errors are caught, logged to the console with
  an `[auth]` prefix, and the UI always falls back to a safe state instead of getting stuck.
  Root cause of the original blank-widget report not yet confirmed — flagged for follow-up if
  it recurs.
- Fixed the HUD (score/coins/timer/lives) landing in the dark letterbox bar above the canvas
  on viewports whose aspect ratio doesn't match the game's, instead of over the sky where it's
  visible. It's now anchored to the canvas's actual rendered top edge, same fix already applied
  to the joystick and throw button.
- Fixed signed-in score submission always failing with "Couldn't submit — try again."
  Root cause: `js/auth.js` and `js/leaderboard.js` were each independently creating their
  own Supabase client (`window.supabase.createClient(...)`), which Supabase flags as
  "Multiple GoTrueClient instances detected." The two clients' views of the signed-in
  session could disagree, so the submit call sometimes ran without a valid session and got
  rejected server-side. `leaderboard.js` now reuses `auth.js`'s single client via
  `auth.getClient()` instead of creating a second one. Also fixed: a failed submit used to
  leave the "TOP SCORES" list completely empty instead of still showing the current board.
  Actual root cause (confirmed via live testing): `submit_personal_best`'s `ON CONFLICT
  (user_id)` couldn't match the partial unique index from the original migration (Postgres
  requires a partial index's WHERE clause to be repeated in the ON CONFLICT target itself).
  Swapped it for a plain (non-partial) unique index, which works directly and still allows
  unlimited NULL `user_id`s (anonymous rows) since SQL never treats two NULLs as equal for
  uniqueness. Confirmed working end-to-end: signed-in submit now shows "New personal best!"
  and updates the account's row.
- Added a "🏆 LEADERBOARD" button on the start screen that shows the current top 10 in a
  standalone read-only screen, without starting a run. Refactored `js/leaderboard.js`'s
  `render()` into a reusable `renderInto(targetEl)` so both the game-over board and this new
  preview screen share the same fetch/highlight logic against different `<ol>` elements.
- Added a per-account avatar shown next to the name on the leaderboard and in the "Playing
  as" account widget. For now it's a fixed 🐉 assigned automatically at signup (no picker
  yet) — modeled as its own `profiles.avatar` column specifically so a future color/character
  picker only has to change this one value; anonymous (non-account) rows just show no avatar.
  New file: `supabase_avatars_schema.sql` (needs to be run in the Supabase SQL editor).
- Fixed a serious `sw.js` bug (production only -- the service worker doesn't register on
  localhost, so local testing never caught it): the cache-first `fetch` handler intercepted
  *every* request from the page, including cross-origin Supabase API calls, despite a comment
  claiming it only applied to "same-origin GET requests" -- the code never actually checked
  that. The first leaderboard fetch got cached and was served stale forever after, no matter
  how fresh the data on the server was. This explains every "board didn't update" symptom
  seen today, including ones the render-generation-token fix couldn't touch since the browser
  never even made a new network request. Now cross-origin and non-GET requests bypass the
  service worker entirely. Cache name bumped to force-clear any already-poisoned cached
  responses from before this fix.
