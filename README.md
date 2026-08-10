# Cheeseburger Dragon vs. The Exploding Pig

An installable browser game (PWA). Dragon feeds a pig cheeseburgers, pig explodes, chaos ensues.

## Play it locally
Just open `index.html` in a browser. For the service worker / install prompt to work
properly, serve it over a local server rather than opening the file directly:

```
python3 -m http.server 8000
```
then visit `http://localhost:8000`.

## Deploy to GitHub Pages
1. Push this folder's contents to the **root** of a GitHub repo (see commands below).
2. On GitHub: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**,
   branch `main`, folder `/ (root)`. Save.
3. GitHub gives you a URL like `https://yourusername.github.io/repo-name/`.
4. Open that URL in Chrome on Android → menu (⋮) → **Install app** (or you'll see an
   "Add to Home Screen" banner automatically).

## Files
- `index.html` — the game
- `manifest.json` — PWA metadata (name, icons, colors)
- `sw.js` — service worker, caches assets for offline play
- `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` — app icons
