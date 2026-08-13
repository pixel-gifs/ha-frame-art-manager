const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const heicConvert = require('heic-convert');

/**
 * Collage render engine: composites 1-4 library images into a single
 * 3840x2160 Frame TV canvas with shadowbox matting (matte board, feathered
 * mitered bevel, lit cut edges, inner shadow, optional matte texture).
 *
 * Pure function of (recipe, source files) — no routes, no metadata access.
 * The caller resolves each slot's imageId to a file path or Buffer.
 *
 * Recipe shape (v2 — normalizeRecipe() resolves everything below):
 *   {
 *     template: 'diptych-2' | 'triptych-3' | 'grid-2x2' | 'hero-left' | 'solo',
 *     matte: {
 *       swatch: key into matte_swatches.json (curated catalogue),
 *       matteColor: '#rrggbb',                       // resolved from swatch
 *       bevelColor: '#rrggbb',                       // resolved from swatch
 *       depthStyle: 'miter' | 'recess' | 'double',   // default 'miter'
 *       texture: 'none' | 'fibre' | 'weave',         // default 'none'
 *       dropShadow: bool,                            // legacy, accepted + stored, no render effect
 *       depth: bool,                                 // default true (bevel + inner shadow)
 *       borderWidth: px,
 *       shadowParams: { textureOpacity, bevelWidth, ...LOOK_DEFAULTS keys }
 *                     // flat tunables: bevel feather, per-side face/rim
 *                     // shades, shadow angle/distance, umbra + penumbra
 *     },
 *     slots: [{ imageId, focal: { x: 0..1, y: 0..1 } }, ...]
 *   }
 *
 * Legacy (v1) recipes carry `matte.preset` and no resolved fields; they
 * resolve to v2 on load, so every saved collage re-renders identically.
 * Saved v2 recipes store the resolved values, which win over the catalogue —
 * rendering a stored recipe as-is (PUT re-render, fluid promote) reproduces
 * it byte-for-byte even after a swatch is re-tuned. The builder is the one
 * deliberate exception: editing re-resolves from the current catalogue
 * (matteForUi drops overrides), so the live preview always shows exactly
 * what a re-save will render.
 *
 * All matte/shadow measurements are expressed in pixels at the 4K reference
 * canvas and scaled uniformly for preview renders, so the preview is the
 * same picture, smaller.
 *
 * Renders are byte-deterministic for identical (recipe, sources): textures
 * come from fixed tiles in assets/, and no runtime randomness is used —
 * the library dedupes by content hash.
 */

const CANVAS = { width: 3840, height: 2160 };

const BORDER_WIDTH = { min: 0, max: 400, default: 120 };

const JPEG_QUALITY_FULL = 92;
const JPEG_QUALITY_PREVIEW = 80;
const PREVIEW_WIDTH = 960;

// Window order matters: slot[i] renders into windows[i].
const TEMPLATES = {
  'diptych-2': { label: '2-Up Diptych', slotCount: 2 },
  'triptych-3': { label: '3-Up Triptych', slotCount: 3 },
  'grid-2x2': { label: '2x2 Grid', slotCount: 4 },
  'hero-left': { label: 'Hero + 2 Stack', slotCount: 3 },
  solo: { label: 'Solo', slotCount: 1 }
};

// Bevel depth treatments (see #7 decision 3 / design-lab studies).
const DEPTH_STYLES = ['miter', 'recess', 'double'];

// Matte surface textures: fixed greyscale tiles in assets/ (decision 4).
const TEXTURES = ['none', 'fibre', 'weave'];

// The solo template picks its single window's aspect from the source photo's
// orientation: portrait sources get a 3:4 window, landscape a 4:3 window
// (both the natural phone-camera aspect, minimizing crop loss).
const SOLO_WINDOW_ASPECT = { portrait: 3 / 4, landscape: 4 / 3 };

// Depth-treatment band widths, as multiples of the swatch's bevelWidth.
const RECESS_WIDTH_FACTOR = 1.7;
const DOUBLE_REVEAL_FACTOR = 2.5;
const DOUBLE_INNER_FACTOR = 0.75;

// The global light model, baked from Matt's tuning-lab sessions (2026-08-12,
// refined 2026-08-13): light from the upper-right (shadow falls down-left at
// 135°), a near-crisp bevel, per-side face/rim shade() factors on the
// swatch's bevel colour (top darkest → left brightest), a soft gradient
// darkening each face toward the cut, thin crisp lit rims, a fine low-
// contrast paper grain, and two subtle tight shadow layers.
// Every key is per-recipe tunable via matte.shadowParams;
// px values are at the 4K reference canvas, blurs are SVG stdDeviations.
// Kept in lockstep with collage-ui/src/geometry.js (parity-tested).
// The *On keys are layer switches, carried as 0/1 numbers so they clamp,
// resolve and parity-test exactly like every other tunable (>= 0.5 is on).
const LOOK_DEFAULTS = {
  texturePitch: 0.5,
  bevelFeather: 0.25,
  facesOn: 1,
  faceTop: -0.23, faceRight: -0.155, faceBottom: -0.045, faceLeft: 0.45,
  faceGradOn: 1, faceGradStrength: 0.22, faceGradLength: 0.67,
  faceGradFeather: 1, faceGradFlip: 1,
  rimsOn: 1, rimWidth: 1.2, rimFeather: 0, rimOpacity: 1,
  rimTop: -0.16, rimRight: -0.1, rimBottom: -0.045, rimLeft: 0.42,
  shadowAngle: 135, shadowDistance: 10,
  umbraOn: 1, umbraOpacity: 0.12, umbraBlur: 2, umbraSpread: 0,
  penumbraOn: 1, penumbraOpacity: 0.08, penumbraBlur: 6, penumbraSpread: 7
};
// The penumbra drifts further along the shadow direction than the umbra.
const PENUMBRA_DRIFT = 1.6;

const TEXTURE_TILE_SIZE = 512;

// Face shadow gradient vectors in objectBoundingBox units, [x1, y1, x2, y2],
// running outer edge → inner edge for each bevel face. A face's bbox is its
// own band strip, so "0" is whichever side of that strip faces the matte.
const FACE_GRADIENT_AXES = {
  top: [0, 0, 0, 1],
  bottom: [0, 1, 0, 0],
  left: [0, 0, 1, 0],
  right: [1, 0, 0, 0]
};

// Curated swatch catalogue: shadow/bevel params are px at 4K reference
// scale, opacities 0..1. textureOpacity is the alpha the texture tile is
// composited at (soft-light) when the recipe selects a texture. Shared with
// the client — see matte_swatches.json.
const SWATCH_CATALOGUE = require('./matte_swatches.json');
const MATTE_SWATCHES = SWATCH_CATALOGUE.swatches;
const BORDER_CHIPS = SWATCH_CATALOGUE.borderChips;

// The numeric tuning fields a resolved matte spec carries, as [min, max]
// clamp bounds for stored overrides. Face/rim shades run -1..1 (negative =
// darker than the bevel colour, positive = lighter). Kept in lockstep with
// the client's copy in collage-ui/src/geometry.js (parity-tested).
const PX_MAX = 400;
const SHADOW_PARAM_BOUNDS = {
  textureOpacity: [0, 1], texturePitch: [0.25, 4],
  bevelWidth: [0, PX_MAX],
  bevelFeather: [0, 20],
  facesOn: [0, 1],
  faceTop: [-1, 1], faceRight: [-1, 1], faceBottom: [-1, 1], faceLeft: [-1, 1],
  faceGradOn: [0, 1], faceGradStrength: [0, 1], faceGradLength: [0.05, 1],
  faceGradFeather: [0, 1], faceGradFlip: [0, 1],
  rimsOn: [0, 1], rimWidth: [0, 12], rimFeather: [0, 8], rimOpacity: [0, 1],
  rimTop: [-1, 1], rimRight: [-1, 1], rimBottom: [-1, 1], rimLeft: [-1, 1],
  shadowAngle: [0, 360], shadowDistance: [0, 80],
  umbraOn: [0, 1], umbraOpacity: [0, 1], umbraBlur: [0, 120], umbraSpread: [0, 80],
  penumbraOn: [0, 1], penumbraOpacity: [0, 1], penumbraBlur: [0, 200], penumbraSpread: [0, 100]
};

/** Layer switches ride as 0/1 numbers; anything from 0.5 up counts as on. */
function isOn(value) {
  return value >= 0.5;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getTemplate(name) {
  const template = TEMPLATES[name];
  if (!template) {
    throw new Error(
      `Unknown collage template "${name}". Valid templates: ${Object.keys(TEMPLATES).join(', ')}`
    );
  }
  return template;
}

function toUnit(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? clamp(num, 0, 1) : fallback;
}

/** Orientation the solo template should use for a source of these dimensions. */
function soloOrientation(width, height) {
  return width > height ? 'landscape' : 'portrait';
}

/**
 * Split a content span into `fractions.length` windows separated by gutters.
 * The last window absorbs rounding so the far edge lands exactly on the margin.
 * Returns [{ start, size }] in the same order as fractions.
 */
function splitSpan(start, total, gutter, fractions) {
  const content = total - gutter * (fractions.length - 1);
  const spans = [];
  let cursor = start;
  let used = 0;
  for (let i = 0; i < fractions.length; i++) {
    const size = i === fractions.length - 1
      ? content - used
      : Math.round(content * fractions[i]);
    spans.push({ start: cursor, size });
    cursor += size + gutter;
    used += size;
  }
  return spans;
}

/**
 * Compute matte window rects for a template. All values in output pixels.
 * borderWidth is at 4K reference scale; `scale` shrinks the whole layout
 * uniformly (e.g. 0.25 for a 960px preview). `orientation` only affects the
 * solo template ('portrait' | 'landscape'; anything else means portrait).
 */
function computeLayout(template, borderWidth, scale = 1, orientation = 'portrait') {
  getTemplate(template);

  const width = Math.round(CANVAS.width * scale);
  const height = Math.round(CANVAS.height * scale);
  const m = Math.round(clamp(Number(borderWidth) || 0, BORDER_WIDTH.min, BORDER_WIDTH.max) * scale);
  const g = m; // one knob: gutters track the outer border

  const contentX = m;
  const contentY = m;
  const contentW = width - 2 * m;
  const contentH = height - 2 * m;

  const windows = [];

  const pushGrid = (colFractions, rowFractions) => {
    const cols = splitSpan(contentX, contentW, g, colFractions);
    const rows = splitSpan(contentY, contentH, g, rowFractions);
    for (const row of rows) {
      for (const col of cols) {
        windows.push({ left: col.start, top: row.start, width: col.size, height: row.size });
      }
    }
  };

  switch (template) {
    case 'diptych-2':
      pushGrid([0.5, 0.5], [1]);
      break;
    case 'triptych-3':
      pushGrid([1 / 3, 1 / 3, 1 / 3], [1]);
      break;
    case 'grid-2x2':
      pushGrid([0.5, 0.5], [0.5, 0.5]);
      break;
    case 'hero-left': {
      const cols = splitSpan(contentX, contentW, g, [0.6, 0.4]);
      const rows = splitSpan(contentY, contentH, g, [0.5, 0.5]);
      windows.push({ left: cols[0].start, top: contentY, width: cols[0].size, height: contentH });
      windows.push({ left: cols[1].start, top: rows[0].start, width: cols[1].size, height: rows[0].size });
      windows.push({ left: cols[1].start, top: rows[1].start, width: cols[1].size, height: rows[1].size });
      break;
    }
    case 'solo': {
      const aspect = SOLO_WINDOW_ASPECT[orientation === 'landscape' ? 'landscape' : 'portrait'];
      const winH = contentH;
      const winW = Math.min(contentW, Math.round(winH * aspect));
      windows.push({
        left: contentX + Math.round((contentW - winW) / 2),
        top: contentY,
        width: winW,
        height: winH
      });
      break;
    }
  }

  for (const win of windows) {
    if (win.width < 1 || win.height < 1) {
      throw new Error(`Border width ${borderWidth} leaves no room for template "${template}" windows`);
    }
  }

  return windows;
}

/**
 * Fill-and-crop fitting: scale the source to cover the window, then pick the
 * window-sized crop centered on the focal point (clamped to stay in bounds).
 */
function computeCoverCrop(srcW, srcH, winW, winH, focal = {}) {
  if (!srcW || !srcH || !winW || !winH) {
    throw new Error('computeCoverCrop requires positive source and window dimensions');
  }

  const scale = Math.max(winW / srcW, winH / srcH);
  const scaledW = Math.max(winW, Math.round(srcW * scale));
  const scaledH = Math.max(winH, Math.round(srcH * scale));

  const fx = toUnit(focal.x, 0.5);
  const fy = toUnit(focal.y, 0.5);

  const left = clamp(Math.round(fx * scaledW - winW / 2), 0, scaledW - winW);
  const top = clamp(Math.round(fy * scaledH - winH / 2), 0, scaledH - winH);

  return { scaledW, scaledH, left, top };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A stored colour override, or the swatch's value when absent/invalid type. */
function resolveColor(value, fallback, field) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw new Error(`matte.${field} must be a #rrggbb colour, got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

/** A stored number override (clamped), or the swatch's value when absent. */
function resolveNumber(value, fallback, min, max) {
  const num = Number(value);
  return Number.isFinite(num) ? clamp(num, min, max) : fallback;
}

/**
 * Resolve a recipe's matte to the full v2 spec. Accepts:
 *  - legacy v1: { preset, borderWidth } — resolves entirely from the catalogue
 *  - sparse v2: { swatch, ...selectors } — resolves params from the catalogue
 *  - stored v2: fully resolved — stored values win over the catalogue
 */
function resolveMatte(matte) {
  const swatchKey = matte.swatch || matte.preset || 'gallery-white';
  const swatch = MATTE_SWATCHES[swatchKey];
  if (!swatch) {
    throw new Error(
      `Unknown matte swatch "${swatchKey}". Valid swatches: ${Object.keys(MATTE_SWATCHES).join(', ')}`
    );
  }

  const depthStyle = matte.depthStyle === undefined ? 'miter' : matte.depthStyle;
  if (!DEPTH_STYLES.includes(depthStyle)) {
    throw new Error(
      `Unknown depth style "${depthStyle}". Valid styles: ${DEPTH_STYLES.join(', ')}`
    );
  }

  const texture = matte.texture === undefined ? 'none' : matte.texture;
  if (!TEXTURES.includes(texture)) {
    throw new Error(
      `Unknown texture "${texture}". Valid textures: ${TEXTURES.join(', ')}`
    );
  }

  const stored = matte.shadowParams && typeof matte.shadowParams === 'object'
    ? matte.shadowParams
    : {};
  const shadowParams = {};
  const resolveKey = (key, fallback) => {
    const [min, max] = SHADOW_PARAM_BOUNDS[key];
    shadowParams[key] = resolveNumber(stored[key], fallback, min, max);
  };
  resolveKey('textureOpacity', swatch.textureOpacity);
  resolveKey('bevelWidth', swatch.bevelWidth);
  for (const [key, fallback] of Object.entries(LOOK_DEFAULTS)) {
    resolveKey(key, fallback);
  }

  return {
    swatch: swatchKey,
    matteColor: resolveColor(matte.matteColor, swatch.matteColor, 'matteColor'),
    bevelColor: resolveColor(matte.bevelColor, swatch.bevelColor, 'bevelColor'),
    depthStyle,
    texture,
    dropShadow: matte.dropShadow !== false,
    depth: matte.depth !== false,
    borderWidth: resolveNumber(matte.borderWidth, BORDER_WIDTH.default, BORDER_WIDTH.min, BORDER_WIDTH.max),
    shadowParams
  };
}

/**
 * Validate a recipe and resolve it to the fully-specified v2 form. Throws on
 * structural problems; clamps out-of-range numbers rather than rejecting them.
 */
function normalizeRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') {
    throw new Error('Recipe must be an object');
  }

  const template = getTemplate(recipe.template);
  const matte = resolveMatte(recipe.matte || {});

  const slots = Array.isArray(recipe.slots) ? recipe.slots : [];
  if (slots.length !== template.slotCount) {
    throw new Error(
      `Template "${recipe.template}" needs ${template.slotCount} slots, got ${slots.length}`
    );
  }

  const normalizedSlots = slots.map((slot, index) => {
    if (!slot || typeof slot.imageId !== 'string' || !slot.imageId.trim()) {
      throw new Error(`Slot ${index} is missing an imageId`);
    }
    const focal = slot.focal || {};
    return {
      imageId: slot.imageId,
      focal: { x: toUnit(focal.x, 0.5), y: toUnit(focal.y, 0.5) }
    };
  });

  return {
    template: recipe.template,
    matte,
    slots: normalizedSlots
  };
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/** Sniff an ISO-BMFF ftyp box with a HEIF brand (extension-independent). */
function isHeicBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return false;
  }
  if (buffer.toString('latin1', 4, 8) !== 'ftyp') {
    return false;
  }
  return HEIC_BRANDS.has(buffer.toString('latin1', 8, 12).toLowerCase());
}

/** Load a source (path or Buffer), converting HEIC/HEIF to JPEG for sharp. */
async function loadSourceBuffer(source) {
  const buffer = Buffer.isBuffer(source) ? source : await fs.readFile(source);
  if (isHeicBuffer(buffer)) {
    const converted = await heicConvert({ buffer, format: 'JPEG', quality: 0.95 });
    return Buffer.from(converted);
  }
  return buffer;
}

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  };
}

/**
 * Lighten (amount > 0, toward white) or darken (amount < 0, toward black)
 * a #rrggbb colour. All bevel-face shading derives from the swatch's bevel
 * colour through this, so every swatch gets consistent miter lighting.
 */
function shade(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c) => clamp(Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)), 0, 255);
  return `#${[mix(r), mix(g), mix(b)].map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Relative luminance 0..1 of a #rrggbb colour (for light/dark decisions). */
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The double treatment's reveal band: a near-tone of the matte colour. */
function revealColor(spec) {
  return luminance(spec.matteColor) > 0.5
    ? shade(spec.matteColor, -0.07)
    : shade(spec.matteColor, 0.12);
}

function rectPath(x, y, w, h) {
  return `M${x} ${y}h${w}v${h}h${-w}Z`;
}

function svgDocument(width, height, body) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `xmlns="http://www.w3.org/2000/svg">${body}</svg>`
  );
}

function insetRect(win, inset) {
  return {
    x: win.left + inset,
    y: win.top + inset,
    w: win.width - 2 * inset,
    h: win.height - 2 * inset
  };
}

/**
 * The bands a depth treatment stacks between the matte surface and the
 * print, outermost first. Band widths are clamped so the print never
 * collapses to nothing.
 */
function depthBands(spec, depthStyle, scale, win) {
  const base = Math.max(1, Math.round(spec.bevelWidth * scale));
  const maxTotal = Math.max(1, Math.floor(Math.min(win.width, win.height) / 2) - 1);

  if (depthStyle === 'double') {
    let bevel = base;
    let reveal = Math.max(1, Math.round(base * DOUBLE_REVEAL_FACTOR));
    let inner = Math.max(1, Math.round(base * DOUBLE_INNER_FACTOR));
    const total = bevel + reveal + inner;
    if (total > maxTotal) {
      const f = maxTotal / total;
      bevel = Math.max(1, Math.floor(bevel * f));
      reveal = Math.max(1, Math.floor(reveal * f));
      inner = Math.max(1, Math.floor(inner * f));
    }
    return [
      { kind: 'bevel', width: bevel },
      { kind: 'reveal', width: reveal },
      { kind: 'bevel', width: inner }
    ];
  }

  const factor = depthStyle === 'recess' ? RECESS_WIDTH_FACTOR : 1;
  const bevel = Math.min(Math.max(1, Math.round(base * factor)), maxTotal);
  return [{ kind: 'bevel', width: bevel }];
}

/** Whether the face shadow gradient contributes anything at these params. */
function faceGradientOn(spec) {
  return isOn(spec.faceGradOn) && spec.faceGradStrength > 0;
}

/**
 * The face shadow gradient's four <linearGradient> defs — one per side,
 * each running perpendicular to that face. objectBoundingBox units (the
 * default) mean a single def per side serves every window and both bands of
 * the double treatment, whatever their widths: each trapezoid's bbox is
 * exactly its own band strip. Vectors run outer edge → inner edge, so
 * unflipped the dark end sits at the matte side; flipped, at the cut.
 * Stops are a solid plateau, a ramp out to `length`, then nothing —
 * feather splits the length between the two, so feather 1 is a plain linear
 * falloff and feather 0 a hard-edged band.
 */
function faceGradientDefs(spec) {
  if (!faceGradientOn(spec)) {
    return [];
  }
  const alpha = clamp(spec.faceGradStrength, 0, 1);
  const length = clamp(spec.faceGradLength, 0.05, 1);
  const plateau = length * (1 - clamp(spec.faceGradFeather, 0, 1));
  const stop = (offset, opacity) =>
    `<stop offset="${offset}" stop-color="#000000" stop-opacity="${opacity}"/>`;
  const stops =
    stop(0, alpha) +
    (plateau > 0 ? stop(plateau, alpha) : '') +
    stop(length, 0) +
    (length < 1 ? stop(1, 0) : '');
  return Object.entries(FACE_GRADIENT_AXES).map(([side, axis]) => {
    const [x1, y1, x2, y2] = isOn(spec.faceGradFlip)
      ? [axis[2], axis[3], axis[0], axis[1]]
      : axis;
    return (
      `<linearGradient id="fg${side}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
      `${stops}</linearGradient>`
    );
  });
}

/**
 * Four mitered bevel faces between two concentric rects, as trapezoids.
 * Uniform insets make the seams meet at 45°. Top face sits in shadow,
 * bottom catches light (top-lit shadowbox), left/right at half strength.
 * Each face optionally carries the shadow gradient as a second polygon on
 * the same points, drawn before the next face so the mitered corners still
 * overlap in the original order.
 */
function miterFaces(outer, inner, spec) {
  const oL = outer.x, oT = outer.y, oR = outer.x + outer.w, oB = outer.y + outer.h;
  const iL = inner.x, iT = inner.y, iR = inner.x + inner.w, iB = inner.y + inner.h;
  const c = spec.bevelColor;
  const grad = faceGradientOn(spec);
  const face = (points, fill, side) =>
    `<polygon points="${points}" fill="${fill}"/>` +
    (grad ? `<polygon points="${points}" fill="url(#fg${side})"/>` : '');
  return (
    face(`${oL},${oT} ${oR},${oT} ${iR},${iT} ${iL},${iT}`, shade(c, spec.faceTop), 'top') +
    face(`${oL},${oT} ${iL},${iT} ${iL},${iB} ${oL},${oB}`, shade(c, spec.faceLeft), 'left') +
    face(`${oL},${oB} ${iL},${iB} ${iR},${iB} ${oR},${oB}`, shade(c, spec.faceBottom), 'bottom') +
    face(`${oR},${oT} ${oR},${oB} ${iR},${iB} ${iR},${iT}`, shade(c, spec.faceRight), 'right')
  );
}

/**
 * The window's outer cut edge as four lit rim strokes: bottom/left brighter
 * than their bevel faces, top/right a touch darker than theirs — simulated
 * light fall on the rim where the matte surface meets the cut.
 */
function cutEdges(rect, spec, scale, opacityFactor) {
  if (!isOn(spec.rimsOn) || spec.rimWidth <= 0 || spec.rimOpacity <= 0) {
    return '';
  }
  const w = Math.max(1, Math.round(spec.rimWidth * scale));
  const opacity = clamp(spec.rimOpacity * opacityFactor, 0, 1);
  const L = rect.x, T = rect.y, R = rect.x + rect.w, B = rect.y + rect.h;
  const half = w / 2;
  // Thin rects, not <line>s: an axis-aligned line has a zero-area bounding
  // box, which collapses the blur filter's region and librsvg drops the
  // element entirely (rims silently vanished). Rects filter correctly.
  // Draw order puts the lit bottom/left rims on top at the corners.
  const rim = (x, y, rw, rh, amount) =>
    `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" ` +
    `fill="${shade(spec.bevelColor, amount)}" fill-opacity="${opacity}" ` +
    `filter="url(#cf)"/>`;
  return (
    rim(L - half, T - half, R - L + w, w, spec.rimTop) +
    rim(R - half, T - half, w, B - T + w, spec.rimRight) +
    rim(L - half, B - half, R - L + w, w, spec.rimBottom) +
    rim(L - half, T - half, w, B - T + w, spec.rimLeft)
  );
}

/**
 * Per-window matting physics, composited after the photos: the inner shadow
 * the matte casts onto the print, then the depth treatment's bevel bands
 * (mitered faces / reveal ring) overlapping the print edge, plus the
 * recess treatment's top-weighted gradient and corner occlusion.
 */
function buildWindowEffectsSvg(width, height, windows, spec, scale, depthStyle) {
  const umbraBlurPx = Math.max(0.3, spec.umbraBlur * scale);
  const penumbraPx = Math.max(0.3, spec.penumbraBlur * scale);
  // Shadow fall: both layers drift along the light direction, the penumbra
  // further (90° = straight down; Matt's model: 135° = down-left).
  const rad = (spec.shadowAngle * Math.PI) / 180;
  const dx = Math.cos(rad) * spec.shadowDistance * scale;
  const dy = Math.sin(rad) * spec.shadowDistance * scale;
  const pad = Math.ceil(Math.max(umbraBlurPx, penumbraPx) * 4) + 8;

  const defs = [
    `<filter id="is" x="-40%" y="-40%" width="180%" height="180%">` +
    `<feGaussianBlur stdDeviation="${umbraBlurPx}"/></filter>`,
    // Wider, fainter second shadow layer: the soft penumbra a real matte
    // edge throws past its umbra.
    `<filter id="ip" x="-60%" y="-60%" width="220%" height="220%">` +
    `<feGaussianBlur stdDeviation="${penumbraPx}"/></filter>`,
    // Feather the bevel construction: faces and seams blur together the way
    // light does on cut board.
    `<filter id="bf" x="-40%" y="-40%" width="180%" height="180%">` +
    `<feGaussianBlur stdDeviation="${Math.max(0.05, spec.bevelFeather * scale)}"/></filter>`,
    `<filter id="cf" x="-40%" y="-40%" width="180%" height="180%">` +
    `<feGaussianBlur stdDeviation="${Math.max(0.05, spec.rimFeather * scale)}"/></filter>`,
    ...faceGradientDefs(spec)
  ];

  if (depthStyle === 'recess') {
    const gradOpacity = clamp(spec.umbraOpacity * 2, 0, 1);
    const cornerOpacity = clamp(spec.umbraOpacity * 1.6, 0, 1);
    defs.push(
      `<linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#000000" stop-opacity="${gradOpacity}"/>` +
      `<stop offset="0.55" stop-color="#000000" stop-opacity="0"/>` +
      `<stop offset="1" stop-color="#000000" stop-opacity="0"/></linearGradient>`
    );
    // One radial per corner, anchored so the dark center sits on the corner.
    const corners = { tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] };
    for (const [id, [cx, cy]] of Object.entries(corners)) {
      defs.push(
        `<radialGradient id="c${id}" cx="${cx}" cy="${cy}" r="1">` +
        `<stop offset="0" stop-color="#000000" stop-opacity="${cornerOpacity}"/>` +
        `<stop offset="1" stop-color="#000000" stop-opacity="0"/></radialGradient>`
      );
    }
  }

  const parts = [];

  windows.forEach((win, i) => {
    const bands = depthBands(spec, depthStyle, scale, win);
    const totalInset = bands.reduce((sum, band) => sum + band.width, 0);
    const inner = insetRect(win, totalInset);

    defs.push(
      `<clipPath id="win${i}"><rect x="${inner.x}" y="${inner.y}" ` +
      `width="${inner.w}" height="${inner.h}"/></clipPath>`
    );

    // Inner shadows: blurred "donuts" around the window, clipped so only
    // the bleed into the print shows, drifting along the shadow direction.
    // Two layers — a tight umbra at the bevel edge and a wide faint
    // penumbra — each with its own spread (how far the darkness reaches in
    // before the blur falloff starts; the donut hole shrinks by spread).
    const shadowLayer = (on, opacity, spread, filterId, drift) => {
      if (!isOn(on) || opacity <= 0) return '';
      const maxSpread = Math.floor(Math.min(inner.w, inner.h) / 2) - 1;
      const s = Math.min(Math.round(spread * scale), Math.max(0, maxSpread));
      // inner is already an {x,y,w,h} rect — inset it directly (insetRect
      // takes window-shaped {left,top,width,height} rects).
      const hole = { x: inner.x + s, y: inner.y + s, w: inner.w - 2 * s, h: inner.h - 2 * s };
      const donut =
        rectPath(inner.x - pad, inner.y - pad, inner.w + 2 * pad, inner.h + 2 * pad) +
        rectPath(hole.x, hole.y, hole.w, hole.h);
      return (
        `<path d="${donut}" fill-rule="evenodd" fill="#000000" ` +
        `fill-opacity="${clamp(opacity, 0, 1)}" filter="url(#${filterId})" ` +
        `transform="translate(${dx * drift} ${dy * drift})"/>`
      );
    };
    parts.push(
      `<g clip-path="url(#win${i})">` +
      shadowLayer(spec.umbraOn, spec.umbraOpacity, spec.umbraSpread, 'is', 1) +
      shadowLayer(spec.penumbraOn, spec.penumbraOpacity, spec.penumbraSpread, 'ip', PENUMBRA_DRIFT) +
      `</g>`
    );

    if (depthStyle === 'recess') {
      // Top-weighted recess gradient + corner occlusion, on the print only.
      const c = Math.min(
        Math.round(totalInset * 3),
        Math.floor(Math.min(inner.w, inner.h) / 2)
      );
      parts.push(
        `<g clip-path="url(#win${i})">` +
        `<rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" fill="url(#rg)"/>` +
        `<rect x="${inner.x}" y="${inner.y}" width="${c}" height="${c}" fill="url(#ctl)"/>` +
        `<rect x="${inner.x + inner.w - c}" y="${inner.y}" width="${c}" height="${c}" fill="url(#ctr)"/>` +
        `<rect x="${inner.x}" y="${inner.y + inner.h - c}" width="${c}" height="${c}" fill="url(#cbl)"/>` +
        `<rect x="${inner.x + inner.w - c}" y="${inner.y + inner.h - c}" width="${c}" height="${c}" fill="url(#cbr)"/>` +
        `</g>`
      );
    }

    // Depth bands, outermost first: mitered faces or a flat reveal ring.
    let cursor = 0;
    for (const band of bands) {
      const outerRect = insetRect(win, cursor);
      const innerRect = insetRect(win, cursor + band.width);
      if (band.kind === 'bevel') {
        // Faces off still consumes the band's inset — the print keeps its
        // size and the strip reads as bare matte, as it does in the lab.
        if (isOn(spec.facesOn)) {
          parts.push(`<g filter="url(#bf)">${miterFaces(outerRect, innerRect, spec)}</g>`);
        }
      } else {
        const ring =
          rectPath(outerRect.x, outerRect.y, outerRect.w, outerRect.h) +
          rectPath(innerRect.x, innerRect.y, innerRect.w, innerRect.h);
        parts.push(`<path d="${ring}" fill-rule="evenodd" fill="${revealColor(spec)}"/>`);
      }
      cursor += band.width;
    }

    // Lit rim where the matte surface was cut, plus a fainter one at the
    // double treatment's inner matte cut.
    parts.push(cutEdges(insetRect(win, 0), spec, scale, 1));
    if (bands.length > 1) {
      const innerCutInset = bands[0].width + bands[1].width;
      parts.push(cutEdges(insetRect(win, innerCutInset), spec, scale, 0.6));
    }
  });

  return svgDocument(width, height, `<defs>${defs.join('')}</defs>${parts.join('')}`);
}

/**
 * Load a texture tile, scaled to the render (so preview and full renders
 * show the same weave, smaller) with the swatch's opacity baked into its
 * alpha. Composited with tile:true + soft-light over the matte.
 */
async function buildTextureTile(texture, spec, scale) {
  const tilePath = path.join(__dirname, 'assets', `texture-${texture}.png`);
  // Pitch is the tile's render-size multiplier: above 1 the grain grows and
  // spreads out, below 1 it tightens. Independent of strength.
  const pitch = clamp(spec.texturePitch, 0.25, 4);
  const size = Math.max(16, Math.round(TEXTURE_TILE_SIZE * scale * pitch));
  // Soft-light on a near-white matte compresses the tile's contrast to
  // sub-JPEG amplitude, so alpha can't control strength — instead expand
  // the tile's deviation around mid-grey (textureOpacity scales the boost)
  // and composite at full opacity.
  const boost = 1 + clamp(spec.textureOpacity, 0, 1) * 9;
  return sharp(tilePath)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .linear(boost, 128 * (1 - boost))
    .png()
    .toBuffer();
}

/** EXIF-oriented pixel dimensions ( .rotate() applies the same orientation). */
function orientedDimensions(meta) {
  const swap = meta.orientation >= 5 && meta.orientation <= 8;
  return {
    width: swap ? meta.height : meta.width,
    height: swap ? meta.width : meta.height
  };
}

/** Resize + focal-crop one source into its window; returns a PNG buffer. */
async function renderSlotImage(sourceBuffer, win, focal) {
  const meta = await sharp(sourceBuffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('Unable to read source image dimensions');
  }

  const { width: srcW, height: srcH } = orientedDimensions(meta);

  const crop = computeCoverCrop(srcW, srcH, win.width, win.height, focal);

  return sharp(sourceBuffer)
    .rotate()
    .resize(crop.scaledW, crop.scaledH, { fit: sharp.fit.fill, kernel: sharp.kernel.lanczos3 })
    .extract({ left: crop.left, top: crop.top, width: win.width, height: win.height })
    .png()
    .toBuffer();
}

/**
 * Render a collage recipe to a JPEG buffer.
 *
 * @param {object} recipe - see module docblock
 * @param {Object<string, string|Buffer>} sources - imageId → file path or Buffer
 * @param {object} [options]
 * @param {number} [options.width=3840] - output width; height keeps 16:9.
 *   Pass 960 (or use renderPreview) for the low-res preview variant.
 * @returns {Promise<{buffer: Buffer, width: number, height: number, recipe: object}>}
 */
async function renderCollage(recipe, sources, options = {}) {
  const normalized = normalizeRecipe(recipe);
  // Flat spec in the shape the SVG builders take: colours + shadow params.
  const spec = {
    matteColor: normalized.matte.matteColor,
    bevelColor: normalized.matte.bevelColor,
    ...normalized.matte.shadowParams
  };

  const width = Math.round(clamp(Number(options.width) || CANVAS.width, 96, CANVAS.width));
  const scale = width / CANVAS.width;
  const height = Math.round(CANVAS.height * scale);

  const slotBuffers = await Promise.all(normalized.slots.map(async (slot, i) => {
    const source = sources && sources[slot.imageId];
    if (source === undefined || source === null) {
      throw new Error(`No source provided for slot ${i} (imageId "${slot.imageId}")`);
    }
    return loadSourceBuffer(source);
  }));

  // Solo picks its window orientation from the (EXIF-oriented) source aspect.
  let orientation = 'portrait';
  if (normalized.template === 'solo') {
    const meta = await sharp(slotBuffers[0]).metadata();
    if (!meta.width || !meta.height) {
      throw new Error('Unable to read source image dimensions');
    }
    const dims = orientedDimensions(meta);
    orientation = soloOrientation(dims.width, dims.height);
  }

  const windows = computeLayout(normalized.template, normalized.matte.borderWidth, scale, orientation);

  const slotLayers = await Promise.all(slotBuffers.map(async (buffer, i) => {
    const input = await renderSlotImage(buffer, windows[i], normalized.slots[i].focal);
    return { input, left: windows[i].left, top: windows[i].top };
  }));

  const composites = [];
  if (normalized.matte.texture !== 'none') {
    const tile = await buildTextureTile(normalized.matte.texture, spec, scale);
    composites.push({ input: tile, tile: true, blend: 'soft-light' });
  }
  // depth off = flat mount: no bevel, inner shadow, or lit edges at all.
  // A recessed print sits behind the matte, so nothing casts outward onto
  // the matte surface — there is deliberately no outer drop shadow.
  composites.push(...slotLayers.map(layer => ({ ...layer, blend: 'over' })));
  if (normalized.matte.depth) {
    const effectsSvg = buildWindowEffectsSvg(
      width, height, windows, spec, scale, normalized.matte.depthStyle
    );
    composites.push({ input: effectsSvg, blend: 'over' });
  }

  const quality = width >= CANVAS.width ? JPEG_QUALITY_FULL : JPEG_QUALITY_PREVIEW;

  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: hexToRgb(spec.matteColor)
    }
  })
    .composite(composites)
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return { buffer, width, height, recipe: normalized };
}

/** Low-res (~960px wide) preview via the exact same pipeline. */
function renderPreview(recipe, sources) {
  return renderCollage(recipe, sources, { width: PREVIEW_WIDTH });
}

module.exports = {
  CANVAS,
  PREVIEW_WIDTH,
  BORDER_WIDTH,
  TEMPLATES,
  MATTE_SWATCHES,
  BORDER_CHIPS,
  SHADOW_PARAM_BOUNDS,
  DEPTH_STYLES,
  TEXTURES,
  SOLO_WINDOW_ASPECT,
  soloOrientation,
  normalizeRecipe,
  computeLayout,
  computeCoverCrop,
  isHeicBuffer,
  loadSourceBuffer,
  renderCollage,
  renderPreview
};
