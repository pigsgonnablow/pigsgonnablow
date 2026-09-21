// The game's rules, as plain functions and constants with no DOM/canvas/Math.random() in them,
// so they can be unit-tested (tests/unit/rules.test.js) and tweaked without playing a run to
// see what changed. index.html owns state, input and drawing and calls into this.
//
// Anything that reads randomness takes an `rng` (a () => number in [0,1), like Math.random)
// as an argument instead of calling Math.random itself, so tests can feed it fixed values.
//
// "Level" is just roundsSurvived+1 dressed up with a name and a banner -- the difficulty
// knobs below (shock radius/speed, coin life, burgersToFull) scale continuously off
// roundsSurvived, so leveling doesn't need its own progression curve, only presentation and a
// handful of gated gimmicks so the climb isn't pure numbers-go-up.

// ---------- tuning ----------
export const START_LIVES = 3;
export const MAX_LIVES = 3;         // a bonus heart can't take you past this
export const START_BURGERS_TO_FULL = 5;
export const BURGER_THROW_COST = 4;

export const LEVEL_WIN = 15;            // clear this many explosions to see the victory screen
export const GOLDEN_BURGER_LEVEL = 3;   // golden burgers start appearing
export const WIND_GUST_LEVEL = 5;       // wind gusts start
export const GUST_STRENGTH = 1.8;       // px/frame at 60fps -- noticeable against the dragon's 4.2 move speed, not overpowering
export const FAST_PIG_LEVEL = 8;        // jump window starts shrinking past this level

export const JUMP_DURATION_BASE = 75;   // ~1.25s at 60fps, dragon's window to escape the landing zone
export const JUMP_DURATION_FLOOR = 45;  // never faster than ~0.75s, so it stays dodgeable
export const JUMP_DURATION_SHRINK_PER_LEVEL = 3;

export const SHOCK_RADIUS_BASE = 170;
export const SHOCK_RADIUS_GROWTH_PER_ROUND = 10;
export const SHOCK_RADIUS_CAP = 300;
export const SHOCK_SPEED_BASE = 14;
export const SHOCK_SPEED_GROWTH_PER_ROUND = 0.5;
export const SHOCK_SPEED_CAP = 20;

export const COIN_LIFE_FRAMES = 480;            // ~8s at 60fps
export const COIN_LIFE_SHRINK_PER_ROUND = 12;   // ~0.2s less per round survived
export const COIN_LIFE_FRAMES_FLOOR = 300;      // never faster than ~5s, so it stays a mild nudge

export const DRAGON_BASE_SIZE = 42;
export const DRAGON_GROWTH_CAP = 0.9;             // max +90% size (nearly double)
export const DRAGON_GROWTH_PER_EXPLOSION = 0.15;  // dragon steps up 15% bigger each time the pig blows

export const COOLDOWN_FRAMES = 40;       // pause after a shockwave before the pig can be fed again
export const HIT_INVULN_FRAMES = 90;     // grace period after taking a hit
export const SHOCK_HIT_BAND = 26;        // how far inside the wavefront still counts as "in the ring"
export const KNOCKBACK = 40;             // px the dragon is shoved away from the pig when hit
export const JUMP_ARC_HEIGHT = 110;      // visual peak height of the pig's jump, px
export const JUMP_TARGET_MARGIN_X = 50;  // the pig never lands closer than this to a side wall
export const JUMP_TARGET_MIN_Y = 0.3;    // ...or above this fraction of the field height
export const JUMP_TARGET_BOTTOM_MARGIN = 70;

export const FEED_PROGRESS = { normal: 1, golden: 2 };
export const FEED_SCORE = { normal: 10, golden: 30 };
export const COIN_SCORE = 15;
export const COIN_BASE_COUNT = 5;
export const COIN_MAX_COUNT = 9;
export const COIN_COUNT_SCORE_STEP = 50;   // one extra coin per this much score
export const BURGERS_TO_FULL_FLOOR = 3;
export const BURGERS_TO_FULL_SCORE_STEP = 200;  // one fewer burger needed per this much score

// ---------- progression ----------
// Level shown to the player: starts at 1, goes up by one per explosion survived.
export const levelFor = (roundsSurvived) => roundsSurvived + 1;

// The victory screen shows once, the first time the win threshold is reached.
export const isVictory = (roundsSurvived, wonGame) => !wonGame && roundsSurvived >= LEVEL_WIN;

// Dragon grows a bit with every explosion survived, up to a cap.
export const dragonSizeFor = (roundsSurvived) =>
  DRAGON_BASE_SIZE * (1 + Math.min(roundsSurvived * DRAGON_GROWTH_PER_EXPLOSION, DRAGON_GROWTH_CAP));

// Shockwave reach/speed for the explosion about to happen. `roundsSurvived` is the count
// BEFORE this explosion is added, i.e. the very first blow uses 0.
export function shockParamsFor(roundsSurvived) {
  return {
    maxRadius: Math.min(SHOCK_RADIUS_BASE + roundsSurvived * SHOCK_RADIUS_GROWTH_PER_ROUND, SHOCK_RADIUS_CAP),
    speed: Math.min(SHOCK_SPEED_BASE + roundsSurvived * SHOCK_SPEED_GROWTH_PER_ROUND, SHOCK_SPEED_CAP),
  };
}

// How long a landed coin sticks around, for the explosion about to happen (same
// pre-increment `roundsSurvived` convention as shockParamsFor).
export const coinLifeFramesFor = (roundsSurvived) =>
  Math.max(COIN_LIFE_FRAMES - roundsSurvived * COIN_LIFE_SHRINK_PER_ROUND, COIN_LIFE_FRAMES_FLOOR);

// The pig's jump (the dragon's warning window) only starts shrinking past FAST_PIG_LEVEL.
export const jumpDurationFor = (level) =>
  Math.max(JUMP_DURATION_BASE - Math.max(level - FAST_PIG_LEVEL, 0) * JUMP_DURATION_SHRINK_PER_LEVEL, JUMP_DURATION_FLOOR);

// Burgers needed to fill the pig; drops as the run's score climbs, but never below the floor.
export const burgersToFullFor = (score) =>
  Math.max(BURGERS_TO_FULL_FLOOR, START_BURGERS_TO_FULL - Math.floor(score / BURGERS_TO_FULL_SCORE_STEP));

// Coins flung out by an explosion.
export const coinCountFor = (score) =>
  Math.min(COIN_BASE_COUNT + Math.floor(score / COIN_COUNT_SCORE_STEP), COIN_MAX_COUNT);

// What feeding the pig one burger is worth. Golden burgers are double on both counts.
export const feedReward = (golden) => ({
  progress: golden ? FEED_PROGRESS.golden : FEED_PROGRESS.normal,
  score: golden ? FEED_SCORE.golden : FEED_SCORE.normal,
});

// ---------- combat ----------
// Is the dragon caught by the shockwave right now? The wave is a ring: you're hit if you're
// within the front edge (radius + half your size) but not so far inside it that it's already
// passed you (SHOCK_HIT_BAND) -- so standing still where the pig lands hurts, and so does
// being caught by the front, but running back inside a ring that's gone by is safe.
export function shockHits(dragon, pig, shockRadius) {
  const d = Math.hypot(dragon.x - pig.x, dragon.y - pig.y);
  return d < shockRadius + dragon.size * 0.5 && d > shockRadius - SHOCK_HIT_BAND;
}

// Where the dragon ends up after being hit: shoved KNOCKBACK px straight away from the pig,
// then kept inside the field. (Exactly on top of the pig there's no "away", so it's +x.)
export function knockedBack(dragon, pig, W, H) {
  const a = Math.atan2(dragon.y - pig.y, dragon.x - pig.x);
  const half = dragon.size * 0.5;
  return {
    x: Math.max(half, Math.min(W - half, dragon.x + Math.cos(a) * KNOCKBACK)),
    y: Math.max(half, Math.min(H - half, dragon.y + Math.sin(a) * KNOCKBACK)),
  };
}

// The pig jumps to where the dragon is standing when it launches, but never onto the very
// edge of the field.
export function jumpTarget(dragon, W, H) {
  return {
    x: Math.max(JUMP_TARGET_MARGIN_X, Math.min(W - JUMP_TARGET_MARGIN_X, dragon.x)),
    y: Math.max(H * JUMP_TARGET_MIN_Y, Math.min(H - JUMP_TARGET_BOTTOM_MARGIN, dragon.y)),
  };
}

// The pig's position part-way through its jump: straight line from start to target over
// `duration` frames, with a sine arc for height. `timer` counts down from `duration` to 0.
export function jumpPosition(start, target, timer, duration) {
  const t = 1 - Math.max(timer, 0) / duration;
  return {
    x: start.x + (target.x - start.x) * t,
    y: start.y + (target.y - start.y) * t,
    airHeight: Math.sin(t * Math.PI) * JUMP_ARC_HEIGHT,
  };
}

// The pig visibly puffs up as it's fed (up to +60% at max feedProgress), again when it's just
// been fed (`feedPunch`, 1 -> 0), and mid-jump. Used by both rendering and hit-testing so the
// "reach" matches what's drawn.
export function pigVisualScale({ feedProgress, feedPunch, jumping, airHeight }) {
  return (1 + feedProgress * 0.12) * (1 + feedPunch * 0.2) * (jumping ? 1 + (airHeight / JUMP_ARC_HEIGHT) * 0.25 : 1);
}

// A burger can be thrown while carrying one, with coins to pay for it, once the run is going
// and the pig is idle (not mid-jump, exploding or cooling down).
export const canThrow = ({ running, carrying, pigState, coins }) =>
  running && carrying && pigState === 'idle' && coins >= BURGER_THROW_COST;

// ---------- presentation helpers ----------
// m:ss.s, e.g. 83400 -> "1:23.4"
export function formatTime(ms) {
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return m + ':' + s.toFixed(1).padStart(4, '0');
}

// World-space angle -> nearest compass-arrow glyph, purely for the wind gust HUD hint.
export const COMPASS_ARROWS = ['➡️', '↘️', '⬇️', '↙️', '⬅️', '↖️', '⬆️', '↗️'];
export function angleToArrow(a) {
  const norm = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return COMPASS_ARROWS[Math.round(norm / (Math.PI / 4)) % 8];
}

// ---------- coin batches ----------
// Every explosion flings a "batch" of coins. Grabbing ALL of a batch before any of its coins
// expires is a clean sweep, worth a bonus heart (if the player has one to regain). This tracks
// that per batch id; the game keeps a batch id on each coin and reports pickups/expiries here.
//
//   start(count)  -> id   a new batch of `count` coins
//   collect(id)   -> true if this pickup completes a clean sweep (reported at most once per batch)
//   expire(id)           a landed coin timed out uncollected -- the batch can no longer be swept
//   reset()              new run: forget everything, ids start over
//
// (`failed` and `rewarded` are belt-and-braces kept from the original inline version: an expiry
// consumes a coin so `collected === total` can never be reached afterwards, and it can only be
// reached once. Removing them wouldn't change behaviour; they just make the intent explicit.)
//
// A batch is forgotten once every one of its coins has been collected or has expired, and
// calls for an unknown id (a stale coin) are ignored. Whether the heart is actually awarded
// (lives < MAX_LIVES) is the caller's call -- a sweep at full lives is still "used up".
export function createCoinBatches() {
  let lastId = 0;
  let batches = {}; // id -> { total, collected, remaining, failed, rewarded }

  function settle(id, batch) {
    batch.remaining--;
    if (batch.remaining <= 0) delete batches[id];
  }

  return {
    start(count) {
      const id = ++lastId;
      batches[id] = { total: count, collected: 0, remaining: count, failed: false, rewarded: false };
      return id;
    },
    collect(id) {
      const batch = batches[id];
      if (!batch) return false;
      batch.collected++;
      let sweep = false;
      if (!batch.failed && !batch.rewarded && batch.collected === batch.total) {
        batch.rewarded = true;
        sweep = true;
      }
      settle(id, batch);
      return sweep;
    },
    expire(id) {
      const batch = batches[id];
      if (!batch) return;
      batch.failed = true;
      settle(id, batch);
    },
    reset() {
      lastId = 0;
      batches = {};
    },
    // read-only peek, for tests
    has: (id) => id in batches,
  };
}
