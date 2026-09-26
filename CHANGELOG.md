# Changelog

Running log of notable changes, kept during dev sessions for reference.

## 2026-09-26 (closing the two deferred issues from the 2026-09-24 security review)

Both items explicitly deferred two days ago, now fixed:

- **Webhook idempotency didn't survive a delete-based revoke.** `stripe-webhook` used to DELETE
  an `owned_skins` row on `charge.refunded`/`charge.dispute.created` -- but Stripe redelivers
  webhook events for up to ~3 days on anything but a 2xx, and the grant path is a plain upsert
  keyed on `(user_id, skin_id)`. Once the row was gone, a redelivered copy of the *original*
  grant event landed on an empty primary-key slot and silently re-granted a skin whose payment no
  longer held. Fixed by tombstoning instead of deleting: `owned_skins` gets a new `revoked_at`
  column (`supabase_lockdown_direct_writes.sql`, alongside the matching `equip_skin` ownership-
  check update so an equip can't survive its own refund), and grants now go through a new
  `grant_owned_skin()` function (`supabase_owned_skins_revocation.sql`) that refuses to resurrect
  a row revoked under the exact same checkout session -- while still allowing a genuine
  repurchase (a new session id) after a refund to grant normally. `js/shop.js`/`js/myskins.js`/
  `create-checkout` all updated to filter `revoked_at is null` when reading ownership. Covered by
  new tests in `tests/sql/lockdown.test.js` (the real enforcement layer) and
  `tests/functions/stripe-webhook.test.ts`.
- **`create-checkout`'s "already own" check was check-then-act.** Two requests for the same skin
  fired close together (double-click, a retried fetch, two browser tabs) could both pass the
  ownership check before either had created a Checkout Session, each getting its own session and
  letting the buyer be charged twice for one skin (the webhook's grant is idempotent per *skin*,
  not per *charge* -- a second payment would just be silently absorbed, not refused). Fixed with
  a stable Stripe idempotency key scoped to `user_id:skin_id`, so concurrent or retried clicks
  within Stripe's ~24h idempotency window return the same session instead of creating a new one.
  Covered by new tests in `tests/functions/create-checkout.test.ts`.

Cache bumped to `burger-pig-v32` (`js/shop.js`/`js/myskins.js` changed).

Still open, unrelated to this pass: COPPA/children's-privacy risk, no Terms of Service/refund
policy, jsdelivr CDN single point of failure, no global error handler on the game loop -- all
flagged by the original 4-agent readiness review, none of them code fixes a security pass can
make unilaterally.

## 2026-09-24 (public-readiness hardening, from an adversarial security review)

An adversarial pass (building and running real exploit attempts against the local PGlite test
harness, not just reading the code) found two issues worth fixing before wider traffic:

- **The public leaderboard was trivially, permanently defaceable.** The anon insert policy on
  `scores` had no rate limit and a 1,000,000 score ceiling ~100x above anything reachable by
  real play -- verified live at 50 max-score rows inserted in 15ms using nothing but the
  published anon key, which took over the entire top-10 query. Fixed in
  `supabase_lockdown_direct_writes.sql`: a second, tighter `scores.score <= 100000` check
  constraint (still generous for a genuinely long run -- the game has no hard end), plus a
  global rate-limit trigger on the anon insert path (signed-in `submit_personal_best()` writes
  are exempt -- they're already capped to one row per account by the unique index, so there's
  nothing to flood). Covered by new tests in `tests/sql/lockdown.test.js`.
- **`frame-ancestors 'none'` in the CSP does nothing.** It's delivered via `<meta>`, and the CSP
  spec explicitly ignores `frame-ancestors` (and `report-uri`/`sandbox`) outside a real HTTP
  header -- which GitHub Pages can't send. The site was actually framable (clickjacking risk
  against sign-in/BUY), and a test asserted the directive "forbids framing," encoding the false
  assurance into the suite. Fixed with an inline frame-buster script (`index.html`) and a
  corrected, honest test.
- **Defense-in-depth gap on `skins`/`owned_skins`**: unlike `scores`/`profiles`, these two were
  protected by RLS alone, with the default broad Supabase grants never revoked behind it --
  every write was already rejected, but only because no policy allowed it, not because the
  privilege was gone too. Added the matching `revoke`s plus `FORCE ROW LEVEL SECURITY` on both
  (safe there specifically because nothing legitimate ever writes to either table as the table
  owner, unlike `scores`/`profiles`, whose security-definer RPCs do -- forcing RLS on those two
  is deliberately left alone to avoid breaking `submit_personal_best`/`set_display_name`/
  `equip_skin`). Also revoked the latent (not PostgREST-reachable, but real) `DELETE`/`TRUNCATE`
  privilege anon/authenticated still held on `scores`/`profiles`.

Cache bumped to `burger-pig-v31`. Also reviewed and found solid (no changes needed): price
integrity, webhook signature verification and livemode checks, partial-refund handling,
delayed-payment-method handling, RPC argument fuzzing (negative/huge/malformed scores all
rejected at the DB layer), forged JWT claim shapes, PostgREST cross-table join reads, and a full
XSS sink sweep of the entire client (no `innerHTML`/`textContent` injection point found).

Known, deliberately deferred (real but lower-severity, tracked for later): webhook idempotency
doesn't survive a delete-based revoke (a replayed grant after a refund can re-grant a skin, and
vice versa) -- fixable by tombstoning `owned_skins` rows instead of deleting them;
`create-checkout`'s "already own" check is check-then-act, so two concurrent sessions for the
same skin can produce a double charge with only one grant recorded.

## 2026-09-24 (dead code cleanup + movement math extraction)

- Removed `sw.js`'s `.catch(() => cached)` tail on the fetch handler: `cached || fetch(...)`
  already short-circuits before `fetch()` runs whenever `cached` is truthy, so by the time that
  `.catch` could fire, `cached` was always falsy -- it could only ever resolve to `undefined`
  instead of surfacing the real network failure. Fully offline with nothing cached now rejects
  as a real error, like it should have all along. Added a regression test for this.
- Dropped the dead `profiles_insert_own` / `profiles_update_own` RLS policies, in
  `supabase_lockdown_direct_writes.sql` (same file and same reasoning as the already-dropped
  `scores_own_insert` / `scores_own_update`): once that file revokes INSERT/UPDATE on
  `profiles` from `anon`/`authenticated` outright, no policy on those commands is ever
  reachable. Added the matching `pg_policies` regression test.
- **Movement math extracted into `js/movement.js`.** Input resolution (keyboard vs. joystick,
  including the joystick deadzone), the frame-rate-independent velocity/pitch easing, and the
  world-bounds clamp moved out of `index.html`'s `update()` into plain, tested functions --
  same pattern as the `js/rules.js` extraction below. Verified with `tests/unit/movement.test.js`
  plus a 100,000-frame differential check against the original inline formulas (all exact
  matches) before wiring it in. `index.html` still owns `keys`/joystick DOM state and calls into
  these instead of computing the formulas itself. Cache bumped to `burger-pig-v28`.
- **Joystick clamp + letterbox-anchored overlay positioning extracted too**, into the same
  `js/movement.js`: the joystick's pointer-offset-to-vector clamp, and the shared
  bottom-anchoring math the joystick/throw-button overlays use to sit in the letterbox strip
  below the canvas instead of on top of the game (previously duplicated between the two, and
  the exact class of bug that was fixed once already). Verified with a 60,000-case differential
  check against the original inline formulas -- all exact matches. Cache bumped to
  `burger-pig-v29`.
- **Pickup/feed hit radii extracted into `js/rules.js`**: `pickupRadius` (ground-burger pickup
  and landed-coin pickup previously repeated the same `dragon.size*0.55+14` literal
  independently -- now one function, so they can't drift apart), `meleeFeedRadius` (walk-in
  feed) and `projectileFeedRadius` (thrown-burger feed). Verified with a 60,000-case
  differential check against the original inline formulas -- all exact matches. Cache bumped to
  `burger-pig-v30`.

## 2026-09-21 (game rules moved out of index.html)

The game's rules used to live inline in `index.html`'s one big script, tangled with canvas/DOM
calls, so nothing could be tested and a tweak meant playing a run to see what changed. They're
being moved, stage by stage, into `js/rules.js` -- plain functions and constants (randomness is
passed in as an `rng`), covered by `tests/unit/rules.test.js`. **No behaviour change**: each
stage was checked by driving the real game in a browser through 16 full pig cycles and
comparing every value against the original formulas.

- **Stage 1 -- tuning constants + progression formulas.** Level, victory threshold, dragon
  growth, shockwave radius/speed, coin lifetime and count, pig jump window, burgers-to-fill,
  feed/coin scoring, `formatTime`, `angleToArrow`. Added `js/rules.js` to `sw.js` `ASSETS`;
  cache `v22` -> `v23`.

- **Stage 2 -- coin batches (clean sweep = bonus heart).** The per-batch bookkeeping is now
  `createCoinBatches()` (`start`/`collect`/`expire`/`reset`). Verified identical to the original
  over 300,000 random pickup/expiry sequences, then in the real game (sweep with a heart to
  regain, sweep at full lives, one expired coin ruining a batch, overlapping batches).
  Cache `v23` -> `v24`.

- **Stage 3 -- combat and the pig's jump.** `shockHits` (the ring hit test), `knockedBack`,
  `jumpTarget`/`jumpPosition` (where the pig lands and its arc), `pigVisualScale` (drawn size =
  hit reach) and `canThrow`, plus the cooldown/invulnerability/knockback constants. Verified
  identical to the original over 1.2M randomized comparisons, then in the real game (getting
  hit, invulnerability, wall clamping, game over, landing on an edge-clamped target, throw
  gating). Cache `v24` -> `v25`.

- **Stage 4 -- burgers and wind.** `pickBurgerSpot`, `rollGolden`, `shouldSpawnBurger`,
  `nextSpawnDelay`, and the wind gust state machine as `createWindGusts(rng)` (`reset`/`update`;
  only *starting* a gust is blocked while the pig jumps/explodes, one already blowing carries
  on). Randomness is injected, so the tests script exact schedules. Verified against the
  original with the same seeded random stream over ~4.9M comparisons, then in the real game
  (no wind below level 5, a gust starting/pushing exactly 1.8px/frame/ending, indicator, a
  frame drawn mid-gust, golden level gate and one-at-a-time, spawn cap). Cache `v25` -> `v26`.

- **Stage 5 -- new-run reset audit (and one tiny behaviour fix).** Diffed every state variable
  between a fresh run and a long messy run followed by `resetGame()`. Two leaked: `shakeTimer`
  (only decays while running, so dying mid-explosion could start the next run with a few frames
  of leftover screen shake) and `shockRadius`; both are now reset. The rest are deliberately
  not per-run (`startTime`/`running` are set by the start/end handlers, `glowClock` is a
  free-running animation clock, `gustScreenAngle` only matters mid-gust, the dragon skin comes
  from the profile). A test now fails if a new state variable is added without being reset.
  Cache `v26` -> `v27`.

## 2026-09-21 (more tests)

A second pass over the test suite, filling the gaps the first one left. No production code
changed -- every finding below is a test, not a fix. 111 -> 151 vitest tests, 59 -> 60 Deno
tests. Each new regression test was mutation-checked (the bug it guards against was
re-introduced, the test confirmed to fail, the file restored).

- **Read-side RLS is now attacked too, not just the write side.** The existing SQL suite
  proved a client can't *write* `profiles`/`scores`/`owned_skins`; it never checked what a raw
  PostgREST GET can *see*. Added: `authenticated` can only read its own `profiles` row and
  `anon` none at all; an account can't see anyone else's `owned_skins` (who bought what), and
  `anon` sees none; the `skins` catalog stays publicly readable (the shop renders before
  sign-in).
- **The `skins` catalog is now covered as an entitlement surface.** `equip_skin` only demands
  ownership when `price_cents > 0`, so a client able to write the catalog could set a paid
  skin's price to 0 and equip it free -- without touching either of the two tables the
  lockdown file concentrates on. Tests confirm a signed-in client can't update a price,
  re-activate the retired griffin, insert a free clone of a paid skin, delete a catalog row,
  or delete its own `owned_skins` entitlement row.
- **Guest score bounds.** `js/leaderboard.js` trims names to 12 characters and only ever
  submits what the run scored, but neither is a control -- `anon` can POST to `/rest/v1/scores`
  directly. Tests now confirm the server rejects a 13-character or empty name and a score
  outside 0..1,000,000, and accepts a legitimate row at the limits.
- **One row per account, forever.** `scores_user_id_unique` must stay a *plain* index (a
  partial one can't be inferred by `ON CONFLICT (user_id)` -- that's the bug that broke every
  signed-in submit on 2026-08-18) and must still allow unlimited anonymous NULL rows. Both are
  asserted directly, plus: four submits from one account still leave exactly one row.
- **Service worker: `install`/`activate` now actually run.** Previously only the fetch
  handler's origin/method filtering was tested. Added, against a fake `CacheStorage`: install
  precaches exactly the `ASSETS` list into the current cache; activate deletes every *other*
  cache and keeps the current one (this is what makes a `CACHE_NAME` bump take effect at all);
  a cache hit is served without touching the network; and a failed (404/500) response is never
  written to the cache, which would otherwise poison offline mode for that asset until the
  next bump.
- **`auth.onChange` fires synchronously.** index.html depends on this (the account widget must
  render something on first paint), and it's why `dragonEmoji`/`dragonFilter`/`dragonIsRed`
  have to be declared *above* the registration -- the temporal-dead-zone `ReferenceError` that
  killed every button on the page on 2026-08-20. Now pinned from both sides: a unit test on the
  synchronous contract, and a tripwire that the three declarations precede the one
  `auth.onChange(` in index.html.
- **index.html tripwires**: the post-Checkout `?checkout=` handler still chains `shop.render()`
  off `authReady` (the 2026-08-20 race that rendered every Owned/Equipped row wrong for a buyer
  returning from Stripe) and still strips the query param; and no browser-shipped file
  (`index.html`, `sw.js`, `js/*.js`) contains a secret-shaped token -- a service-role key or
  Stripe secret pasted in where the publishable key goes would hand every visitor full database
  access, and nothing in a browser would complain.
- **Leaderboard/shop/auth gaps**: a guest's own row is highlighted by name *and* score after
  submitting (a same-name stranger's row must not steal it); a new run resets the submit box so
  the next score can still be submitted; a stale `shop.render()` never overwrites a newer one
  (the same race the leaderboard shipped for real, and the exact path a post-Checkout return
  takes); and a `profiles` fetch that errors *or throws* still leaves the widget in the safe
  "signed in, pick a name" state rather than blank.
- **stripe-webhook**: `checkout.session.async_payment_failed` grants nothing, even though it
  carries a full, otherwise-grantable session -- the only thing stopping it is that its event
  type isn't matched.
- **Known gap, deliberately not covered**: the game itself (scoring, levels, the coin-batch
  bonus-heart rule, hit detection, wind gusts) lives in one inline module inside `index.html`
  and cannot be imported, so it has no behavioural tests -- only the static tripwires above.
  Covering it properly means extracting the rules into `js/` modules, which is a real refactor,
  not a test change.

## 2026-09-20 (tests + review follow-ups)

- **stripe-webhook: permanent failures on a paid session no longer loop.** An unknown
  `skin_id`/user (Postgres FK violation `23503` on the grant), an unexpected session shape, or
  missing metadata used to return 500/400, so Stripe retried a delivery that could never
  succeed for ~3 days. They now return 200 and log `ACTION REQUIRED: paid session NOT granted`
  with the session, payment_intent, amount and metadata -- money was taken and nothing was
  granted, so search the function logs for that string and refund/grant by hand. Any other DB
  error still returns 500 (transient, worth retrying); bad signatures and livemode mismatches
  still return 400. **Needs a redeploy of the function to take effect.**
- **create-checkout tests.** Same refactor as the webhook: logic moved from `index.ts` into
  `handler.ts` (`createHandler`), `index.ts` is a thin wrapper, no behaviour change (so the
  deployed function doesn't need a redeploy). 26 Deno tests cover auth (401s), the purchasable/
  already-owned checks, that identity and price come from the session/catalog and never the
  request body, the session parameters, CORS on every response, and the generic 500.
  Also: a request body that isn't a JSON object now gets a 400 ("Invalid request body.")
  instead of the generic 500.
- **First automated tests.** Added `package.json` (dev-only), vitest + jsdom, PGlite, a Deno
  test suite and a GitHub Actions workflow -- see the README's Tests section. Covers the
  leaderboard stored-XSS fix, the RLS/RPC lockdown (attacked for real as `anon` and
  `authenticated`), the stripe-webhook grant/revoke/livemode logic, the service-worker
  cache-bump rule, and `index.html` HUD/warning-banner and CSP tripwires.
- **`supabase_lockdown_direct_writes.sql`: `anon` could still call the three RPCs.**
  `revoke ... from public` doesn't remove Supabase's *direct* EXECUTE grant to `anon`, so the
  file now also revokes from `anon` by name. (Found while verifying the live project; already
  applied there as the `revoke_anon_execute_on_rpcs` migration.)
- **Same file: the function grants now come last.** The `revoke ... on function` lines used to
  sit before the functions they name were (re)created, which only worked because older schema
  files had already created them -- on a fresh database they would error, and a script that
  stopped there would leave the default EXECUTE grants in place.
- **stripe-webhook: a partial refund no longer revokes the skin.** `charge.refunded` fires
  for any refund; now only a full refund (`amount_refunded >= amount`) or a dispute revokes.
  The handler moved from `index.ts` into `handler.ts` (`createHandler`) so it's testable; no
  other behaviour change. **Needs a redeploy of the function to take effect.**

## 2026-09-18 (adversarial review fixes)

A second, adversarial pass on the previous entry's fixes found the privilege-escalation
fix was incomplete, plus a few smaller gaps. Fixed here:

- **`supabase_lockdown_direct_writes.sql` only closed half the hole.** It revoked
  `profiles` UPDATE but not INSERT -- a brand-new signed-in account (before its profile
  row exists) could still `POST /rest/v1/profiles` directly with `equipped_skin_id:
  'dragon-red'` and get the paid skin for free, same as the already-fixed UPDATE path.
  Also, the fix as first written would have broken signup entirely: `js/auth.js`'s
  `setDisplayName` did a client-side `.upsert(...)`, which PostgREST compiles into an
  `INSERT ... ON CONFLICT DO UPDATE SET user_id = EXCLUDED.user_id, ...` -- Postgres checks
  UPDATE privilege on every column in that SET list, including `user_id`, whether or not a
  conflict happens, so revoking UPDATE down to just `display_name` would have made every
  first-time profile creation fail with a permission error. Rewrote the migration to revoke
  INSERT and UPDATE on `profiles` entirely and added a new `set_display_name()` RPC
  (security definer, always writes `auth.uid()` itself) for `js/auth.js` to call instead.
- Neither RPC explicitly revoked its default `PUBLIC`/`anon` EXECUTE grant (Postgres grants
  that automatically on `CREATE FUNCTION`). Not currently exploitable (both already check
  `auth.uid()`), but the migration now revokes `PUBLIC`/`anon` explicitly and adds an
  unconditional `if auth.uid() is null then raise exception` guard to all three RPCs, so
  that's a property of the function itself rather than an accident of what happens to
  return zero rows.
- `set search_path` on the security definer functions now includes `pg_temp` (searched
  first by default) alongside `public`, closing the search-path-hijack vector for real
  rather than just documenting an intent to.
- **Refund/chargeback abuse**: buy a skin, then refund or dispute the charge, and the
  entitlement used to stay granted forever -- nothing ever revisited `owned_skins` after
  the initial grant. `supabase/functions/stripe-webhook/index.ts` now also handles
  `charge.refunded`/`charge.dispute.created`: resolves the original checkout session from
  the charge's `payment_intent`, deletes the `owned_skins` row, and falls back the account
  to the free default skin if the revoked one was actually equipped. Both the sandbox and
  live Stripe webhook endpoints have been updated (via the Stripe API) to actually send
  these two event types -- **the Edge Function itself still needs `supabase functions
  deploy stripe-webhook --no-verify-jwt` run against it to pick up this code change.**
- Added a `event.livemode` vs. configured-key check in the webhook as defense-in-depth
  against a test-mode event ever granting a real entitlement, in case the two Stripe
  webhook secrets (sandbox/live) were ever mixed up.
- Added a Content-Security-Policy meta tag to `index.html` (defense-in-depth, not the
  primary fix -- the actual leaderboard XSS sink was already removed) pinning `connect-src`
  to this project's own Supabase URL and disallowing everything not explicitly needed.
  Verified locally: no CSP violations, Supabase CDN script and gameplay unaffected.
- Bumped `sw.js`'s cache version (v21 -> v22) since `index.html` changed again.

**Still needs to be done before this is actually live:** run the updated
`supabase_lockdown_direct_writes.sql` in the Supabase SQL Editor (supersedes the version
from the previous entry -- safe to re-run even if that one was already applied), and
redeploy the `stripe-webhook` Edge Function so it picks up the refund-handling code and
livemode check.

## 2026-09-18 (pre-1.0 review fixes)

Found by an Opus-driven security/correctness pass ahead of calling this v1.0. Two real
holes, plus two loose ends from the day's earlier fixes:

- **Stored XSS on the leaderboard.** `js/leaderboard.js`'s `renderInto` interpolated a row's
  `name`/`color_filter` straight into an HTML string; `shop.js`/`myskins.js` already avoided
  this (set `.style.filter` as a real DOM property) but `leaderboard.js` never got the same
  treatment. Since a signed-in player's own `color_filter` was directly writable (see next
  item), this was a real stored-XSS vector against every leaderboard viewer. Rewrote
  `renderInto` to build rows via `createElement`/`textContent` instead of an HTML string.
- **Paid skins could be equipped for free, and scores forged, via a raw API call.**
  `profiles_update_own`/the default `scores` insert/update grants let a signed-in client
  write *any* column on their own row directly -- not just the ones the app's own RPCs
  (`equip_skin`, `submit_personal_best`) intend to control. That meant `equipped_skin_id`/
  `color_filter` could be set directly, skipping `equip_skin`'s ownership check entirely (no
  purchase required), and `scores`/`color_filter` could be forged the same way `name`
  already couldn't be. New file `supabase_lockdown_direct_writes.sql` (**needs to be run in
  the Supabase SQL editor**) revokes the broad grants down to only the columns a direct
  client write should ever touch, and marks both RPCs `security definer` so they keep
  working (they already re-check ownership internally via `auth.uid()`).
- The ember-trail commit changed `index.html` without bumping `sw.js`'s cache version --
  bumped now (v20 -> v21) so returning/installed-PWA players actually get it.
- The HUD-hiding pass from earlier today missed `#warning` (the "PIG'S GONNA BLOW!" / level-
  up / bonus banner) -- it lives outside `#hud` so the hide-on-menu fix didn't cover it.
  Could still ghost through the title/game-over overlay (e.g. hitting EXIT mid-banner). Now
  hidden alongside the HUD in `endGame`, `showVictoryScreen`, and the exit handler.

## 2026-09-18 (later)

- Gave the Dragon - Red skin ($1.99) an actual visual identity instead of just being the
  base dragon glyph run through a CSS recolor filter with nothing else added. It now trails
  small fire embers while moving (color-shifts from bright yellow-white to orange to
  cooling red as each one fades, using the same world-space z-height mechanic the ground
  burgers' bob already relies on so the embers visibly rise regardless of iso skew) plus a
  faint pulsing ember-glow halo under the dragon at all times, gated on a new `dragonIsRed`
  flag (`profile.equipped_skin_id === 'dragon-red'`) rather than string-matching the color
  filter. (`sw.js`'s cache version bump for this change collapsed into the same v20 bump
  as the HUD correction below, since both branches were merged together.)

## 2026-09-18 (correction)

- Corrected the previous entry's fix for HUD text bleeding through the title/pause/
  game-over overlay. Making `#overlay` fully opaque did stop the bleed-through, but it
  also killed an intentional effect: the game's background scene (sky, grass, idle pig)
  was meant to show faintly through the overlay too, not just get blocked along with the
  HUD. Real bug was that `#hud` had no hidden state of its own -- it relied entirely on
  the overlay's opacity to visually cover it, and was never actually removed from the
  render. Reverted `#overlay` to its original translucent background and instead gave
  `#hud` its own `hidden` class, toggled at every point the game already starts/stops
  (`startBtn`, `restartBtn`, `resumeAfterVictory`, `endGame`, `showVictoryScreen`,
  `exitBtn`) plus a default `hidden` in the markup for the initial title-screen load.
  Bumped `sw.js`'s cache version (v19 -> v20) since `index.html` changed again.

## 2026-09-18

- Fixed the title/pause/game-over overlay (`#overlay`) letting the live gameplay HUD
  (score, hearts, level) visibly bleed through behind its text. It was using a translucent
  background (`rgba(10,15,30,0.88)`) instead of a solid one, so `#hud` -- which is never
  actually hidden, just visually covered by the overlay -- showed through at ~12% opacity.
  Found while testing the mobile layout at a 390px-wide viewport. Switched to a solid
  `#0a0f1e` background. Bumped `sw.js`'s cache version (v18 -> v19) since `index.html`
  changed again.

## 2026-09-16

- Fixed the LEADERBOARD/SHOP/MY SKINS button row looking visually unbalanced under the
  START button on the title screen. It wasn't actually a centering bug -- pixel-measured
  the reported screenshot and confirmed START and the row's bounding box share the exact
  same horizontal center -- but the three buttons were very different widths
  (LEADERBOARD ~189px vs SHOP ~115px vs MY SKINS ~150px), so the row's visual weight
  leaned left even though its outer box was centered. Gave all three a shared fixed width
  (190px) and `text-align:center` so the row is actually symmetric, not just centered.
  Bumped `sw.js`'s cache version (v17 -> v18) since `index.html` changed again.

## 2026-09-15

- Added trust-signal groundwork ahead of advertising the game (`feature/trust-signals`
  branch): a `privacy.html` page (what's collected, why, third parties, contact) linked
  from the title screen's account box; meta description, Open Graph, and Twitter Card tags
  in `index.html` so shared links get a real title/description/preview image
  (`social-preview.jpg`); and a `sw.js` cache version bump (v16 -> v17, plus adding
  `privacy.html` to the precache list) since the level-system merge had changed
  `index.html` without bumping the cache version -- anyone with the game installed as a
  PWA was stuck on the pre-level-system build until this fix, since the service worker
  file itself hadn't changed and a byte-identical `sw.js` never gets redetected as an
  update. Contact address in the privacy policy (`support@pigsgonnablow.com`) is not yet
  a live inbox -- needs DNS email forwarding set up before relying on it.

## 2026-09-09

- Added a level system (`feature/level-system` branch). Each pig explosion survived was
  already tracked as `roundsSurvived` and drove continuous difficulty scaling (shock
  radius/speed, coin lifespan, burgers-to-pop) -- that counter is now surfaced as a
  "LEVEL n" HUD readout and a level-up banner, plus three gated gimmicks so the climb
  isn't pure numbers-go-up: golden burgers (double feed progress + score, capped at one
  on the field) from level 3, periodic wind gusts that shove the dragon around from level
  5 (with a compass-arrow HUD hint), and a shrinking jump-dodge window past level 8. Level
  15 triggers a victory screen with the choice to keep playing endlessly or finish and
  submit the score.

## 2026-08-25

- More small world-decoration passes, all purely cosmetic and playtested live in-browser:
  flowers and hand-drawn pebbles scattered once at load across the grass (kept clear of the
  pig/dragon spawn points); a few birds with flapping-wing silhouettes drifting across the
  sky strip, same pattern as the existing clouds; short grass-tuft strokes scattered across
  the floor to break up the flat green fill; a radial vignette darkening the floor toward
  its corners, clipped to the isometric diamond so it never bleeds into the sky; and a
  handful of small glowing dust motes drifting slowly above the ground. (Rocks are
  hand-drawn rather than the 🪨 emoji, which was rendering as a blank placeholder box on
  this system's font.)

## 2026-08-24

- Fixed signed-in highscore submission ("Couldn't submit — try again" on every game over).
  The deployed `submit_personal_best` Postgres function had drifted from the repo's schema
  file: its `select display_name, avatar, color_filter` was missing the `into v_name,
  v_avatar, v_filter` clause, so plpgsql raised "query has no destination for result data"
  on every call. Redeployed the correct function directly to the live database -- no repo
  file was out of date, only what had been pushed to Supabase.
- Lowered the burger throw cost from 5 coins to 4 (`index.html`), to lean the game a
  little more toward ranged throwing since walking a burger in for the melee feed wasn't
  landing as fun. Melee feeding still exists but is no longer the coin-optimal choice from
  the very first explosion.
- Added a round of small visual polish, playtested live in-browser: the carried burger
  now bobs above the dragon; the pig scale-punches briefly on each successful feed; landed
  coins pulse and glow while waiting to be picked up; pig explosions shake the screen; and
  the landing-shadow ring flashes faster as the pig closes in on landing, sharpening the
  "dodge now" cue.

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
