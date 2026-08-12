# Utility Scripts

This folder contains one-time migration and utility scripts.

## generate-matte-band.js

Generates the authored 9-patch matte-band tiles in `../assets/matte-band/`
(spec #14): 4 corner tiles (256x256) + 4 edge tiles (512 along the axis, 128
across) that repeat while windows scale. Each tile is a shadow map (composite
with `multiply`) and a highlight map (composite with `screen`), both greyscale
with the blend amount in the grey channel and no baked colour, so one asset set
serves every swatch from Gallery White to Museum Black.

**Usage:**
```bash
cd /path/to/frame_art_manager/app
node scripts/generate-matte-band.js
```

Everything is seeded (mulberry32 lattices, plus `assets/texture-fibre.png` as
the paper-texture input) — re-running writes byte-identical files. The script
validates before exiting: edge tiles must have no bigger jump where they wrap
than they have anywhere inside, each corner arm's cross-section must match the
edge tile it hands off to, and both maps must composite in range and stay
readable over `#f4f1ec` and `#131311`. Geometry, blend contract and placement
rules are written alongside the tiles as `manifest.json`.

Tiles are laid with a cross-faded overlap, not butted — windows are any size,
so a tile boundary lands on an arbitrary phase of the along-axis paper texture.
Butting them leaves a visible ridge across the bevel at every corner.

## preview-matte-band.js

Assembles a full 4K window from those tiles — flat matte, flat photo stand-in,
band composited around the window — and writes true-scale (1:1) corner crops to
`../assets/matte-band/preview/` for review. Run `generate-matte-band.js` first.

**Usage:**
```bash
node scripts/preview-matte-band.js
```

Four crops: top-left and bottom-left corners on Gallery White and Museum Black.
The pair of corners is the point — the top-left is where the light model puts
its darkest face and its cast shadow, the bottom-left is the lit pair with the
shadow pulled back under the bevel.

## migrate-dimensions.js

Analyzes all existing images in the library and adds dimension and aspect ratio metadata.

**When to use:**
- After bulk importing images outside the upload interface
- After restoring from a backup with old metadata format
- When aspect ratio data is missing for existing images

**Usage:**
```bash
cd /path/to/frame_art_manager/app
FRAME_ART_PATH="/path/to/frame_art" node scripts/migrate-dimensions.js
```

**What it does:**
- Reads all images from metadata.json
- Uses Sharp to analyze each image's dimensions
- Calculates aspect ratio (width/height)
- Updates metadata.json with dimensions and aspectRatio fields
- Skips images that already have this data

**Output:**
- Shows progress for each image
- Indicates 16:9 images with [16:9] tag
- Provides summary of updated/skipped/errored images
