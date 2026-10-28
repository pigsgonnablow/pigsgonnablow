// Menu icons for the dragon skins. The in-game dragons are the Blender renders in props.png
// (see js/props.js for which frame is which), so the Shop and My Skins cards crop the same
// frames instead of showing the 🐉 emoji. Any other skin keeps its emoji (and color filter).
import { PROP_ROWS, PROP_FRAMES, SKIN_PROPS } from './props.js';

// props.png is 4 rows of square frames (row 0 = props, rows 1-3 = the walk cycles). Scale it by
// height only so each square frame is exactly ICON_PX wide, then step along row 0 in pixels. That
// way adding a prop to the end of the sheet (as the pickle did) doesn't shift the dragons.
const ICON_PX = 38;

export function applySkinIcon(el, skin){
  const frame = PROP_FRAMES[SKIN_PROPS[skin.id]];
  if (frame === undefined){
    if (skin.color_filter) el.style.filter = skin.color_filter;
    return;
  }
  // The red and slime dragons have their own models, so the catalog's filter is not applied to them.
  el.textContent = '';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', skin.name);
  el.style.backgroundImage = "url('props.png')";
  el.style.backgroundRepeat = 'no-repeat';
  el.style.backgroundSize = `auto ${PROP_ROWS * ICON_PX}px`;
  el.style.backgroundPosition = `${-frame * ICON_PX}px 0`;
  el.style.width = el.style.height = `${ICON_PX}px`;
}
