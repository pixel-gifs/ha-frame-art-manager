#!/usr/bin/env node

/**
 * Deterministic generator for the authored matte-band 9-patch tiles in
 * ../assets/matte-band/ (spec #14, ticket #15).
 *
 * The band is the strip of physics that surrounds every collage window:
 *
 *     t = 0                                                        t = 128
 *     |<-- matte field 64 -->|rim 2.2|<-- bevel 13 -->|<-- shadow 48.8 -->|
 *     matte surface          cut lip  exposed cut face  print (photo)
 *                                                     ^
 *                                              t = 79.2: the print edge
 *
 * `t` is the distance, in 4K reference pixels, inward from the band's outer
 * boundary. Everything outward of t=0 is plain matte, everything inward of
 * t=128 is plain print, so the tiles only have to carry the transition.
 *
 * Nine-patch layout: 4 corner tiles (256x256 — a 128x128 corner square plus
 * 128px of run down each arm, so the arms hand off to the edge tiles at a
 * cross-section they already match) and 4 edge tiles (512 along the axis,
 * 128 across) that repeat along their axis while the window scales.
 *
 * Tiles are laid with a BAND.crossFade ramp rather than butted together. A
 * window can be any size, so a tile boundary lands on an arbitrary phase of
 * the along-axis fibre and rim hairline, and no fixed tile set can predict
 * which — butting them leaves a ~14/255 ridge across the bevel at every
 * corner. The ramp blends two identical cross-sections, so the junction is
 * smooth at any window size. manifest.json carries the exact rule and
 * preview-matte-band.js implements it.
 *
 * TINT BY DECOMPOSITION (decision 2): no tile carries colour. Each tile is a
 * pair of opaque greyscale+alpha PNGs:
 *
 *   *.shadow.png     grey = 255 * (1 - darkening)   -> blend 'multiply'
 *   *.highlight.png  grey = 255 * lightening        -> blend 'screen'
 *
 * Over an opaque base that is exactly  out = base * grey/255  and
 * out = base + (255 - base) * grey/255 — the same maths as
 * collage_service.js's shade() for negative and positive amounts
 * respectively. So the engine's per-face shade() factors port over
 * one-for-one, and one asset set serves all 13 swatches.
 *
 * The amount lives in the grey channel, not in alpha, on purpose. libvips
 * feeds blend modes the *premultiplied* source colour, so a white overlay at
 * alpha a screens by a^2 rather than a (measured: alpha 132 over grey 19
 * yields 82, not 141). Opaque tiles sidestep that entirely — the composite is
 * exact and does not depend on how a compositor treats a partially
 * transparent blend source. Alpha stays at 255 across every tile; the band
 * covers its whole footprint, and the neutral values (255 shadow / 0
 * highlight) are already exact no-ops where it authors nothing.
 *
 * Because the cut core of real board is a fixed near-white, the rim and bevel
 * carry a fixed CORE_LIFT screen term rather than a per-swatch bevel colour.
 * Over Gallery White that is invisible (the surface is already near-white);
 * over Museum Black it opens the cut to a light grey. Both land within ~2% of
 * what collage_service.js's per-swatch bevelColor produces today.
 *
 * DETERMINISM: seeded value noise only (mulberry32 lattices, wrapped so they
 * tile), plus assets/texture-fibre.png as the paper-texture input. No
 * Date.now(), no Math.random() — re-running writes byte-identical files.
 *
 * The script validates its own output before it exits:
 *
 *  - Tiling. An edge tile repeated along its axis can only show a ridge where
 *    it wraps, so the wrap-adjacent line pair is diffed and held to the worst
 *    delta the tile already has between neighbouring interior lines — the
 *    same thing tiling 3x and inspecting the two joins would tell you,
 *    without the second image.
 *  - Junctions. Each corner arm's mean cross-section is compared with its
 *    edge tile's, calibrated against the swing that tile's own texture
 *    already has at that depth.
 *  - Compositing. Every map is run over Gallery White and Museum Black to
 *    check the result stays in range and stays readable on both.
 *
 * Usage: node scripts/generate-matte-band.js
 */

const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');

// ---------------------------------------------------------------------------
// Geometry (4K reference pixels)
// ---------------------------------------------------------------------------

const BAND = {
  matteMargin: 64,    // matte surface carried outside the cut
  rim: 2.2,           // lit lip where the surface meets the cut
  bevel: 13,          // exposed 45-degree cut face
  shadowReach: 48.8,  // how far the inner shadow runs onto the print
  thickness: 128,     // = the four above; the band's cross-section
  cornerSize: 256,    // corner tile side (corner square + one arm each way)
  edgeLength: 512,    // edge tile length along its axis
  crossFade: 64       // how far each tile ramps onto the one before it
};

const RIM_START = BAND.matteMargin;
const RIM_END = RIM_START + BAND.rim;
const PRINT_EDGE = RIM_END + BAND.bevel; // 79.2 — where the photo becomes visible

const SIDES = ['top', 'right', 'bottom', 'left'];

/** Which axis a side's band runs along. */
function isHorizontal(side) {
  return side === 'top' || side === 'bottom';
}

// ---------------------------------------------------------------------------
// Light model — a snapshot of LOOK_DEFAULTS in collage_service.js (Matt's
// tuning session, 2026-08-12): light from the upper-right, shadow falling
// down-left at 135deg, top face darkest through to left face brightest, lit
// bottom/left rims.
//
// Deliberately a copy rather than a require: collage_service.js does not
// export LOOK_DEFAULTS and #15 is explicit that this ticket must not touch
// that file. So this is a third copy of the light model (the client's is in
// collage-ui/src/geometry.js, parity-tested) and it will silently desync if
// the procedural path is retuned before #17 folds them together. #17 owns
// that merge — until then, retuning means re-running this script.
// ---------------------------------------------------------------------------

const LIGHT = {
  face: { top: -0.23, right: -0.155, bottom: -0.045, left: 0.45 },
  rim: { top: -0.16, right: -0.1, bottom: -0.045, left: 0.42 },
  rimFeather: 0.75,
  bevelFeather: 0.25,
  shadowAngle: 135,
  shadowDistance: 10,
  umbraOpacity: 0.12, umbraBlur: 2, umbraSpread: 0,
  penumbraOpacity: 0.08, penumbraBlur: 6, penumbraSpread: 7,
  penumbraDrift: 1.6
};

// Realism budget (all in shade units, where 1.0 would be full black/white).
const CORE_LIFT = 0.12;     // near-white board core, screened onto rim + bevel
const MATTE_AO = 0.03;      // the surface loses ambient light near the opening
const MATTE_AO_REACH = 26;
const FACE_TILT = 0.07;     // per-face luminance gradient across the cut
const FACE_CREVICE = 0.1;   // the cut darkens where it meets the print
const FACE_TEXTURE = 0.3;   // gain on texture-fibre.png over the cut face
const RIM_HAIRLINE = 0.018; // hand-cut rims are never perfectly even
const CORNER_AO = 0.06;     // occlusion pooling in the mitered corner
const CORNER_AO_REACH = 26;
const OVERCUT_DEPTH = 0.05; // the faint slit a hand cut leaves past the corner
const OVERCUT_WIDTH = 0.65;
const OVERCUT_MAX = 9;
const SEAM_SOFT = 1.6;      // how softly the two faces meet along the miter

// ---------------------------------------------------------------------------
// Deterministic primitives
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smoothstep of a value already clamped to 0..1 at the edges. */
function smoothstep01(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Combine independent 0..1 attenuations (never exceeds 1). */
function stack(a, b) {
  return 1 - (1 - a) * (1 - b);
}

/**
 * Seamless 1-D value noise with the given period, sampled on a lattice that
 * wraps — noise(x) === noise(x + period * cells), so anything driven by it
 * tiles along the band axis.
 */
function makeWrappedNoise1d(seed, period, span) {
  const cells = Math.max(1, Math.round(span / period));
  const rng = mulberry32(seed);
  const lattice = new Float64Array(cells);
  for (let i = 0; i < cells; i++) lattice[i] = rng() * 2 - 1;
  const at = (i) => lattice[((i % cells) + cells) % cells];
  return (x) => {
    const f = x / period;
    const i = Math.floor(f);
    const t = smoothstep01(f - i);
    return at(i) + (at(i + 1) - at(i)) * t;
  };
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Fraction of a gaussian-blurred half-plane still covered at `z` sigmas. */
function blurredStep(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// ---------------------------------------------------------------------------
// Paper texture input
// ---------------------------------------------------------------------------

/**
 * texture-fibre.png as a signed field in roughly -1..1. It is 512x512 and
 * seamless, and the edge tiles are 512 long, so sampling it by the along-axis
 * coordinate tiles exactly.
 */
async function loadFibre() {
  const file = path.join(__dirname, '..', 'assets', 'texture-fibre.png');
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const field = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    field[i] = (data[i * channels] - 128) / 24; // the tile's own swing is ~+/-24
  }
  return (x, y) => {
    const xi = ((Math.round(x) % width) + width) % width;
    const yi = ((Math.round(y) % height) + height) % height;
    return field[yi * width + xi];
  };
}

// ---------------------------------------------------------------------------
// The band model
// ---------------------------------------------------------------------------

// How far the cast shadow reaches onto the print differs per side: the offset
// is projected onto each side's inward normal, so the top and right bands
// (lit from the upper-right) throw a shadow and the bottom and left ones have
// theirs pulled back under the bevel.
const INWARD_NORMAL = {
  top: [0, 1], right: [-1, 0], bottom: [0, -1], left: [1, 0]
};

function shadowOffsets() {
  const rad = (LIGHT.shadowAngle * Math.PI) / 180;
  const dx = Math.cos(rad) * LIGHT.shadowDistance;
  const dy = Math.sin(rad) * LIGHT.shadowDistance;
  const out = {};
  for (const side of SIDES) {
    const [nx, ny] = INWARD_NORMAL[side];
    out[side] = dx * nx + dy * ny;
  }
  return out;
}

const SHADOW_PERP = shadowOffsets();

/**
 * Darkening the matte casts onto the print, `v` px past the print edge: a
 * tight umbra plus a wider, fainter penumbra that drifts further along the
 * light direction. Both are half-planes blurred by a gaussian, which is what
 * the SVG feGaussianBlur in the procedural path approximates.
 */
function castShadow(side, v) {
  const d = SHADOW_PERP[side];
  const umbra = LIGHT.umbraOpacity
    * blurredStep((d + LIGHT.umbraSpread - v) / LIGHT.umbraBlur);
  const penumbra = LIGHT.penumbraOpacity
    * blurredStep((d * LIGHT.penumbraDrift + LIGHT.penumbraSpread - v) / LIGHT.penumbraBlur);
  return stack(umbra, penumbra);
}

/**
 * The band's cross-section at depth `t`, at longitudinal position `along`.
 * Returns the surface tone as a shade amount (negative darkens, positive
 * lightens, same convention as collage_service.js's shade()), the fixed core
 * lift over the cut, and how much of this pixel is bare print.
 */
function crossSection(side, t, along, noise, fibre) {
  const rf = LIGHT.rimFeather;
  const bf = LIGHT.bevelFeather;

  // Hierarchical region masks; each ramp is centred on its boundary.
  const aRim = smoothstep01((t - (RIM_START - rf / 2)) / rf);
  const aBevel = smoothstep01((t - (RIM_END - bf / 2)) / bf);
  const aPrint = smoothstep01((t - (PRINT_EDGE - bf / 2)) / bf);

  const mMatte = 1 - aRim;
  const mRim = aRim * (1 - aBevel);
  const mBevel = aBevel * (1 - aPrint);
  const mPrint = aPrint;

  // Matte surface: flat, losing a little ambient as it approaches the cut.
  const matteShade = -MATTE_AO * smoothstep01((t - (RIM_START - MATTE_AO_REACH)) / MATTE_AO_REACH);

  // Rim: the lit lip, with a hairline wobble along its length.
  const rimShade = LIGHT.rim[side] + noise.rim(along) * RIM_HAIRLINE;

  // Cut face: base per-side shade, a luminance tilt across the face, ambient
  // occlusion where it meets the print, and paper fibre on the exposed core.
  const u = clamp01((t - RIM_END) / BAND.bevel);
  const bevelShade = LIGHT.face[side]
    + FACE_TILT * (0.5 - u)
    - FACE_CREVICE * smoothstep01((u - 0.72) / 0.28)
    + fibre(along, (RIM_END + u * BAND.bevel) * 3) * FACE_TEXTURE * 0.25
    + noise.face(along) * 0.012;

  const shade = mMatte * matteShade + mRim * rimShade + mBevel * bevelShade;
  const lift = (mRim + mBevel) * CORE_LIFT;

  return { shade, lift, print: mPrint };
}

/** Split a signed shade amount into the two maps. */
function accumulate(acc, shade, lift) {
  acc.dark = stack(acc.dark, Math.max(0, -shade));
  acc.lift = stack(acc.lift, stack(Math.max(0, shade), lift));
}

/**
 * The faint slit a hand cut leaves when the blade overshoots the corner: the
 * cut line at t = RIM_START continues a few px past where the two openings
 * meet. `pastCorner` is how far outward of the corner we are along the other
 * axis; `length` is this corner's seeded overshoot.
 */
function overcut(t, pastCorner, length) {
  if (length <= 0 || pastCorner < 0 || pastCorner > length) return 0;
  const acrossCut = 1 - smoothstep01((Math.abs(t - RIM_START) - OVERCUT_WIDTH) / 0.8);
  const fade = 1 - smoothstep01(pastCorner / length);
  return OVERCUT_DEPTH * acrossCut * fade;
}

// ---------------------------------------------------------------------------
// Tile rendering
// ---------------------------------------------------------------------------

function makeNoise(seedBase) {
  return {
    rim: makeWrappedNoise1d(seedBase + 1, 32, BAND.edgeLength),
    face: makeWrappedNoise1d(seedBase + 2, 64, BAND.edgeLength)
  };
}

const SIDE_SEED = { top: 0xba7d0001, right: 0xba7d0002, bottom: 0xba7d0003, left: 0xba7d0004 };

function edgeTileSize(side) {
  return isHorizontal(side)
    ? { width: BAND.edgeLength, height: BAND.thickness }
    : { width: BAND.thickness, height: BAND.edgeLength };
}

/**
 * Where a pixel of an edge tile sits in the band: `t` is always measured from
 * the matte side, `along` runs down the axis. The single place tile pixel
 * order is turned into band coordinates — the renderer and the validation
 * both go through it, so they cannot drift apart.
 */
function edgeCoords(side, px, py) {
  const { width, height } = edgeTileSize(side);
  return isHorizontal(side)
    ? { t: side === 'top' ? py + 0.5 : height - 0.5 - py, along: px }
    : { t: side === 'left' ? px + 0.5 : width - 0.5 - px, along: py };
}

/** Depth into each of a corner's two bands, from the tile's outer corner. */
function cornerCoords(key, px, py) {
  const { h, v } = CORNER_SIDES[key];
  const size = BAND.cornerSize;
  return {
    tV: (v === 'left' ? px : size - 1 - px) + 0.5,
    tH: (h === 'top' ? py : size - 1 - py) + 0.5
  };
}

/**
 * One edge tile, written out in the orientation the side needs: horizontal
 * sides are edgeLength x thickness, vertical sides thickness x edgeLength.
 */
function renderEdge(side, fibre) {
  const noise = makeNoise(SIDE_SEED[side]);
  const { width, height } = edgeTileSize(side);

  const dark = new Float64Array(width * height);
  const lift = new Float64Array(width * height);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const { t, along } = edgeCoords(side, px, py);

      const cs = crossSection(side, t, along, noise, fibre);
      const acc = { dark: 0, lift: 0 };
      accumulate(acc, cs.shade, cs.lift);
      if (cs.print > 0) {
        acc.dark = stack(acc.dark, cs.print * castShadow(side, t - PRINT_EDGE));
      }

      const i = py * width + px;
      dark[i] = acc.dark;
      lift[i] = acc.lift;
    }
  }

  return { width, height, dark, lift };
}

const CORNER_SIDES = {
  tl: { h: 'top', v: 'left' },
  tr: { h: 'top', v: 'right' },
  bl: { h: 'bottom', v: 'left' },
  br: { h: 'bottom', v: 'right' }
};
const CORNER_SEED = { tl: 0xc0f0e001, tr: 0xc0f0e002, bl: 0xc0f0e003, br: 0xc0f0e004 };

/**
 * One corner tile. The structure at any point is the one belonging to
 * whichever band is shallower — min(tH, tV) — which puts the miter seam
 * exactly on the 45-degree diagonal; the two cross-sections are cross-faded
 * across it so the seam reads as cut board rather than as a polygon join.
 * Cast shadows from both bands stack wherever the pixel is bare print.
 */
function renderCorner(key, fibre) {
  const { h, v } = CORNER_SIDES[key];
  const size = BAND.cornerSize;
  const noiseH = makeNoise(SIDE_SEED[h]);
  const noiseV = makeNoise(SIDE_SEED[v]);

  // Seeded per-corner overshoot: some corners are cut clean, some overrun.
  const rng = mulberry32(CORNER_SEED[key]);
  const overcutH = Math.round(rng() * OVERCUT_MAX * 10) / 10;
  const overcutV = Math.round(rng() * OVERCUT_MAX * 10) / 10;

  const dark = new Float64Array(size * size);
  const lift = new Float64Array(size * size);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // tV is depth into the vertical band, tH into the horizontal one; both
      // grow inward from the tile's outer corner.
      const { tV, tH } = cornerCoords(key, px, py);

      const csH = crossSection(h, tH, tV, noiseH, fibre);
      const csV = crossSection(v, tV, tH, noiseV, fibre);

      // Cross-fade on the diagonal: wH = 1 where the horizontal band is
      // clearly shallower, 0 where the vertical one is.
      const wH = 1 - smoothstep01((tH - tV) / SEAM_SOFT + 0.5);
      const shade = wH * csH.shade + (1 - wH) * csV.shade;
      const coreLift = wH * csH.lift + (1 - wH) * csV.lift;
      const print = Math.min(csH.print, csV.print);

      const acc = { dark: 0, lift: 0 };
      accumulate(acc, shade, coreLift);

      if (print > 0) {
        let cast = 0;
        if (tH > PRINT_EDGE) cast = stack(cast, castShadow(h, tH - PRINT_EDGE));
        if (tV > PRINT_EDGE) cast = stack(cast, castShadow(v, tV - PRINT_EDGE));
        acc.dark = stack(acc.dark, print * cast);
      }

      // Ambient occlusion pooling where the two cut faces meet the print.
      const rx = tV - PRINT_EDGE;
      const ry = tH - PRINT_EDGE;
      const r = Math.hypot(rx, ry) / CORNER_AO_REACH;
      acc.dark = stack(acc.dark, CORNER_AO * Math.exp(-r * r));

      // Hand-cut overshoot: each cut runs a little past the other's opening.
      acc.dark = stack(acc.dark, overcut(tH, RIM_START - tV, overcutH));
      acc.dark = stack(acc.dark, overcut(tV, RIM_START - tH, overcutV));

      const i = py * size + px;
      dark[i] = acc.dark;
      lift[i] = acc.lift;
    }
  }

  return { width: size, height: size, dark, lift };
}

// ---------------------------------------------------------------------------
// Encoding + validation
// ---------------------------------------------------------------------------

/**
 * Grey (the blend amount) + alpha (opaque), ready for sharp raw input.
 * `invert` writes the multiply form, where 255 is the neutral value.
 */
function encodeMap(values, invert) {
  const out = Buffer.allocUnsafe(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const amount = invert ? 1 - values[i] : values[i];
    out[i * 2] = Math.min(255, Math.max(0, Math.round(amount * 255)));
    out[i * 2 + 1] = 255;
  }
  return out;
}

async function writeMap(dir, name, tile, values, invert) {
  const file = path.join(dir, name);
  await sharp(encodeMap(values, invert), {
    raw: { width: tile.width, height: tile.height, channels: 2 }
  })
    .toColourspace('b-w')
    .png({ compressionLevel: 9 })
    .toFile(file);
  return file;
}

/**
 * Tiling check: an edge tile repeated along its axis must not show a ridge at
 * the join. Compare the delta across the wrap-around neighbour pair with the
 * worst delta between neighbouring lines inside the tile — a seam-free tile
 * has no bigger jump at the seam than it has anywhere else.
 */
function seamDelta(tile, values) {
  const { width, height } = tile;
  const horizontal = width > height;
  const n = horizontal ? width : height;
  const cross = horizontal ? height : width;
  const at = (line, k) => values[horizontal ? k * width + line : line * width + k];

  let worstInterior = 0;
  for (let line = 0; line + 1 < n; line++) {
    for (let k = 0; k < cross; k++) {
      worstInterior = Math.max(worstInterior, Math.abs(at(line + 1, k) - at(line, k)));
    }
  }
  let seam = 0;
  for (let k = 0; k < cross; k++) {
    seam = Math.max(seam, Math.abs(at(0, k) - at(n - 1, k)));
  }
  return { seam: seam * 255, worstInterior: worstInterior * 255 };
}

/**
 * Mean value at each whole-pixel depth, over the slice of the tile selected
 * by `pick(along)`. Reduces a tile to the cross-section it presents.
 */
function depthProfile(tile, values, coords, pick) {
  const sums = new Float64Array(BAND.thickness);
  const counts = new Uint32Array(BAND.thickness);
  for (let py = 0; py < tile.height; py++) {
    for (let px = 0; px < tile.width; px++) {
      const { t, along } = coords(px, py);
      if (!pick(along)) continue;
      const depth = Math.floor(t);
      if (depth < 0 || depth >= BAND.thickness) continue;
      sums[depth] += values[py * tile.width + px];
      counts[depth]++;
    }
  }
  return sums.map((sum, i) => (counts[i] ? sum / counts[i] : 0));
}

/** How far the tile's own values swing along the axis, at each depth. */
function depthSpread(tile, values, coords) {
  const min = new Float64Array(BAND.thickness).fill(Infinity);
  const max = new Float64Array(BAND.thickness).fill(-Infinity);
  for (let py = 0; py < tile.height; py++) {
    for (let px = 0; px < tile.width; px++) {
      const depth = Math.floor(coords(px, py).t);
      if (depth < 0 || depth >= BAND.thickness) continue;
      const value = values[py * tile.width + px];
      if (value < min[depth]) min[depth] = value;
      if (value > max[depth]) max[depth] = value;
    }
  }
  return min.map((lo, i) => (Number.isFinite(lo) ? (max[i] - lo) / 2 : 0));
}

/**
 * Junction check: where a corner tile's arm hands off to an edge tile, the
 * two must present the same cross-section, or the 9-patch shows a ridge
 * across the bevel at every corner.
 *
 * They cannot match pixel-for-pixel — the along-axis fibre and rim hairline
 * arrive at the junction on whatever phase the window's size happens to
 * produce, and no fixed tile set can predict that. So the contract is: the
 * arm's mean cross-section must sit inside the swing the edge tile's own
 * texture already has at that depth. Structure has to match; texture phase
 * cannot, and is absorbed instead by compositing each tile with a
 * BAND.crossFade ramp onto the one before it, as manifest.json's placement
 * rule requires and preview-matte-band.js demonstrates.
 *
 * Calibrating against the tile's own swing is what makes this a real check:
 * a geometry mismatch (a shifted rim, a wrong bevel width) moves the profile
 * far outside the texture band, while a re-seeded noise lattice does not.
 */
function junctionProfiles(cornerTile, key, side, edgeTile, values, edgeValues) {
  const { h } = CORNER_SIDES[key];
  const isArmSide = side === h;
  const armProfile = depthProfile(
    cornerTile,
    values,
    (px, py) => {
      const { tV, tH } = cornerCoords(key, px, py);
      return isArmSide ? { t: tH, along: tV } : { t: tV, along: tH };
    },
    // The arm is everything past the corner square — by construction, pure
    // edge-like content. Averaging all of it, not just the ramp zone, keeps
    // the comparison about structure rather than about noise residual.
    (along) => along >= BAND.thickness
  );
  const edgeAt = (px, py) => edgeCoords(side, px, py);
  const edgeProfile = depthProfile(edgeTile, edgeValues, edgeAt, () => true);
  const spread = depthSpread(edgeTile, edgeValues, edgeAt);

  let worstDelta = 0;
  let worstRatio = 0;
  for (let i = 0; i < armProfile.length; i++) {
    const delta = Math.abs(armProfile[i] - edgeProfile[i]);
    // A floor of one map level, so depths with no texture at all (a dead-flat
    // profile) don't divide by zero and trip on rounding.
    const allowance = Math.max(1 / 255, spread[i]);
    worstDelta = Math.max(worstDelta, delta);
    worstRatio = Math.max(worstRatio, delta / allowance);
  }
  return { delta: worstDelta * 255, ratio: worstRatio };
}

const CHECK_SWATCHES = {
  'gallery-white': 0xf4, // #f4f1ec, luminance-ish channel
  'museum-black': 0x13   // #131311
};

/**
 * Composite check: run the pair over both extreme swatches and report the
 * range they produce. Plausible means in-range, not clipped away to a flat
 * block, and still carrying visible structure on both.
 */
function compositeRange(tile, base) {
  let min = 255;
  let max = 0;
  let clipped = 0;
  for (let i = 0; i < tile.dark.length; i++) {
    const d = Math.round(tile.dark[i] * 255) / 255;
    const l = Math.round(tile.lift[i] * 255) / 255;
    const afterMultiply = base * (1 - d);
    const value = afterMultiply + (255 - afterMultiply) * l;
    if (value <= 0.5 || value >= 254.5) clipped++;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max, clippedFraction: clipped / tile.dark.length };
}

// ---------------------------------------------------------------------------

async function main() {
  const outDir = path.join(__dirname, '..', 'assets', 'matte-band');
  await fs.mkdir(outDir, { recursive: true });

  const fibre = await loadFibre();

  const edges = {};
  for (const side of SIDES) edges[side] = renderEdge(side, fibre);
  const corners = {};
  for (const key of Object.keys(CORNER_SIDES)) corners[key] = renderCorner(key, fibre);

  const tiles = [
    ...SIDES.map((side) => ({ name: `edge-${side}`, kind: 'edge', tile: edges[side] })),
    ...Object.keys(corners).map((key) => ({ name: `corner-${key}`, kind: 'corner', tile: corners[key] }))
  ];

  const problems = [];

  for (const { name, kind, tile } of tiles) {
    await writeMap(outDir, `${name}.shadow.png`, tile, tile.dark, true);
    await writeMap(outDir, `${name}.highlight.png`, tile, tile.lift, false);

    const notes = [];
    if (kind === 'edge') {
      for (const [map, values] of [['shadow', tile.dark], ['highlight', tile.lift]]) {
        const { seam, worstInterior } = seamDelta(tile, values);
        notes.push(`${map} seam ${seam.toFixed(2)}/255 (interior worst ${worstInterior.toFixed(2)})`);
        if (seam > Math.max(1, worstInterior)) {
          problems.push(`${name}.${map}: seam delta ${seam.toFixed(2)} exceeds interior worst ${worstInterior.toFixed(2)}`);
        }
      }
    }
    for (const [swatch, base] of Object.entries(CHECK_SWATCHES)) {
      const { min, max, clippedFraction } = compositeRange(tile, base);
      notes.push(`${swatch} ${min.toFixed(0)}..${max.toFixed(0)} (clip ${(clippedFraction * 100).toFixed(2)}%)`);
      if (clippedFraction > 0.001) {
        problems.push(`${name}: ${(clippedFraction * 100).toFixed(2)}% of pixels clip over ${swatch}`);
      }
      if (max - min < 12) {
        problems.push(`${name}: only ${(max - min).toFixed(1)} levels of structure over ${swatch}`);
      }
    }
    console.log(`${name}  ${tile.width}x${tile.height}\n    ${notes.join('\n    ')}`);
  }

  // Every arm of every corner has to hand off to its edge tile.
  for (const [key, { h, v }] of Object.entries(CORNER_SIDES)) {
    const notes = [];
    for (const side of [h, v]) {
      for (const [map, pick] of [['shadow', 'dark'], ['highlight', 'lift']]) {
        const { delta, ratio } = junctionProfiles(
          corners[key], key, side, edges[side], corners[key][pick], edges[side][pick]
        );
        notes.push(`${side} ${map} ${delta.toFixed(2)}/255 (${(ratio * 100).toFixed(0)}% of the tile's own swing)`);
        if (ratio > 1) {
          problems.push(
            `corner-${key} -> edge-${side} (${map}): arm cross-section is ` +
            `${delta.toFixed(2)}/255 off its edge tile, past that depth's own texture swing`
          );
        }
      }
    }
    console.log(`corner-${key} junctions\n    ${notes.join('\n    ')}`);
  }

  const manifest = {
    note: 'Generated by scripts/generate-matte-band.js — do not hand-edit.',
    geometry: {
      ...BAND,
      rimStart: RIM_START,
      rimEnd: RIM_END,
      printEdge: PRINT_EDGE,
      unit: '4K reference pixels, measured inward from the band outer boundary'
    },
    composite: {
      shadow: { blend: 'multiply', grey: '255 * (1 - darkening)', neutral: 255 },
      highlight: { blend: 'screen', grey: '255 * lightening', neutral: 0 },
      alpha: 'opaque (255) — the amount is in the grey channel so the blend does not depend on premultiplied-source handling',
      order: 'shadow first, then highlight, over the flat swatch matte colour'
    },
    placement: {
      outerBoundary: 'printEdge px outward of the window (print) rect on every side',
      corners: 'corner-{tl,tr,bl,br}, cornerSize square, anchored at the band outer corner, drawn first and fully opaque',
      edges: 'edge-{top,bottom} are edgeLength x thickness, edge-{left,right} thickness x edgeLength, repeated along the run between the two corners',
      crossFade: 'each edge tile is drawn over the run with a linear crossFade-px ramp on its leading end; the last tile of a run is right-aligned to end crossFade px inside the far corner and additionally ramps out over its trailing crossFade px',
      why: 'a window is any size, so a tile boundary lands on an arbitrary phase of the along-axis fibre and rim hairline. The ramps blend two identical cross-sections, so the junction is smooth at any size; butting the tiles instead leaves a ~14/255 ridge across the bevel at every corner'
    },
    tiles: tiles.map(({ name, tile }) => ({
      name, width: tile.width, height: tile.height,
      maps: [`${name}.shadow.png`, `${name}.highlight.png`]
    }))
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nwrote ${tiles.length * 2} maps + manifest.json to ${outDir}`);
  if (problems.length) {
    console.error(`\nvalidation failed:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(
      'validation: edge tiles seam-free, corner arms hand off to their edges, ' +
      'maps composite in range over both extremes'
    );
  }
}

// preview-matte-band.js is the only consumer; it needs the geometry to lay
// the tiles out. Everything else stays private until #17 asks for it.
module.exports = { BAND, PRINT_EDGE };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
