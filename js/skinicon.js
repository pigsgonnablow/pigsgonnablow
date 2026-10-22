// Menu icons for the dragon skins. The in-game dragons are the Blender renders in props.png
// (frame 0 = green dragon, frame 15 = red dragon), so the Shop and My Skins cards crop the same
// frames instead of showing the 🐉 emoji. Any other skin keeps its emoji (and color filter).
const PROP_FRAMES = 16;
// props.png is 3 rows of square frames (row 0 = props, rows 1-2 = the walk cycles); scaling the
// sheet to the icon's height squashed all three rows into it, so size it to show row 0 only.
const PROP_ROWS = 3;
const SKIN_FRAME = { 'dragon-default': 0, 'dragon-red': 15 };

export function applySkinIcon(el, skin){
  const frame = SKIN_FRAME[skin.id];
  if (frame === undefined){
    if (skin.color_filter) el.style.filter = skin.color_filter;
    return;
  }
  // The red dragon has its own model, so the catalog's hue-shift filter is not applied to it.
  el.textContent = '';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', skin.name);
  el.style.backgroundImage = "url('props.png')";
  el.style.backgroundRepeat = 'no-repeat';
  el.style.backgroundSize = `${PROP_FRAMES * 100}% ${PROP_ROWS * 100}%`;
  el.style.backgroundPosition = `${(frame / (PROP_FRAMES - 1)) * 100}% 0`;
  el.style.height = '38px';
}
