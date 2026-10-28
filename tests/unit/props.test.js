import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROP_FRAME, PROP_ROWS, PROP_FRAMES, DRAGON_WALK_ROWS, DRAGON_WALK_FRAMES, SKIN_PROPS } from '../../js/props.js';

// props.png's layout is set by blender/make_props.py; the game and the skin icons find frames
// through js/props.js. When the pickle was added to the sheet, a second hardcoded copy of the
// layout (in js/skinicon.js) went stale and the Shop showed the wrong dragons. These keep the
// one remaining copy honest against the script and the image itself.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = readFileSync(resolve(ROOT, 'blender/make_props.py'), 'utf8');
const pyList = (name) => [...(new RegExp(`^${name} = \\[([\\s\\S]*?)\\]`, 'm').exec(script)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

// Width and height straight from the PNG's IHDR chunk.
function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('js/props.js', () => {
  it('lists the props in the same order make_props.py renders them', () => {
    const order = Object.entries(PROP_FRAMES).sort((a, b) => a[1] - b[1]).map(([name]) => name);
    expect(order).toEqual(pyList('PROPS'));
  });

  it('lists the walk rows in the same order make_props.py renders them', () => {
    const order = Object.entries(DRAGON_WALK_ROWS).sort((a, b) => a[1] - b[1]).map(([name]) => name);
    expect(order).toEqual(pyList('WALK_ROWS'));
    expect(Object.values(DRAGON_WALK_ROWS).sort()).toEqual(order.map((_, i) => i + 1));
    expect(Number(/^WALK_FRAMES = (\d+)/m.exec(script)?.[1])).toBe(DRAGON_WALK_FRAMES);
    expect(Number(/^FRAME = (\d+)/m.exec(script)?.[1])).toBe(PROP_FRAME);
  });

  it('matches the size of props.png', () => {
    const { width, height } = pngSize(resolve(ROOT, 'props.png'));
    expect(width).toBe(Object.keys(PROP_FRAMES).length * PROP_FRAME);
    expect(height).toBe(PROP_ROWS * PROP_FRAME);
    expect(PROP_ROWS).toBe(1 + Object.keys(DRAGON_WALK_ROWS).length);
  });

  it('points every dragon skin at a dragon frame', () => {
    for (const [skin, prop] of Object.entries(SKIN_PROPS)) {
      expect(PROP_FRAMES[prop], skin).toBeDefined();
      expect(DRAGON_WALK_ROWS[prop], skin).toBeDefined();
    }
  });
});
