import { describe, it, expect } from 'vitest';
import { createIsoProjection } from '../../js/iso.js';

const W = 600, H = 1000;
const iso = createIsoProjection(W, H);
const close = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('createIsoProjection', () => {
  it('derives origin and canvas size from the pads and tile ratios', () => {
    expect(iso.ISO_ORIGIN_X).toBeCloseTo(60 + H * 0.6);
    expect(iso.ISO_ORIGIN_Y).toBe(160);
    expect(iso.CANVAS_W).toBeCloseTo(60 * 2 + (W + H) * 0.6);
    expect(iso.CANVAS_H).toBeCloseTo(160 + 60 + (W + H) * 0.4);
  });

  it('projects the world origin to the screen origin', () => {
    expect(iso.worldToScreen(0, 0, 0)).toEqual({ sx: iso.ISO_ORIGIN_X, sy: iso.ISO_ORIGIN_Y });
  });

  it('+x goes right and down, +y goes left and down', () => {
    const o = iso.worldToScreen(0, 0);
    const px = iso.worldToScreen(10, 0);
    const py = iso.worldToScreen(0, 10);
    expect(px.sx).toBeGreaterThan(o.sx);
    expect(px.sy).toBeGreaterThan(o.sy);
    expect(py.sx).toBeLessThan(o.sx);
    expect(py.sy).toBeGreaterThan(o.sy);
  });

  it('z lifts a point straight up on screen and never moves it sideways', () => {
    const ground = iso.worldToScreen(50, 80, 0);
    const lifted = iso.worldToScreen(50, 80, 30);
    expect(lifted.sx).toBe(ground.sx);
    expect(lifted.sy).toBe(ground.sy - 30);
    expect(iso.worldToScreen(50, 80)).toEqual(ground); // z defaults to 0
  });

  it('screenDirToWorldDir inverts the projection of a direction (round trip)', () => {
    for (const [dx, dy] of [[1, 0], [0, 1], [-3, 7], [12.5, -4.25]]) {
      const a = iso.worldToScreen(0, 0);
      const b = iso.worldToScreen(dx, dy);
      const back = iso.screenDirToWorldDir(b.sx - a.sx, b.sy - a.sy);
      close(back.dx, dx);
      close(back.dy, dy);
    }
  });

  it('"screen right" maps to world movement that is visually rightward', () => {
    const { dx, dy } = iso.screenDirToWorldDir(1, 0);
    const a = iso.worldToScreen(0, 0);
    const b = iso.worldToScreen(dx, dy);
    expect(b.sx).toBeGreaterThan(a.sx);
    close(b.sy, a.sy); // purely horizontal on screen
  });

  it('screenEllipseRadii is wider than tall (tile W > tile H)', () => {
    const { rx, ry } = iso.screenEllipseRadii(10);
    expect(rx).toBeGreaterThan(ry);
    close(rx / ry, 0.6 / 0.4);
  });

  it('withinScreenRange: coincident points are in range, far points are not, boundary uses the mean radius', () => {
    expect(iso.withinScreenRange(100, 100, 100, 100, 5)).toBe(true);
    expect(iso.withinScreenRange(0, 0, 500, 500, 5)).toBe(false);
    const { rx, ry } = iso.screenEllipseRadii(30);
    const mean = (rx + ry) / 2;
    // move along the screen-horizontal world direction (+x, -y) by just under/over the mean radius
    const step = (mean * 0.99) / (2 * 0.6); // |dsx| = (dx - dy) * tileW = 2 * s * tileW for dx=s, dy=-s
    expect(iso.withinScreenRange(0, 0, step, -step, 30)).toBe(true);
    expect(iso.withinScreenRange(0, 0, step * 1.05, -step * 1.05, 30)).toBe(false);
  });
});

describe('flat mode (enabled: false)', () => {
  const flat = createIsoProjection(W, H, { enabled: false });

  it('worldToScreen is a passthrough with z subtracted from y', () => {
    expect(flat.worldToScreen(10, 20, 5)).toEqual({ sx: 10, sy: 15 });
  });

  it('screenDirToWorldDir is the identity', () => {
    expect(flat.screenDirToWorldDir(3, -4)).toEqual({ dx: 3, dy: -4 });
  });
});

describe('option overrides', () => {
  it('honours custom tile sizes and pads', () => {
    const custom = createIsoProjection(100, 100, { tileW: 1, tileH: 0.5, padX: 0, padTop: 0, padBottom: 0 });
    expect(custom.CANVAS_W).toBe(200);
    expect(custom.CANVAS_H).toBe(100);
    expect(custom.worldToScreen(0, 0)).toEqual({ sx: 100, sy: 0 });
  });
});
