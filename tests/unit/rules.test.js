import { describe, it, expect } from 'vitest';
import * as R from '../../js/rules.js';

// These test the game's rules, not the numbers: caps, floors, monotonicity and boundaries are
// asserted against the exported constants, so retuning a knob doesn't break them -- breaking a
// rule does. The few "pinned" values are literal on purpose: they're the player-facing feel of
// the game, so changing one should be a deliberate edit here too.

const range = (n) => Array.from({ length: n }, (_, i) => i);

describe('progression', () => {
  it('level is rounds survived + 1', () => {
    expect(R.levelFor(0)).toBe(1);
    expect(R.levelFor(14)).toBe(15);
  });

  it('victory triggers once: at the win threshold, never again after it was shown', () => {
    expect(R.isVictory(R.LEVEL_WIN - 1, false)).toBe(false);
    expect(R.isVictory(R.LEVEL_WIN, false)).toBe(true);
    expect(R.isVictory(R.LEVEL_WIN + 5, false)).toBe(true);
    // "keep going" after the victory screen must not re-show it on every later explosion
    expect(R.isVictory(R.LEVEL_WIN, true)).toBe(false);
    expect(R.isVictory(R.LEVEL_WIN + 5, true)).toBe(false);
  });

  it('the pig fills up faster as score climbs, but never needs fewer than the floor', () => {
    expect(R.burgersToFullFor(0)).toBe(R.START_BURGERS_TO_FULL);
    expect(R.burgersToFullFor(R.BURGERS_TO_FULL_SCORE_STEP - 1)).toBe(R.START_BURGERS_TO_FULL);
    expect(R.burgersToFullFor(R.BURGERS_TO_FULL_SCORE_STEP)).toBe(R.START_BURGERS_TO_FULL - 1);
    let prev = Infinity;
    for (const score of range(60).map((i) => i * 50)) {
      const n = R.burgersToFullFor(score);
      expect(n).toBeLessThanOrEqual(prev);
      expect(n).toBeGreaterThanOrEqual(R.BURGERS_TO_FULL_FLOOR);
      prev = n;
    }
    expect(R.burgersToFullFor(1e9)).toBe(R.BURGERS_TO_FULL_FLOOR);
  });

  it('pinned: the opening pig needs 5 burgers, and 3 is the most it ever drops to', () => {
    expect(R.START_BURGERS_TO_FULL).toBe(5);
    expect(R.BURGERS_TO_FULL_FLOOR).toBe(3);
  });
});

describe('dragon size', () => {
  it('starts at the base size and grows with every explosion', () => {
    expect(R.dragonSizeFor(0)).toBe(R.DRAGON_BASE_SIZE);
    expect(R.dragonSizeFor(1)).toBeGreaterThan(R.dragonSizeFor(0));
  });
  it('is capped so the dragon never becomes unplayably large', () => {
    const max = R.DRAGON_BASE_SIZE * (1 + R.DRAGON_GROWTH_CAP);
    expect(R.dragonSizeFor(1000)).toBeCloseTo(max);
    for (const r of range(200)) expect(R.dragonSizeFor(r)).toBeLessThanOrEqual(max + 1e-9);
  });
  it('never shrinks as rounds go up', () => {
    let prev = 0;
    for (const r of range(50)) {
      expect(R.dragonSizeFor(r)).toBeGreaterThanOrEqual(prev);
      prev = R.dragonSizeFor(r);
    }
  });
});

describe('shockwave', () => {
  it('the first blow uses the base radius and speed', () => {
    expect(R.shockParamsFor(0)).toEqual({ maxRadius: R.SHOCK_RADIUS_BASE, speed: R.SHOCK_SPEED_BASE });
  });
  it('grows each round, then plateaus at the caps (so it stays escapable)', () => {
    let prev = R.shockParamsFor(0);
    for (const r of range(60).slice(1)) {
      const s = R.shockParamsFor(r);
      expect(s.maxRadius).toBeGreaterThanOrEqual(prev.maxRadius);
      expect(s.speed).toBeGreaterThanOrEqual(prev.speed);
      expect(s.maxRadius).toBeLessThanOrEqual(R.SHOCK_RADIUS_CAP);
      expect(s.speed).toBeLessThanOrEqual(R.SHOCK_SPEED_CAP);
      prev = s;
    }
    expect(prev).toEqual({ maxRadius: R.SHOCK_RADIUS_CAP, speed: R.SHOCK_SPEED_CAP });
  });
  it('grows by exactly the per-round step until it hits the cap', () => {
    expect(R.shockParamsFor(1).maxRadius - R.shockParamsFor(0).maxRadius).toBe(R.SHOCK_RADIUS_GROWTH_PER_ROUND);
    expect(R.shockParamsFor(1).speed - R.shockParamsFor(0).speed).toBe(R.SHOCK_SPEED_GROWTH_PER_ROUND);
  });
});

describe('coin lifetime', () => {
  it('starts at the base and shrinks per round, but never below the floor', () => {
    expect(R.coinLifeFramesFor(0)).toBe(R.COIN_LIFE_FRAMES);
    expect(R.coinLifeFramesFor(1)).toBe(R.COIN_LIFE_FRAMES - R.COIN_LIFE_SHRINK_PER_ROUND);
    for (const r of range(200)) {
      expect(R.coinLifeFramesFor(r)).toBeGreaterThanOrEqual(R.COIN_LIFE_FRAMES_FLOOR);
      expect(R.coinLifeFramesFor(r)).toBeLessThanOrEqual(R.COIN_LIFE_FRAMES);
    }
    expect(R.coinLifeFramesFor(1000)).toBe(R.COIN_LIFE_FRAMES_FLOOR);
  });
});

describe('pig jump window (the dragon\'s warning time)', () => {
  it('is the full base window up to and including the fast-pig level', () => {
    for (const level of range(R.FAST_PIG_LEVEL + 1)) expect(R.jumpDurationFor(level)).toBe(R.JUMP_DURATION_BASE);
  });
  it('shrinks by the per-level step past it', () => {
    expect(R.jumpDurationFor(R.FAST_PIG_LEVEL + 1)).toBe(R.JUMP_DURATION_BASE - R.JUMP_DURATION_SHRINK_PER_LEVEL);
    expect(R.jumpDurationFor(R.FAST_PIG_LEVEL + 2)).toBe(R.JUMP_DURATION_BASE - 2 * R.JUMP_DURATION_SHRINK_PER_LEVEL);
  });
  it('never drops below the floor, so it stays dodgeable', () => {
    for (const level of range(200)) expect(R.jumpDurationFor(level)).toBeGreaterThanOrEqual(R.JUMP_DURATION_FLOOR);
    expect(R.jumpDurationFor(10000)).toBe(R.JUMP_DURATION_FLOOR);
  });
});

describe('coins and scoring', () => {
  it('an explosion flings the base count, one more per score step, capped', () => {
    expect(R.coinCountFor(0)).toBe(R.COIN_BASE_COUNT);
    expect(R.coinCountFor(R.COIN_COUNT_SCORE_STEP - 1)).toBe(R.COIN_BASE_COUNT);
    expect(R.coinCountFor(R.COIN_COUNT_SCORE_STEP)).toBe(R.COIN_BASE_COUNT + 1);
    expect(R.coinCountFor(1e9)).toBe(R.COIN_MAX_COUNT);
    for (const score of range(100).map((i) => i * 25)) {
      expect(R.coinCountFor(score)).toBeLessThanOrEqual(R.COIN_MAX_COUNT);
    }
  });
  it('a golden burger is worth double a normal one, for progress and for score', () => {
    const n = R.feedReward(false), g = R.feedReward(true);
    expect(g.progress).toBe(n.progress * 2);
    expect(g.score).toBe(n.score * 3); // pinned: golden score is 3x (10 vs 30), progress is 2x
    expect(n).toEqual({ progress: 1, score: 10 });
    expect(g).toEqual({ progress: 2, score: 30 });
  });
  it('pinned: a coin is 15 points', () => {
    expect(R.COIN_SCORE).toBe(15);
  });
});

describe('formatTime', () => {
  it.each([
    [0, '0:00.0'],
    [1500, '0:01.5'],
    [9990, '0:10.0'],   // toFixed rounds up into the next digit, still well-formed
    [59900, '0:59.9'],
    [60000, '1:00.0'],
    [83400, '1:23.4'],
    [605000, '10:05.0'],
  ])('%i ms -> %s', (ms, out) => {
    expect(R.formatTime(ms)).toBe(out);
  });
  it('always renders seconds as two digits before the decimal', () => {
    for (const ms of range(600).map((i) => i * 997)) expect(R.formatTime(ms)).toMatch(/^\d+:\d\d\.\d$/);
  });
});

describe('angleToArrow (wind HUD hint)', () => {
  it('maps the eight compass directions', () => {
    const dirs = R.COMPASS_ARROWS;
    expect(dirs).toHaveLength(8);
    dirs.forEach((glyph, i) => expect(R.angleToArrow(i * (Math.PI / 4))).toBe(glyph));
  });
  it('wraps: negative angles and angles past a full turn resolve like their equivalent', () => {
    for (const i of range(8)) {
      const a = i * (Math.PI / 4);
      expect(R.angleToArrow(a - Math.PI * 2)).toBe(R.angleToArrow(a));
      expect(R.angleToArrow(a + Math.PI * 4)).toBe(R.angleToArrow(a));
    }
    expect(R.angleToArrow(-Math.PI / 2)).toBe(R.COMPASS_ARROWS[6]);
  });
  it('rounds to the nearest of the eight, splitting at 22.5 degrees', () => {
    expect(R.angleToArrow(Math.PI / 8 - 0.01)).toBe(R.COMPASS_ARROWS[0]);
    expect(R.angleToArrow(Math.PI / 8 + 0.01)).toBe(R.COMPASS_ARROWS[1]);
    // just below a full turn rounds up to 8, which must wrap back to east rather than index off the end
    expect(R.angleToArrow(Math.PI * 2 - 0.01)).toBe(R.COMPASS_ARROWS[0]);
  });
});

describe('coin batches (clean sweep = bonus heart)', () => {
  const make = () => R.createCoinBatches();

  it('ids start at 1 and count up, one per explosion', () => {
    const b = make();
    expect(b.start(5)).toBe(1);
    expect(b.start(5)).toBe(2);
    expect(b.start(5)).toBe(3);
  });

  it('collecting every coin is a sweep, reported on the LAST pickup only', () => {
    const b = make();
    const id = b.start(5);
    expect([1, 2, 3, 4].map(() => b.collect(id))).toEqual([false, false, false, false]);
    expect(b.collect(id)).toBe(true);
  });

  it('a batch of one sweeps on its only pickup', () => {
    const b = make();
    expect(b.collect(b.start(1))).toBe(true);
  });

  it('REGRESSION: one expired coin ruins the sweep, even if everything else is grabbed', () => {
    const b = make();
    const id = b.start(5);
    b.collect(id); b.collect(id); b.collect(id);
    b.expire(id);
    expect(b.collect(id)).toBe(false); // 4 collected + 1 expired
    expect(b.has(id)).toBe(false);
  });

  it('an expiry before any pickup also ruins it', () => {
    const b = make();
    const id = b.start(3);
    b.expire(id);
    expect([b.collect(id), b.collect(id)]).toEqual([false, false]);
  });

  it('a batch is forgotten once every coin is collected or expired', () => {
    const b = make();
    const id = b.start(2);
    expect(b.has(id)).toBe(true);
    b.collect(id);
    expect(b.has(id)).toBe(true);
    b.expire(id);
    expect(b.has(id)).toBe(false);
  });

  it('all coins expiring forgets the batch and awards nothing', () => {
    const b = make();
    const id = b.start(3);
    b.expire(id); b.expire(id); b.expire(id);
    expect(b.has(id)).toBe(false);
    expect(b.collect(id)).toBe(false); // a stale coin arriving late is ignored
  });

  it('a sweep is only ever reported once per batch, even if the id is reused by stale calls', () => {
    const b = make();
    const id = b.start(2);
    b.collect(id);
    expect(b.collect(id)).toBe(true);
    expect(b.collect(id)).toBe(false);
    expect(b.collect(id)).toBe(false);
  });

  it('overlapping batches (a second explosion while the first coins are still out) are independent', () => {
    const b = make();
    const first = b.start(2), second = b.start(2);
    b.expire(first);
    b.collect(second);
    b.collect(first);
    expect(b.collect(second)).toBe(true);   // second swept cleanly...
    expect(b.has(first)).toBe(false);       // ...first failed and is gone
  });

  it('unknown ids are ignored, never throw', () => {
    const b = make();
    expect(b.collect(99)).toBe(false);
    expect(() => b.expire(99)).not.toThrow();
  });

  it('REGRESSION: reset (new run) forgets old batches and restarts ids, so stale coins cannot score', () => {
    const b = make();
    const old = b.start(3);
    b.collect(old);
    b.reset();
    expect(b.has(old)).toBe(false);
    expect(b.start(2)).toBe(1);
    // the old run's leftover coin must not count toward the new batch that happens to reuse id 1
    // (the game also clears coinDrops on reset, so this is belt-and-braces)
    const id = 1;
    expect(b.collect(id)).toBe(false);
    expect(b.collect(id)).toBe(true);
  });

  it('MAX_LIVES is what the caller compares against for the heart (a sweep at full lives is still consumed)', () => {
    expect(R.MAX_LIVES).toBe(R.START_LIVES);
    const b = make();
    const id = b.start(2);
    b.collect(id);
    expect(b.collect(id)).toBe(true); // reports the sweep regardless of lives
    expect(b.collect(id)).toBe(false); // ...and it can't be claimed again later
  });
});

describe('shockwave hit test', () => {
  const pig = { x: 300, y: 300 };
  const dragonAt = (d, angle = 0, size = 42) => ({ x: pig.x + Math.cos(angle) * d, y: pig.y + Math.sin(angle) * d, size });

  it('the ring hurts within [radius - band, radius + half the dragon size], exclusive at both ends', () => {
    const R0 = 200, size = 42;
    expect(R.shockHits(dragonAt(R0 - R.SHOCK_HIT_BAND + 0.5, 0, size), pig, R0)).toBe(true);
    expect(R.shockHits(dragonAt(R0 - R.SHOCK_HIT_BAND, 0, size), pig, R0)).toBe(false);
    expect(R.shockHits(dragonAt(R0 + size / 2 - 0.5, 0, size), pig, R0)).toBe(true);
    expect(R.shockHits(dragonAt(R0 + size / 2, 0, size), pig, R0)).toBe(false);
  });
  it('safe once the ring has passed (well inside it) and safe ahead of it (well outside)', () => {
    expect(R.shockHits(dragonAt(50), pig, 200)).toBe(false);
    expect(R.shockHits(dragonAt(400), pig, 200)).toBe(false);
  });
  it('a bigger dragon is a bigger target: it is hit by the front from further away', () => {
    const d = 200 + 30; // 30px ahead of a radius-200 front
    expect(R.shockHits(dragonAt(d, 0, 42), pig, 200)).toBe(false);
    expect(R.shockHits(dragonAt(d, 0, 80), pig, 200)).toBe(true);
  });
  it('standing right under the pig when it lands is a hit on the first frames (radius ~0)', () => {
    expect(R.shockHits(dragonAt(0), pig, 0)).toBe(true);
    expect(R.shockHits(dragonAt(10), pig, 14)).toBe(true);
  });
  it('is direction-independent', () => {
    for (const a of range(16).map((i) => (i * Math.PI) / 8)) {
      expect(R.shockHits(dragonAt(190, a), pig, 200)).toBe(true);
      expect(R.shockHits(dragonAt(60, a), pig, 200)).toBe(false);
    }
  });
});

describe('knockback', () => {
  const W = 600, H = 1000, pig = { x: 300, y: 300 };
  it('shoves the dragon KNOCKBACK px straight away from the pig', () => {
    const k = R.knockedBack({ x: 400, y: 300, size: 42 }, pig, W, H);
    expect(k.x).toBeCloseTo(400 + R.KNOCKBACK);
    expect(k.y).toBeCloseTo(300);
    const up = R.knockedBack({ x: 300, y: 200, size: 42 }, pig, W, H);
    expect(up.x).toBeCloseTo(300);
    expect(up.y).toBeCloseTo(200 - R.KNOCKBACK);
  });
  it('the push has length exactly KNOCKBACK on a diagonal too', () => {
    const k = R.knockedBack({ x: 350, y: 350, size: 42 }, pig, W, H);
    expect(Math.hypot(k.x - 350, k.y - 350)).toBeCloseTo(R.KNOCKBACK);
  });
  it('is kept inside the field, by half the dragon size', () => {
    const size = 60;
    expect(R.knockedBack({ x: 590, y: 300, size }, pig, W, H).x).toBe(W - size / 2);
    expect(R.knockedBack({ x: 10, y: 300, size }, { x: 300, y: 300 }, W, H).x).toBe(size / 2);
    expect(R.knockedBack({ x: 300, y: 995, size }, pig, W, H).y).toBe(H - size / 2);
    expect(R.knockedBack({ x: 300, y: 5, size }, { x: 300, y: 300 }, W, H).y).toBe(size / 2);
  });
  it('exactly on top of the pig there is no "away", so it goes +x rather than NaN', () => {
    const k = R.knockedBack({ x: 300, y: 300, size: 42 }, pig, W, H);
    expect(k.x).toBeCloseTo(300 + R.KNOCKBACK);
    expect(Number.isNaN(k.y)).toBe(false);
  });
});

describe('the pig jump', () => {
  const W = 600, H = 1000;
  it('lands where the dragon stood at launch...', () => {
    expect(R.jumpTarget({ x: 250, y: 700 }, W, H)).toEqual({ x: 250, y: 700 });
  });
  it('...but never on the very edge of the field', () => {
    expect(R.jumpTarget({ x: 5, y: 700 }, W, H).x).toBe(R.JUMP_TARGET_MARGIN_X);
    expect(R.jumpTarget({ x: 595, y: 700 }, W, H).x).toBe(W - R.JUMP_TARGET_MARGIN_X);
    expect(R.jumpTarget({ x: 250, y: 10 }, W, H).y).toBe(H * R.JUMP_TARGET_MIN_Y);
    expect(R.jumpTarget({ x: 250, y: 990 }, W, H).y).toBe(H - R.JUMP_TARGET_BOTTOM_MARGIN);
  });
  it('flies from start to target with an arc that peaks at the halfway point and is flat at both ends', () => {
    const a = { x: 100, y: 200 }, b = { x: 500, y: 800 }, D = 60;
    const at = (timer) => R.jumpPosition(a, b, timer, D);
    expect(at(D)).toMatchObject({ x: 100, y: 200 });
    expect(at(D).airHeight).toBeCloseTo(0);
    expect(at(D / 2)).toMatchObject({ x: 300, y: 500 });
    expect(at(D / 2).airHeight).toBeCloseTo(R.JUMP_ARC_HEIGHT);
    expect(at(0)).toMatchObject({ x: 500, y: 800 });
    expect(at(0).airHeight).toBeCloseTo(0);
  });
  it('a timer that has overshot below zero clamps to the landing rather than flying past it', () => {
    const p = R.jumpPosition({ x: 0, y: 0 }, { x: 100, y: 100 }, -25, 60);
    expect(p.x).toBe(100);
    expect(p.y).toBe(100);
  });
  it('gets there in `duration` frames regardless of how long that is', () => {
    for (const D of [45, 75]) {
      const mid = R.jumpPosition({ x: 0, y: 0 }, { x: 100, y: 0 }, D / 2, D);
      expect(mid.x).toBeCloseTo(50);
    }
  });
});

describe('pig visual scale (drawn size = hit reach)', () => {
  const base = { feedProgress: 0, feedPunch: 0, jumping: false, airHeight: 0 };
  it('is exactly 1 for an unfed idle pig', () => {
    expect(R.pigVisualScale(base)).toBe(1);
  });
  it('grows with feeding, with the just-fed punch, and at the top of the jump', () => {
    expect(R.pigVisualScale({ ...base, feedProgress: 5 })).toBeCloseTo(1.6);
    expect(R.pigVisualScale({ ...base, feedPunch: 1 })).toBeCloseTo(1.2);
    expect(R.pigVisualScale({ ...base, jumping: true, airHeight: R.JUMP_ARC_HEIGHT })).toBeCloseTo(1.25);
  });
  it('air height only matters while jumping', () => {
    expect(R.pigVisualScale({ ...base, jumping: false, airHeight: R.JUMP_ARC_HEIGHT })).toBe(1);
  });
  it('the effects multiply', () => {
    const s = R.pigVisualScale({ feedProgress: 5, feedPunch: 1, jumping: true, airHeight: R.JUMP_ARC_HEIGHT });
    expect(s).toBeCloseTo(1.6 * 1.2 * 1.25);
  });
});

describe('throwing a burger', () => {
  const ready = { running: true, carrying: true, pigState: 'idle', coins: R.BURGER_THROW_COST };
  it('needs a running game, a carried burger, an idle pig and enough coins -- all four', () => {
    expect(R.canThrow(ready)).toBe(true);
    expect(R.canThrow({ ...ready, running: false })).toBe(false);
    expect(R.canThrow({ ...ready, carrying: false })).toBe(false);
    expect(R.canThrow({ ...ready, coins: R.BURGER_THROW_COST - 1 })).toBe(false);
    for (const pigState of ['jumping', 'exploding', 'cooldown']) {
      expect(R.canThrow({ ...ready, pigState })).toBe(false);
    }
  });
  it('coins beyond the cost are fine', () => {
    expect(R.canThrow({ ...ready, coins: 99 })).toBe(true);
  });
  it('pinned: a throw costs 4 coins', () => {
    expect(R.BURGER_THROW_COST).toBe(4);
  });
});

describe('pinned combat feel', () => {
  it('the dragon is invulnerable for 1.5s (90 frames) after a hit and the cooldown is 40 frames', () => {
    expect(R.HIT_INVULN_FRAMES).toBe(90);
    expect(R.COOLDOWN_FRAMES).toBe(40);
  });
});

// A scripted random source: returns the given values in order, then repeats the last one.
const scripted = (...vals) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
};

describe('ground burgers', () => {
  const W = 600, H = 1000, pig = { x: 300, y: 320 };

  it('picks a spot in the lower field, clear of the pig', () => {
    let seed = 7;
    const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 500; i++) {
      const { x, y } = R.pickBurgerSpot(pig, W, H, rng);
      expect(x).toBeGreaterThanOrEqual(40);
      expect(x).toBeLessThanOrEqual(W - 40);
      expect(y).toBeGreaterThanOrEqual(H * 0.46);
      expect(y).toBeLessThanOrEqual(H - 60);
      expect(Math.hypot(x - pig.x, y - pig.y)).toBeGreaterThanOrEqual(R.BURGER_SPAWN_PIG_CLEARANCE);
    }
  });
  it('retries a spot that is too close to the pig', () => {
    // first try: x = 40 + 0.5*(W-80) = 300, y = H*0.46 -> exactly on the pig; second try is the far corner
    const onPig = { x: 300, y: H * 0.46 };
    const rng = scripted(0.5, 0, 0, 1);
    expect(R.pickBurgerSpot(onPig, W, H, rng)).toEqual({ x: 40, y: H - 60 });
  });
  it('gives up after BURGER_SPAWN_TRIES and accepts the last spot rather than looping forever', () => {
    const blocker = { x: 300, y: 700 };
    // every try produces exactly the pig's own position: x = 300, y = 700
    const x01 = (300 - 40) / (W - 80);
    const y01 = (700 - H * 0.46) / (H - 60 - H * 0.46);
    let calls = 0;
    const rng = () => (calls++ % 2 === 0 ? x01 : y01);
    const spot = R.pickBurgerSpot(blocker, W, H, rng);
    expect(calls).toBe(R.BURGER_SPAWN_TRIES * 2);
    expect(spot.x).toBeCloseTo(300);
    expect(spot.y).toBeCloseTo(700);
  });

  it('golden burgers only appear from the golden level on', () => {
    for (const level of range(R.GOLDEN_BURGER_LEVEL)) expect(R.rollGolden(level, [], () => 0)).toBe(false);
    expect(R.rollGolden(R.GOLDEN_BURGER_LEVEL, [], () => 0)).toBe(true);
    expect(R.rollGolden(R.GOLDEN_BURGER_LEVEL + 10, [], () => 0)).toBe(true);
  });
  it('...at the configured chance, exclusive of the threshold', () => {
    expect(R.rollGolden(9, [], () => R.GOLDEN_CHANCE - 1e-9)).toBe(true);
    expect(R.rollGolden(9, [], () => R.GOLDEN_CHANCE)).toBe(false);
    expect(R.rollGolden(9, [], () => 0.99)).toBe(false);
  });
  it('...and never a second one while a golden burger is still lying around', () => {
    expect(R.rollGolden(9, [{ golden: false }, { golden: true }], () => 0)).toBe(false);
    expect(R.rollGolden(9, [{ golden: false }, { golden: false }], () => 0)).toBe(true);
  });

  it('spawns when the timer is up, there is room, and the pig is not mid-blast', () => {
    const ok = { spawnTimer: 0, groundCount: R.MAX_GROUND_BURGERS - 1, pigState: 'idle' };
    expect(R.shouldSpawnBurger(ok)).toBe(true);
    expect(R.shouldSpawnBurger({ ...ok, spawnTimer: -5 })).toBe(true);
    expect(R.shouldSpawnBurger({ ...ok, spawnTimer: 0.1 })).toBe(false);
    expect(R.shouldSpawnBurger({ ...ok, groundCount: R.MAX_GROUND_BURGERS })).toBe(false);
    expect(R.shouldSpawnBurger({ ...ok, pigState: 'exploding' })).toBe(false);
    for (const pigState of ['idle', 'jumping', 'cooldown']) expect(R.shouldSpawnBurger({ ...ok, pigState })).toBe(true);
  });
  it('the next spawn is 60..120 frames away', () => {
    expect(R.nextSpawnDelay(() => 0)).toBe(R.BURGER_SPAWN_BASE_FRAMES);
    expect(R.nextSpawnDelay(() => 0.999999)).toBeLessThan(R.BURGER_SPAWN_BASE_FRAMES + R.BURGER_SPAWN_JITTER_FRAMES);
  });
  it('pinned: a run opens with 3 burgers on the field, at most 4 at a time', () => {
    expect(R.START_GROUND_BURGERS).toBe(3);
    expect(R.MAX_GROUND_BURGERS).toBe(4);
  });
});

describe('wind gusts', () => {
  const idle = { level: R.WIND_GUST_LEVEL, pigState: 'idle' };
  // rng() === 0 makes every rand(a,b) return exactly `a`: first gust after 300 frames, angle 0
  // (east), 90 frames long, then a 360-frame lull.
  const make = (rng = () => 0) => {
    const g = R.createWindGusts(rng);
    g.reset();
    return g;
  };
  const run = (g, n, state = idle, fs = 1) => range(n).map(() => g.update(state, fs));

  it('never blows below the wind level, however long you wait', () => {
    const g = make();
    for (const o of run(g, 5000, { level: R.WIND_GUST_LEVEL - 1, pigState: 'idle' })) {
      expect(o).toEqual({ gusting: false, pushX: 0, pushY: 0, ended: false, started: false });
    }
    expect(g.active).toBe(0);
  });

  it('the first gust starts after the opening delay, not before', () => {
    const g = make();
    const early = run(g, 299);
    expect(early.some((o) => o.started)).toBe(false);
    expect(g.update(idle, 1).started).toBe(true); // 300th frame
  });

  it('a started gust pushes at GUST_STRENGTH in its direction for its whole duration, then ends', () => {
    const g = make(); // angle 0 (east), 90 frames
    run(g, 300); // wait for it to start
    expect(g.angle).toBe(0);
    expect(g.arrow).toBe(R.COMPASS_ARROWS[0]);
    const frames = run(g, 90);
    expect(frames.every((o) => o.gusting)).toBe(true);
    expect(frames.every((o) => o.pushX === R.GUST_STRENGTH && o.pushY === 0)).toBe(true);
    expect(frames.slice(0, -1).some((o) => o.ended)).toBe(false);
    expect(frames[89].ended).toBe(true);
    expect(g.active).toBeLessThanOrEqual(0);
    expect(g.update(idle, 1).gusting).toBe(false);
  });

  it('the push is scaled by frame time, and a slower frame rate covers the same duration in fewer frames', () => {
    const g = make();
    run(g, 150, idle, 2); // 300 game-frames of waiting at 2x
    const frames = run(g, 45, idle, 2);
    expect(frames.every((o) => o.gusting && o.pushX === R.GUST_STRENGTH * 2)).toBe(true);
    expect(frames[44].ended).toBe(true);
  });

  it('wind direction follows the roll: angle -> velocity, arrow and unit strength', () => {
    for (const [roll, arrowIdx] of [[0, 0], [0.125, 1], [0.25, 2], [0.5, 4], [0.75, 6]]) {
      // reset() consumes one value (opening delay), then start consumes angle then duration
      const g = R.createWindGusts(scripted(0, roll, 0));
      g.reset();
      run(g, 300);
      const o = g.update(idle, 1);
      expect(g.arrow).toBe(R.COMPASS_ARROWS[arrowIdx]);
      expect(Math.hypot(o.pushX, o.pushY)).toBeCloseTo(R.GUST_STRENGTH);
      const want = roll * Math.PI * 2;
      expect(Math.cos(Math.atan2(o.pushY, o.pushX) - want)).toBeCloseTo(1);
    }
  });

  it('a gust can only START while the pig is idle or cooling down -- the timer is frozen otherwise', () => {
    for (const pigState of ['jumping', 'exploding']) {
      const g = make();
      const out = run(g, 5000, { level: 9, pigState });
      expect(out.some((o) => o.started)).toBe(false);
      // timer did not advance, so a full opening delay is still owed once the pig is idle again
      expect(run(g, 299).some((o) => o.started)).toBe(false);
      expect(g.update(idle, 1).started).toBe(true);
    }
    const cool = make();
    run(cool, 299, { level: 9, pigState: 'cooldown' });
    expect(cool.update({ level: 9, pigState: 'cooldown' }, 1).started).toBe(true);
  });

  it('but a gust already blowing carries on through the pig jump and blast', () => {
    const g = make();
    run(g, 300);
    const during = run(g, 10, { level: 9, pigState: 'exploding' });
    expect(during.every((o) => o.gusting)).toBe(true);
  });

  it('after a gust ends there is a 360..600 frame lull before the next', () => {
    const g = make();
    run(g, 300 + 90); // through the end of the first gust
    expect(run(g, 359).some((o) => o.started)).toBe(false);
    expect(g.update(idle, 1).started).toBe(true);
    // and with the maximum roll it is 600
    const g2 = R.createWindGusts(scripted(0, 0, 0, /* lull */ 0.999999));
    g2.reset();
    run(g2, 300 + 90);
    expect(run(g2, 598).some((o) => o.started)).toBe(false);
  });

  it('reset (a new run) cancels a gust in progress and restarts the opening delay', () => {
    const g = make();
    run(g, 300);
    expect(g.active).toBeGreaterThan(0);
    g.reset();
    expect(g.active).toBe(0);
    expect(g.update(idle, 1).gusting).toBe(false);
    expect(run(g, 298).some((o) => o.started)).toBe(false);
  });

  it('pinned: wind starts at level 5 and pushes 1.8px/frame', () => {
    expect(R.WIND_GUST_LEVEL).toBe(5);
    expect(R.GUST_STRENGTH).toBe(1.8);
    expect(R.GOLDEN_BURGER_LEVEL).toBe(3);
  });
});
