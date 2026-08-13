# Utility Scripts

This folder contains one-time migration and utility scripts.

## generate-texture-tiles.js

Regenerates the matte texture tiles in `../assets/` — `texture-fibre.png` and
`texture-weave.png`, both 512x512 8-bit greyscale centred on 128 (soft-light
neutral) and seamless. The tiles are checked into git and loaded at render time
by `collage_service.js`; this script exists so they are reproducible, not
because it runs in production.

**Usage:**
```bash
cd /path/to/frame_art_manager/app
node scripts/generate-texture-tiles.js
```

Everything is seeded (mulberry32 lattices, periodic terms on periods that
divide 512) — re-running writes byte-identical files. Render-time strength and
pitch are matte tuning params (`textureOpacity`, `texturePitch`), not baked
into the tiles, so retuning the look never means regenerating these.

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
