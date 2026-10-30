// Frame layout of props.png, rendered by blender/make_props.py (its PROPS and WALK_ROWS lists
// set the order; tests/unit/props.test.js checks they match). The game canvas and the Shop /
// My Skins icons both look frames up here, so a prop added to the sheet can't leave one of
// them pointing at the wrong picture.
// Row 0 holds one 256px frame per prop; rows 1-4 are the dragons' walk/flap cycles.
export const PROP_FRAME = 256;
export const PROP_ROWS = 5;
export const PROP_FRAMES = { dragon:0, burger:1, coin:2, rock0:3, rock1:4, rock2:5, daisy:6, blossom:7, tulip:8,
                             cloud0:9, cloud1:10, cloud2:11, grass0:12, grass1:13, grass2:14, dragon_red:15,
                             dragon_slime:16, pickle:17, dragon_unicorn:18 };
// Rows 1-3: each animated dragon's walk/flap cycle, DRAGON_WALK_FRAMES frames long.
export const DRAGON_WALK_ROWS = { dragon:1, dragon_red:2, dragon_slime:3, dragon_unicorn:4 };
export const DRAGON_WALK_FRAMES = 8;
// Skins that have their own Blender dragon, and which prop frame shows it.
export const SKIN_PROPS = { 'dragon-default':'dragon', 'dragon-red':'dragon_red', 'dragon-slime':'dragon_slime',
                                 'dragon-unicorn':'dragon_unicorn' };
