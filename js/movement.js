// The dragon's input/movement math, as plain functions with no DOM/canvas in them, so they
// can be unit-tested (tests/unit/movement.test.js) the same way js/rules.js is. index.html
// still owns the actual keys/joystick state, the dragon object, and drawing; it just calls
// into these instead of computing the formulas inline.

// ---------- input resolution ----------
// Below this joystick magnitude, treat it as centered (residual pointer jitter shouldn't
// fight held keyboard input, and shouldn't produce a barely-moving dragon on its own).
export const JOYSTICK_DEADZONE = 0.15;

// Combines keyboard + analog joystick into a single screen-relative direction. The joystick
// takes over entirely once past the deadzone (it's the only analog input, so there's no
// blending case to handle); below that, WASD/arrows apply, and keyboard is always full-speed
// (digital) rather than scaled. Returns kx/ky as given -- not normalized, and each in [-1,1]
// for keyboard but not necessarily unit length -- along with the input's magnitude (1 for
// keyboard; the clamped joystick magnitude otherwise).
export function resolveInputDirection({ keys, joyActive, joyDX, joyDY }) {
  const joyMag = Math.hypot(joyDX, joyDY);
  if (joyActive && joyMag > JOYSTICK_DEADZONE) {
    return { kx: joyDX, ky: joyDY, inputMagnitude: Math.min(joyMag, 1) };
  }
  let kx = 0, ky = 0;
  if (keys['arrowleft'] || keys['a']) kx -= 1;
  if (keys['arrowright'] || keys['d']) kx += 1;
  if (keys['arrowup'] || keys['w']) ky -= 1;
  if (keys['arrowdown'] || keys['s']) ky += 1;
  return { kx, ky, inputMagnitude: 1 };
}

// Turns a screen-relative input direction into a world-space move vector of length
// `inputMagnitude` (0 when there's no input), via the given iso screenDirToWorldDir
// converter -- passed in rather than imported so this stays independent of js/iso.js's
// ISO_ENABLED/tile-size setup and easy to test with a stub projection.
export function screenInputToWorldMove(kx, ky, inputMagnitude, screenDirToWorldDir) {
  if (!kx && !ky) return { mx: 0, my: 0 };
  const kn = Math.hypot(kx, ky);
  const dir = screenDirToWorldDir(kx / kn, ky / kn);
  const n = Math.hypot(dir.dx, dir.dy);
  return { mx: (dir.dx / n) * inputMagnitude, my: (dir.dy / n) * inputMagnitude };
}

// ---------- dragon physics ----------
export const DRAGON_SPEED = 4.2;
export const DRAGON_ACCEL = 0.3; // how quickly velocity eases toward the target each frame -- gives a bit of slide instead of stopping dead
export const DRAGON_PITCH_EASE = 0.22;

// Eases (vx,vy) toward the target velocity (the move direction at DRAGON_SPEED) by an amount
// scaled so the same real-world time produces the same amount of easing regardless of frame
// rate. The caller still does x += vx*frameScale and any world-bounds clamping itself.
export function easedVelocity(vx, vy, mx, my, frameScale, speed = DRAGON_SPEED, accel = DRAGON_ACCEL) {
  const accelThisFrame = 1 - Math.pow(1 - accel, frameScale);
  return {
    vx: vx + (mx * speed - vx) * accelThisFrame,
    vy: vy + (my * speed - vy) * accelThisFrame,
  };
}

// Banks the dragon's pitch pose toward the current vertical input (not just a discrete
// up/down pick), easing every frame -- including with no input at all, which relaxes it back
// to level -- so it banks into a turn instead of snapping.
export function easedPitch(pitch, targetPitch, frameScale, ease = DRAGON_PITCH_EASE) {
  return pitch + (targetPitch - pitch) * (1 - Math.pow(1 - ease, frameScale));
}

// Keeps a point (the dragon's center) fully inside the world rect, accounting for its own
// half-size, so it can never walk off the playable field.
export function clampToWorld(x, y, halfSize, W, H) {
  return {
    x: Math.max(halfSize, Math.min(W - halfSize, x)),
    y: Math.max(halfSize, Math.min(H - halfSize, y)),
  };
}

// ---------- on-screen joystick ----------
// Clamps a raw pointer offset from the joystick's own center to its max radius (its knob can
// never be dragged outside the base), then normalizes each axis to [-1,1]. Shared by the
// pointerdown/pointermove handlers, which both feed the same (dx,dy) math in.
export function clampJoystickVector(dx, dy, maxDist) {
  const d = Math.hypot(dx, dy);
  if (d > maxDist) { dx = dx / d * maxDist; dy = dy / d * maxDist; }
  return { dx: dx / maxDist, dy: dy / maxDist };
}

// ---------- letterbox-anchored overlay controls ----------
// The canvas is letterboxed inside its wrapper (its aspect ratio rarely matches the
// viewport's), so a fixed-size UI element anchored to the canvas's bottom edge should sit in
// the empty letterbox strip below it when there's room, rather than overlaying the game itself
// -- and fall back to overlaying the corner when the canvas fills the viewport height and there
// is no such room. Shared by the joystick and throw button (previously each computed this
// separately, and had the same "lands in the letterbox gap" bug before it was fixed).
export function bottomAnchoredTop(rectBottom, innerHeight, elHeight, margin) {
  const spaceBelow = innerHeight - rectBottom;
  if (spaceBelow >= elHeight + margin) {
    return rectBottom + Math.max((spaceBelow - elHeight) / 2, margin / 2);
  }
  return rectBottom - margin - elHeight;
}
