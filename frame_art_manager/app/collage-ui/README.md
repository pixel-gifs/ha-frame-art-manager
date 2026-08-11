# collage-ui

React + Vite + Tailwind builder for multi-photo collages (see issue #1).
Compiled to static assets that Express serves at `/collage` — the vanilla
gallery stays untouched apart from its "Create Collage" entry point.

## Dev

```bash
# terminal 1: the Express backend
cd frame_art_manager/app
NODE_ENV=development node server.js   # port 8099

# terminal 2: Vite dev server (proxies /api, /thumbs, /library to 8099)
cd frame_art_manager/app/collage-ui
npm install
npm run dev                            # http://localhost:5173/?ids=a.jpg,b.jpg
```

## Build

```bash
npm run build   # outputs dist/, which Express serves at /collage
```

The add-on Docker image builds `dist/` in a separate stage — nothing is
compiled at container runtime. `base: './'` in `vite.config.js` keeps all
asset URLs relative so the app works behind the HA ingress prefix; don't
change it to an absolute path.
