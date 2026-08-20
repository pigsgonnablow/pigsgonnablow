# Changelog

Running log of notable changes, kept during dev sessions for reference.

## 2026-08-21

- Split "pick your skin" out of the Shop into its own screen. The Shop is purchasing-only
  now: owned skins show a greyed-out "OWNED" button, everything else shows "BUY" -- no
  more EQUIP button mixed in. A new "🐉 MY SKINS" button on the title screen opens a
  screen listing only the skins the account actually owns (free skins included), where
  EQUIP actually lives. New file: `js/myskins.js`; `js/shop.js` trimmed down to drop its
  own equip logic entirely.

## 2026-08-20 (very late)

- Made recolored skins (like the red dragon) show their actual color on the leaderboard
  and in the "Playing as" account widget too, not just in the shop and in-game -- until
  now those two spots only showed the plain base glyph, since a filter-recolored skin's
  emoji is identical to the default's. `color_filter` is now denormalized onto `scores`
  the same way `avatar` already is, so this keeps working the same way for any future
  filter-based skin without further leaderboard-specific changes. New file:
  `supabase_leaderboard_color_filter_schema.sql` (needs to be run in the Supabase SQL
  editor) -- adds `scores.color_filter` and updates `submit_personal_best` to write it.

## 2026-08-20 (late night)

- Fixed a bug that had been silently breaking the entire site since the red-dragon color
  filter change earlier tonight: every button (START, SHOP, LOGIN, all of it) stopped
  responding, and the account widget always showed signed-out regardless of session
  state. Root cause: `dragonEmoji`/`dragonFilter` were declared with `let` further down
  the startup script than `auth.onChange(...)`, which -- unlike a typical event listener
  -- invokes its callback immediately and synchronously the moment it's registered (by
  design, so the account widget has a value to render right away). That callback reads
  `dragonEmoji`, so registering it before the `let` declaration had run threw a real
  temporal-dead-zone `ReferenceError`, which aborted the rest of the startup script
  before any button listeners got wired up. No error ever reached the console in a way
  that was easy to spot live, which is what made this hard to track down -- found by
  wrapping the startup script in a try/catch that recorded the thrown error to a
  `window` property for inspection after the fact. Moved both declarations above the
  `auth.onChange` call, where they belong.

## 2026-08-20 (night)

- Made the Dragon - Red skin actually look red, in the shop and in-game, instead of just
  showing the plain green dragon next to a red-circle indicator. The dragon is a single
  Unicode emoji with no separately paintable parts, so there's no way to recolor just
  specific details (e.g. the fins) directly -- instead a CSS/canvas color filter
  (grayscale -> sepia -> hue-rotate -> saturate, tuned by eye against the live glyph) is
  applied over the same base glyph wherever the equipped skin is actually rendered as the
  player's character: the shop's catalog card and the in-game sprite. New file:
  `supabase_skin_color_filter_schema.sql` (needs to be run in the Supabase SQL editor) --
  adds `skins.color_filter` / `profiles.color_filter`, updates `equip_skin` to denormalize
  it the same way it already does for `avatar`, and drops the old red-circle-plus-dragon
  placeholder emoji now that the filter does the job for real. Not yet applied to the
  leaderboard/account-widget avatar display -- those still show the plain glyph.

## 2026-08-20 (evening)

- Removed the Griffin skin from the shop, leaving Dragon (free) and Dragon - Red ($1.99)
  as the only choices. Deactivated rather than deleted -- a couple of test accounts
  already own it from testing, and deleting the catalog row outright would break the
  foreign key from their `owned_skins` rows. `active = false` already hides it
  everywhere that matters (the shop's catalog query, and `equip_skin`'s own lookup, both
  filter on it), so an existing owner can no longer re-equip it either. Also deactivated
  the matching Stripe product so it can't be purchased through any other path. New file:
  `supabase_remove_griffin_schema.sql` (needs to be run in the Supabase SQL editor).

## 2026-08-20 (later still)

- Fixed purchased skins not actually doing anything in-game. The dragon sprite drawn
  during gameplay was hard-coded to the default emoji regardless of what a signed-in
  player had equipped -- a purchase only ever showed up on the leaderboard/account
  widget, never in the game itself. `drawSingleDragon()` now reads a `dragonEmoji`
  variable kept in sync with the account's equipped skin via the existing
  `auth.onChange` listener (so it also updates immediately after equipping a different
  owned skin from the shop, no reload needed), falling back to the free default skin
  when signed out.
- Fixed a race where landing back in the shop right after a Stripe Checkout redirect
  could render every row's Owned/Equipped state wrong (or blank): `auth.init()` is
  fire-and-forget at startup, and the post-checkout handler was calling `shop.render()`
  without waiting for the signed-in session/profile to finish restoring first. Now waits
  on `auth.init()`'s promise before that first render.
- Bumped the service worker cache version again -- same reason as before, `sw.js` itself
  wasn't touched by the `index.html` changes above.

## 2026-08-20 (later)

- Hardened purchase verification in `stripe-webhook`. It now only grants a skin once
  Stripe actually confirms payment (`payment_status === 'paid'`) instead of granting on
  "checkout completed" alone -- for delayed payment methods (bank debit, some Klarna
  flows) "completed" can fire before the money has actually cleared, and Stripe follows
  up with a separate `checkout.session.async_payment_succeeded` event once it does.
  Subscribed the webhook to that event too, and both are handled identically. Also
  refuses to grant on a session shape that couldn't have come from our own checkout flow
  (wrong mode, zero/missing amount), and cross-checks the charged amount against the
  catalog's current price -- not a gate (what Stripe actually charged is always the
  source of truth), just something that makes a price drift loudly visible in logs
  instead of silently invisible. New file: `supabase_purchase_audit_schema.sql` (needs
  to be run in the Supabase SQL editor) -- adds `owned_skins.amount_paid_cents` and
  `.currency`, an audit trail of what was actually charged straight from Stripe's own
  session data, independent of whatever the catalog says today.

## 2026-08-20

- Wired up real skin purchasing (Stripe sandbox). Priced skins in the shop now show a
  working "BUY" button instead of "COMING SOON": it calls a new Supabase Edge Function,
  `create-checkout`, which verifies the caller's session server-side and creates a Stripe
  Checkout Session for that skin, then redirects the browser there. A second Edge
  Function, `stripe-webhook`, is the only thing that ever grants a skin -- it verifies
  Stripe's signature and, on `checkout.session.completed`, inserts into `owned_skins`
  using the service-role key (client code has no insert access to that table at all).
  Returning from Checkout lands back in the shop with a status message. New files:
  `supabase/functions/create-checkout/index.ts`, `supabase/functions/stripe-webhook/index.ts`,
  `supabase/config.toml`. Both functions are deployed and their secrets
  (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SITE_URL`) are configured on the
  Supabase project; `SUPABASE_SERVICE_ROLE_KEY` didn't need setting since the platform
  already provides it to every Edge Function automatically. Also bumped the service
  worker's cache version -- it wasn't itself touched by the deploy that shipped the new
  shop code, so browsers with it already installed kept serving the old cached
  `js/shop.js` (still showing "COMING SOON") until this forced a fresh install.
- Fixed `create-checkout` failing for every purchase attempt with a generic 500. Root
  cause: Stripe's account-level "Managed Payments" (on by default) requires every
  product to carry a `tax_code` so it can calculate sales tax, which the skin catalog's
  products don't have. Disabled Managed Payments for these checkout sessions rather than
  tagging every skin with a tax code it doesn't need for a cosmetic digital good.
  Verified end-to-end with a real sandbox purchase (Stripe's test card): Checkout
  completed, the webhook granted the skin, and it showed up equippable in the shop
  immediately after.

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
- Fixed the dragon's up/down pitch (added above) almost never actually showing during
  real play: it picked a single dominant axis (left/right OR up/down), and a joystick
  is almost never perfectly vertical, so up/down basically never won that comparison.
  Pitch is now driven continuously by however much vertical input there is, blending in
  even during diagonal movement, and the tilt/scale was bumped up (26°/8% -> 34%/12%)
  to read more clearly.
- Fixed the pitch direction itself being inverted (pressing "up" dove the dragon
  downward, and vice versa) on both joystick and keyboard. Root cause: the pitch
  rotation was applied inside the same canvas transform as the left/right mirror, and
  mirroring flips the visual direction of a rotation's vertical component -- so the
  rotation needed to be negated to compensate. Confirmed by working through the actual
  transform matrices, then verified live in the browser.

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
