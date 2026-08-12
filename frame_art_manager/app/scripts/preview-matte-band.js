#!/usr/bin/env node

/**
 * Preview harness for the authored matte-band tiles (ticket #15).
 *
 * Assembles a full 4K window the way the engine will in #17 — flat swatch
 * matte, a flat photo stand-in, then the 9-patch band composited around the
 * window (shadow maps multiplied, highlight maps screened) — and writes
 * true-scale crops of the top-left and bottom-left corners for review.
 *
 * It is also the reference implementation of the placement rule in
 * assets/matte-band/manifest.json: corners down first and opaque, then each
 * edge run laid with cross-faded overlaps so no junction is a butt join at
 * any window size. #17 should port layRun()/drawTile() rather than reinvent
 * them — butting the tiles instead puts a visible ridge across the bevel at
 * every corner.
 *
 * True scale matters: these are 1:1 pixels off the 3840x2160 canvas, so on a
 * 55" Frame one preview pixel is ~0.32mm. Reviewing a downscaled render hides
 * exactly the rim/bevel detail this asset set exists to get right.
 *
 * The two crops are deliberate: the top-left corner is where the light model
 * puts its darkest face and its cast shadow, the bottom-left is the lit pair
 * (bright left face, lit bottom rim) with the shadow pulled back under the
 * bevel. If either reads wrong, the light model is wrong.
 *
 * Usage: node scripts/preview-matte-band.js
 */

const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');

const { BAND, PRINT_EDGE } = require('./generate-matte-band');

const CANVAS = { width: 3840, height: 2160 };

// A portrait window on the 4K canvas, positioned so both reviewed corners sit
// clear of the canvas edge with room for a full-size crop around them.
const WINDOW = { left: 420, top: 120, width: 1500, height: 1920 };

// Flat stand-in for the photo: a neutral mid-tone, so the inner shadow and
// the bevel's contact edge are read on their own rather than through a
// picture's own contrast.
const PHOTO = { r: 138, g: 138, b: 134 };

const CROP = 1100;

const SWATCHES = {
  'gallery-white': '#f4f1ec',
  'museum-black': '#131311'
};

const ASSET_DIR = path.join(__dirname, '..', 'assets', 'matte-band');
const OUT_DIR = path.join(ASSET_DIR, 'preview');

// The band's outer boundary sits PRINT_EDGE px outside the window rect.
const OUT = Math.round(PRINT_EDGE);

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  };
}

/** Load one map's grey channel as a raw plane. */
async function loadMap(name) {
  const { data, info } = await sharp(path.join(ASSET_DIR, name))
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const grey = Buffer.allocUnsafe(info.width * info.height);
  for (let i = 0; i < grey.length; i++) grey[i] = data[i * info.channels];
  return { data: grey, width: info.width, height: info.height };
}

/**
 * Draw a tile into the layer, blended by `alphaAt(x, y)` in 0..1 — the ramp
 * that makes a junction a cross-fade instead of a butt join. Blending happens
 * in map space, which is the only place it is meaningful: both tiles carry
 * the same cross-section there, so the ramp only averages their hairline
 * texture.
 */
function drawTile(layer, map, left, top, alphaAt) {
  for (let y = 0; y < map.height; y++) {
    const dy = top + y;
    if (dy < 0 || dy >= CANVAS.height) continue;
    for (let x = 0; x < map.width; x++) {
      const dx = left + x;
      if (dx < 0 || dx >= CANVAS.width) continue;
      const a = alphaAt(x, y);
      if (a <= 0) continue;
      const i = dy * CANVAS.width + dx;
      const src = map.data[y * map.width + x];
      layer[i] = a >= 1 ? src : Math.round(layer[i] * (1 - a) + src * a);
    }
  }
}

const OPAQUE = () => 1;

/** Linear 0..1 ramp over the first `fade` px of an axis, then 1. */
function leadIn(fade, axis) {
  return (x, y) => Math.min(1, ((axis === 'x' ? x : y) + 0.5) / fade);
}

/** 1, falling linearly to 0 over the last `fade` px of an axis. */
function leadOut(fade, axis, length) {
  return (x, y) => Math.min(1, (length - (axis === 'x' ? x : y) - 0.5) / fade);
}

function both(a, b) {
  return (x, y) => Math.min(a(x, y), b(x, y));
}

/**
 * Lay one edge tile repeatedly along a run, following manifest.json's
 * placement rule: each tile ramps in over its leading crossFade px, and the
 * final tile is right-aligned to end crossFade px inside the far corner and
 * ramps out again. The run therefore stays smooth whatever the window size —
 * no tile is ever clipped, and no junction is ever a butt join.
 */
function layRun(layer, map, axis, start, end, fixed) {
  const step = BAND.edgeLength - BAND.crossFade;
  const length = BAND.edgeLength;
  const place = (at, alphaAt) => (axis === 'x'
    ? drawTile(layer, map, at, fixed, alphaAt)
    : drawTile(layer, map, fixed, at, alphaAt));

  const last = end - length;
  if (last < start) {
    throw new Error(
      `Run of ${end - start}px is shorter than one ${length}px edge tile; ` +
      'the window is too small for this band'
    );
  }

  for (let at = start; at < last; at += step) {
    place(at, leadIn(BAND.crossFade, axis));
  }
  place(last, both(leadIn(BAND.crossFade, axis), leadOut(BAND.crossFade, axis, length)));
}

/**
 * Nine-patch placement for one map kind: the four corners go down first and
 * opaque, then each edge run is laid between them with cross-faded overlaps.
 * The layer starts at the map's neutral value, so everything outside the band
 * composites as a no-op.
 */
async function placeBand(kind, neutral) {
  const L = WINDOW.left - OUT;
  const T = WINDOW.top - OUT;
  const R = WINDOW.left + WINDOW.width + OUT;
  const B = WINDOW.top + WINDOW.height + OUT;
  const C = BAND.cornerSize;
  const fade = BAND.crossFade;

  const layer = Buffer.alloc(CANVAS.width * CANVAS.height, neutral);

  const corners = { tl: [L, T], tr: [R - C, T], bl: [L, B - C], br: [R - C, B - C] };
  for (const [key, [left, top]] of Object.entries(corners)) {
    drawTile(layer, await loadMap(`corner-${key}.${kind}.png`), left, top, OPAQUE);
  }

  // Runs start inside the near corner's arm and end inside the far one's, so
  // the first and last ramps land on corner content rather than on bare matte.
  for (const [side, top] of Object.entries({ top: T, bottom: B - BAND.thickness })) {
    layRun(layer, await loadMap(`edge-${side}.${kind}.png`), 'x', L + C - fade, R - C + fade, top);
  }
  for (const [side, left] of Object.entries({ left: L, right: R - BAND.thickness })) {
    layRun(layer, await loadMap(`edge-${side}.${kind}.png`), 'y', T + C - fade, B - C + fade, left);
  }

  return sharp(layer, { raw: { width: CANVAS.width, height: CANVAS.height, channels: 1 } })
    .toColourspace('srgb')
    .png()
    .toBuffer();
}

async function renderSwatch(name, hex, shadowLayer, highlightLayer) {
  const matte = hexToRgb(hex);
  const photo = await sharp({
    create: { width: WINDOW.width, height: WINDOW.height, channels: 4, background: { ...PHOTO, alpha: 1 } }
  }).png().toBuffer();

  const base = await sharp({
    create: { width: CANVAS.width, height: CANVAS.height, channels: 4, background: { ...matte, alpha: 1 } }
  })
    .composite([{ input: photo, left: WINDOW.left, top: WINDOW.top }])
    .png()
    .toBuffer();

  const composited = await sharp(base)
    .composite([
      { input: shadowLayer, blend: 'multiply' },
      { input: highlightLayer, blend: 'screen' }
    ])
    .png()
    .toBuffer();

  const crops = {
    'top-left': { left: WINDOW.left - 200, top: WINDOW.top - 120 },
    'bottom-left': { left: WINDOW.left - 200, top: WINDOW.top + WINDOW.height + 120 - CROP }
  };

  const written = [];
  for (const [corner, at] of Object.entries(crops)) {
    const file = path.join(OUT_DIR, `${name}-${corner}.png`);
    await sharp(composited)
      .extract({ left: at.left, top: at.top, width: CROP, height: CROP })
      .png({ compressionLevel: 9 })
      .toFile(file);
    written.push(file);
  }
  return written;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const shadowLayer = await placeBand('shadow', 255);
  const highlightLayer = await placeBand('highlight', 0);

  for (const [name, hex] of Object.entries(SWATCHES)) {
    const written = await renderSwatch(name, hex, shadowLayer, highlightLayer);
    for (const file of written) console.log(`wrote ${file}`);
  }

  console.log(
    `\ntrue scale: 1 preview px = 1 canvas px at ${CANVAS.width}x${CANVAS.height}` +
    ` (~0.32mm on a 55" Frame); window ${WINDOW.width}x${WINDOW.height} at ` +
    `${WINDOW.left},${WINDOW.top}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
