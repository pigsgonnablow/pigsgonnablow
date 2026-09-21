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
