/**
 * Client-side port of the pure layout geometry in ../../collage_service.js.
 *
 * The builder needs the exact window rects (template thumbnails, focal-drag
 * overlays) and the exact cover-crop math (converting a pointer drag into a
 * focal delta) without a round-trip per pointermove. Keep this file in
 * lockstep with collage_service.js — tests/collage-geometry-parity.test.js
 * cross-checks both implementations and fails on drift.
 */

import swatchCatalogue from '../../matte_swatches.json' with { type: 'json' };

export const CANVAS = { width: 3840, height: 2160 };

export const BORDER_WIDTH = { min: 0, max: 400, default: 120 };

// Window order matters: slot[i] renders into windows[i].
export const TEMPLATES = {
  'diptych-2': { label: '2-Up Diptych', slotCount: 2 },
  'triptych-3': { label: '3-Up Triptych', slotCount: 3 },
  'grid-2x2': { label: '2x2 Grid', slotCount: 4 },
  'hero-left': { label: 'Hero + 2 Stack', slotCount: 3 },
  solo: { label: 'Solo', slotCount: 1 }
};

// Bevel depth treatments and matte textures (render params live server-side;
// these lists drive the pickers and must match the server's).
export const DEPTH_STYLES = ['miter', 'recess', 'double'];
export const TEXTURES = ['none', 'fibre', 'weave'];

// The solo template picks its single window's aspect from the source photo's
// orientation: portrait sources get a 3:4 window, landscape a 4:3 window.
export const SOLO_WINDOW_ASPECT = { portrait: 3 / 4, landscape: 4 / 3 };

/** Orientation the solo template should use for a source of these dimensions. */
export function soloOrientation(width, height) {
  return width > height ? 'landscape' : 'portrait';
}

// Curated swatch catalogue and named border stops — the same JSON the server
// renders from (matte_swatches.json), so server and client cannot drift.
export const MATTE_SWATCHES = swatchCatalogue.swatches;
export const BORDER_CHIPS = swatchCatalogue.borderChips;

// Tunable matte-look params: [min, max] slider bounds and the per-swatch
// defaults, mirroring collage_service.js resolution (parity-tested there).
// Rim shades run -1..1: negative = darker than the bevel colour.
export const SHADOW_PARAM_BOUNDS = {
  textureOpacity: [0, 1],
  bevelWidth: [0, 400],
  bevelTopShadow: [0, 1],
  bevelBottomHighlight: [0, 1],
  bevelFeather: [0, 20],
  cutLineWidth: [0, 12],
  cutLineFeather: [0, 8],
  cutLineOpacity: [0, 1],
  cutEdgeTop: [-1, 1],
  cutEdgeRight: [-1, 1],
  cutEdgeBottom: [-1, 1],
  cutEdgeLeft: [-1, 1],
  penumbraBlur: [0, 8],
  penumbraOpacity: [0, 2]
};

/**
 * The effective tuning values for a matte: swatch defaults, the server's
 * derived rim shades, then any stored overrides — the same merge
 * normalizeRecipe() performs, so the sliders always show what renders.
 */
export function effectiveShadowParams(matte = {}) {
  const swatch = MATTE_SWATCHES[matte.swatch] || MATTE_SWATCHES['gallery-white'];
  const stored = matte.shadowParams && typeof matte.shadowParams === 'object'
    ? matte.shadowParams
    : {};
  const top = Number.isFinite(stored.bevelTopShadow) ? stored.bevelTopShadow : swatch.bevelTopShadow;
  const bottom = Number.isFinite(stored.bevelBottomHighlight)
    ? stored.bevelBottomHighlight
    : swatch.bevelBottomHighlight;
  const defaults = {
    textureOpacity: swatch.textureOpacity,
    bevelWidth: swatch.bevelWidth,
    bevelTopShadow: swatch.bevelTopShadow,
    bevelBottomHighlight: swatch.bevelBottomHighlight,
    bevelFeather: 2.5,
    cutLineWidth: 1.2,
    cutLineFeather: 1,
    cutLineOpacity: 0.85,
    cutEdgeTop: -(top * 1.6),
    cutEdgeRight: -(top * 0.7),
    cutEdgeBottom: Math.min(0.9, bottom * 1.6),
    cutEdgeLeft: bottom * 0.8,
    penumbraBlur: 2.6,
    penumbraOpacity: 0.45,
    innerShadow: { ...swatch.innerShadow }
  };
  const merged = { ...defaults };
  for (const key of Object.keys(SHADOW_PARAM_BOUNDS)) {
    if (Number.isFinite(stored[key])) merged[key] = stored[key];
  }
  merged.innerShadow = { ...defaults.innerShadow, ...(stored.innerShadow || {}) };
  return merged;
}

/** A fresh sparse v2 matte spec — the server resolves the rest on render. */
export function defaultMatte() {
  return {
    swatch: 'gallery-white',
    borderWidth: BORDER_WIDTH.default,
    depthStyle: 'miter',
    texture: 'none',
    dropShadow: true,
    depth: true
  };
}

/**
 * The builder-editable view of a stored matte spec (legacy v1 `preset` or
 * resolved v2): the selector fields plus any Fine-tune overrides. Resolved
 * colours are dropped (the builder re-resolves from the catalogue), but
 * shadowParams survive so a tuned collage reopens with its tuning intact.
 */
export function matteForUi(matte = {}) {
  const swatch = matte.swatch || matte.preset;
  return {
    ...defaultMatte(),
    ...(swatch && swatch in MATTE_SWATCHES ? { swatch } : {}),
    ...(typeof matte.borderWidth === 'number' ? { borderWidth: matte.borderWidth } : {}),
    ...(matte.depthStyle !== undefined ? { depthStyle: matte.depthStyle } : {}),
    ...(matte.texture !== undefined ? { texture: matte.texture } : {}),
    ...(matte.dropShadow !== undefined ? { dropShadow: matte.dropShadow !== false } : {}),
    ...(matte.depth !== undefined ? { depth: matte.depth !== false } : {}),
    ...(matte.shadowParams && typeof matte.shadowParams === 'object'
      ? { shadowParams: matte.shadowParams }
      : {})
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toUnit(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? clamp(num, 0, 1) : fallback;
}

/**
 * Split a content span into `fractions.length` windows separated by gutters.
 * The last window absorbs rounding so the far edge lands exactly on the margin.
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
export function computeLayout(template, borderWidth, scale = 1, orientation = 'portrait') {
  if (!TEMPLATES[template]) {
    throw new Error(`Unknown collage template "${template}"`);
  }

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

  return windows;
}

/**
 * Fill-and-crop fitting: scale the source to cover the window, then pick the
 * window-sized crop centered on the focal point (clamped to stay in bounds).
 */
export function computeCoverCrop(srcW, srcH, winW, winH, focal = {}) {
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
