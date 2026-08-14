// Isometric projection math for a W x H world-space play area. Kept as a factory
// (rather than module-level constants) since the projection depends on the caller's
// world dimensions and tuning knobs.
export function createIsoProjection(W, H, opts = {}){
  const ISO_ENABLED = opts.enabled !== false; // flip to false for a quick flat-view A/B comparison
  const ISO_TILE_W = opts.tileW ?? 0.6, ISO_TILE_H = opts.tileH ?? 0.4; // controls the floor diamond's squash ratio
  const ISO_PAD_X = opts.padX ?? 60, ISO_PAD_TOP = opts.padTop ?? 160, ISO_PAD_BOTTOM = opts.padBottom ?? 60; // screen-space margins
  const ISO_ORIGIN_X = ISO_PAD_X + H * ISO_TILE_W;
  const ISO_ORIGIN_Y = ISO_PAD_TOP;
  const CANVAS_W = ISO_PAD_X * 2 + (W + H) * ISO_TILE_W;
  const CANVAS_H = ISO_PAD_TOP + ISO_PAD_BOTTOM + (W + H) * ISO_TILE_H;

  function worldToScreen(x, y, z){
    z = z || 0;
    if (!ISO_ENABLED) return { sx: x, sy: y - z };
    return {
      sx: ISO_ORIGIN_X + (x - y) * ISO_TILE_W,
      sy: ISO_ORIGIN_Y + (x + y) * ISO_TILE_H - z
    };
  }
  // Direction-only counterpart to worldToScreen (no origin offset) — lets keyboard/
  // joystick input describe an on-screen direction (e.g. "right" = visually rightward)
  // instead of a raw world axis.
  function screenDirToWorldDir(dsx, dsy){
    if (!ISO_ENABLED) return { dx: dsx, dy: dsy };
    const u = dsx / ISO_TILE_W;
    const v = dsy / ISO_TILE_H;
    return { dx: (u + v) / 2, dy: (v - u) / 2 };
  }
  // A world-space circle of radius r projects to an axis-aligned screen ellipse under
  // this transform (no rotation needed) — reused for the shockwave and landing shadow.
  function screenEllipseRadii(r){
    return { rx: r * ISO_TILE_W * Math.SQRT2, ry: r * ISO_TILE_H * Math.SQRT2 };
  }
  // A world-space circular hit-radius projects to an elongated screen ellipse (wider than
  // tall, since ISO_TILE_W > ISO_TILE_H) — so a plain world-space distance check feels
  // stingy approaching from above/below and overly generous approaching from the side.
  // This checks proximity in screen space instead, using the ellipse's average radius, so
  // "close enough" feels the same from every approach direction.
  function withinScreenRange(ax, ay, bx, by, worldRadius){
    const A = worldToScreen(ax, ay), B = worldToScreen(bx, by);
    const { rx, ry } = screenEllipseRadii(worldRadius);
    return Math.hypot(A.sx - B.sx, A.sy - B.sy) < (rx + ry) / 2;
  }

  return {
    ISO_ENABLED, ISO_TILE_W, ISO_TILE_H, ISO_PAD_X, ISO_PAD_TOP, ISO_PAD_BOTTOM,
    ISO_ORIGIN_X, ISO_ORIGIN_Y, CANVAS_W, CANVAS_H,
    worldToScreen, screenDirToWorldDir, screenEllipseRadii, withinScreenRange
  };
}
