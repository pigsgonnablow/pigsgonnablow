import { describe, it, expect } from 'vitest';
import * as M from '../../js/movement.js';
import { createIsoProjection } from '../../js/iso.js';

// Same philosophy as rules.test.js: assert the rules (deadzone, digital-vs-analog, easing
// convergence, clamping), pin the tuning constants that define the game's actual feel.

const range = (n) => Array.from({ length: n }, (_, i) => i);

describe('resolveInputDirection', () => {
  const keysOf = (...names) => Object.fromEntries(names.map((n) => [n, true]));

  it('no input at all is (0,0), full magnitude', () => {
    expect(M.resolveInputDirection({ keys: {}, joyActive: false, joyDX: 0, joyDY: 0 }))
      .toEqual({ kx: 0, ky: 0, inputMagnitude: 1 });
  });

  it.each([
    ['arrowleft', { kx: -1, ky: 0 }],
    ['a', { kx: -1, ky: 0 }],
    ['arrowright', { kx: 1, ky: 0 }],
    ['d', { kx: 1, ky: 0 }],
    ['arrowup', { kx: 0, ky: -1 }],
    ['w', { kx: 0, ky: -1 }],
    ['arrowdown', { kx: 0, ky: 1 }],
    ['s', { kx: 0, ky: 1 }],
  ])('keyboard: %s', (key, want) => {
    const { kx, ky, inputMagnitude } = M.resolveInputDirection({ keys: keysOf(key), joyActive: false, joyDX: 0, joyDY: 0 });
    expect({ kx, ky }).toEqual(want);
    expect(inputMagnitude).toBe(1); // keyboard is always full speed, never scaled
  });

  it('opposite keys held together cancel out on that axis', () => {
    expect(M.resolveInputDirection({ keys: keysOf('a', 'd'), joyActive: false, joyDX: 0, joyDY: 0 }).kx).toBe(0);
    expect(M.resolveInputDirection({ keys: keysOf('w', 's'), joyActive: false, joyDX: 0, joyDY: 0 }).ky).toBe(0);
  });

  it('WASD and arrow keys are interchangeable, including diagonals', () => {
    const a = M.resolveInputDirection({ keys: keysOf('w', 'd'), joyActive: false, joyDX: 0, joyDY: 0 });
    const b = M.resolveInputDirection({ keys: keysOf('arrowup', 'arrowright'), joyActive: false, joyDX: 0, joyDY: 0 });
    expect(a).toEqual(b);
    expect(a).toEqual({ kx: 1, ky: -1, inputMagnitude: 1 });
  });

  it('an inactive joystick is ignored even with stale nonzero coordinates', () => {
    const r = M.resolveInputDirection({ keys: keysOf('d'), joyActive: false, joyDX: 1, joyDY: 1 });
    expect(r).toEqual({ kx: 1, ky: 0, inputMagnitude: 1 });
  });

  it('an active joystick under the deadzone falls back to keyboard, exclusive of the threshold', () => {
    const atThreshold = M.resolveInputDirection({ keys: keysOf('d'), joyActive: true, joyDX: M.JOYSTICK_DEADZONE, joyDY: 0 });
    expect(atThreshold).toEqual({ kx: 1, ky: 0, inputMagnitude: 1 }); // exactly at the deadzone -> keyboard
    const justOver = M.resolveInputDirection({ keys: keysOf('d'), joyActive: true, joyDX: M.JOYSTICK_DEADZONE + 1e-9, joyDY: 0 });
    expect(justOver.kx).toBeCloseTo(M.JOYSTICK_DEADZONE);
  });

  it('an active joystick past the deadzone overrides keyboard entirely, unnormalized', () => {
    const r = M.resolveInputDirection({ keys: keysOf('a'), joyActive: true, joyDX: 0.3, joyDY: 0.4 });
    expect(r).toEqual({ kx: 0.3, ky: 0.4, inputMagnitude: 0.5 }); // hypot(0.3,0.4) = 0.5
  });

  it('joystick magnitude beyond 1 (shouldn\'t happen, but) is clamped rather than overspeeding the dragon', () => {
    const r = M.resolveInputDirection({ keys: {}, joyActive: true, joyDX: 3, joyDY: 4 });
    expect(r.inputMagnitude).toBe(1);
  });

  it('pinned: the joystick deadzone is 0.15', () => {
    expect(M.JOYSTICK_DEADZONE).toBe(0.15);
  });
});

describe('screenInputToWorldMove', () => {
  const throws = () => { throw new Error('should not be called with no input'); };

  it('no input never calls the projection and returns a zero vector', () => {
    expect(M.screenInputToWorldMove(0, 0, 1, throws)).toEqual({ mx: 0, my: 0 });
  });

  it('scales the (normalized) projected direction by inputMagnitude', () => {
    const identity = (dx, dy) => ({ dx, dy });
    expect(M.screenInputToWorldMove(1, 0, 1, identity)).toEqual({ mx: 1, my: 0 });
    expect(M.screenInputToWorldMove(1, 0, 0.5, identity)).toEqual({ mx: 0.5, my: 0 });
  });

  it('normalizes an un-normalized (kx,ky) before projecting, and the projected result', () => {
    // kx,ky = (3,4) normalizes to (0.6,0.8) before hitting the projection; the stub then
    // returns a non-unit vector (1.2,1.6) which screenInputToWorldMove must normalize itself.
    const stub = (dx, dy) => ({ dx: dx * 2, dy: dy * 2 });
    const { mx, my } = M.screenInputToWorldMove(3, 4, 1, stub);
    expect(mx).toBeCloseTo(0.6);
    expect(my).toBeCloseTo(0.8);
  });

  it('REGRESSION: matches the original inline formula against the real iso projection', () => {
    const { screenDirToWorldDir } = createIsoProjection(600, 1000);
    // The formula index.html used before this was extracted.
    const original = (kx, ky, inputMagnitude) => {
      if (!kx && !ky) return { mx: 0, my: 0 };
      const kn = Math.hypot(kx, ky);
      const dir = screenDirToWorldDir(kx / kn, ky / kn);
      const n = Math.hypot(dir.dx, dir.dy);
      return { mx: (dir.dx / n) * inputMagnitude, my: (dir.dy / n) * inputMagnitude };
    };
    let seed = 42;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (const i of range(2000)) {
      const kx = rand() * 2 - 1, ky = rand() * 2 - 1, mag = rand();
      expect(M.screenInputToWorldMove(kx, ky, mag, screenDirToWorldDir)).toEqual(original(kx, ky, mag));
    }
  });
});

describe('easedVelocity', () => {
  it('with no easing time (frameScale=0) velocity is unchanged', () => {
    expect(M.easedVelocity(1, 2, 0, 0, 0)).toEqual({ vx: 1, vy: 2 });
  });

  it('eases toward the target (move direction * speed), never overshooting it from rest', () => {
    const { vx } = M.easedVelocity(0, 0, 1, 0, 1);
    expect(vx).toBeGreaterThan(0);
    expect(vx).toBeLessThan(M.DRAGON_SPEED);
  });

  it('repeated application converges on the target velocity', () => {
    let vx = 0, vy = 0;
    for (const _ of range(500)) ({ vx, vy } = M.easedVelocity(vx, vy, 1, -1, 1));
    expect(vx).toBeCloseTo(M.DRAGON_SPEED);
    expect(vy).toBeCloseTo(-M.DRAGON_SPEED);
  });

  it('is frame-rate independent: one big step matches many small steps covering the same time', () => {
    const big = M.easedVelocity(0, 0, 1, 0, 4);
    let small = { vx: 0, vy: 0 };
    for (const _ of range(4)) small = M.easedVelocity(small.vx, small.vy, 1, 0, 1);
    expect(big.vx).toBeCloseTo(small.vx, 6);
  });

  it('a target of zero decelerates back toward rest', () => {
    let vx = M.DRAGON_SPEED;
    for (const _ of range(500)) ({ vx } = M.easedVelocity(vx, 0, 0, 0, 1));
    expect(vx).toBeCloseTo(0);
  });

  it('pinned: 4.2 speed, 0.3 accel per frame', () => {
    expect(M.DRAGON_SPEED).toBe(4.2);
    expect(M.DRAGON_ACCEL).toBe(0.3);
  });
});

describe('easedPitch', () => {
  it('converges on the target and relaxes back to 0 once input stops', () => {
    let pitch = 0;
    for (const _ of range(200)) pitch = M.easedPitch(pitch, 1, 1);
    expect(pitch).toBeCloseTo(1);
    for (const _ of range(200)) pitch = M.easedPitch(pitch, 0, 1);
    expect(pitch).toBeCloseTo(0);
  });

  it('pinned: eases at 0.22 per frame', () => {
    expect(M.DRAGON_PITCH_EASE).toBe(0.22);
  });
});

describe('clampToWorld', () => {
  it('passes a point through unchanged when it is already inside the playable rect', () => {
    expect(M.clampToWorld(300, 400, 20, 600, 1000)).toEqual({ x: 300, y: 400 });
  });

  it('clamps to halfSize from each edge, not to 0/W/H', () => {
    expect(M.clampToWorld(-50, -50, 20, 600, 1000)).toEqual({ x: 20, y: 20 });
    expect(M.clampToWorld(9999, 9999, 20, 600, 1000)).toEqual({ x: 580, y: 980 });
  });

  it('a bigger dragon has a smaller playable area', () => {
    expect(M.clampToWorld(0, 0, 50, 600, 1000)).toEqual({ x: 50, y: 50 });
  });
});
