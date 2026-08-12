const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const heicConvert = require('heic-convert');

/**
 * Collage render engine: composites 1-4 library images into a single
 * 3840x2160 Frame TV canvas with shadowbox matting (matte board, mitered
 * bevel, inner shadow, drop shadow, optional matte texture).
 *
 * Pure function of (recipe, source files) — no routes, no metadata access.
 * The caller resolves each slot's imageId to a file path or Buffer.
 *
 * Recipe shape:
 *   {
 *     template: 'diptych-2' | 'triptych-3' | 'grid-2x2' | 'hero-left' | 'solo',
 *     matte: {
 *       preset: 'gallery-white' | 'ivory' | 'museum-black',
 *       borderWidth: px,
 *       depthStyle: 'miter' | 'recess' | 'double',   // default 'miter'
 *       texture: 'none' | 'fibre' | 'weave'          // default 'none'
 *     },
 *     slots: [{ imageId, focal: { x: 0..1, y: 0..1 } }, ...]
 *   }
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

// The design studies call for a "1px cut line" at their mock scale; at the
// 4K reference canvas that reads as 2px (floors at 1px in previews).
const CUT_LINE_WIDTH = 2;

const TEXTURE_TILE_SIZE = 512;

// Shadow/bevel params are px at 4K reference scale; opacities 0..1.
// textureOpacity is the alpha the texture tile is composited at (soft-light)
// when the recipe selects a texture.
const MATTE_PRESETS = {
  'gallery-white': {
    label: 'Gallery White',
    matteColor: '#f4f1ea',
    textureOpacity: 0.55,
    bevelColor: '#fdfbf5',
    bevelWidth: 12,
    bevelTopShadow: 0.18,
    bevelBottomHighlight: 0.35,
    innerShadow: { opacity: 0.34, blur: 16, offsetY: 9 },
    dropShadow: { opacity: 0.28, blur: 22, offsetY: 10, spread: 5 }
  },
  ivory: {
    label: 'Ivory',
    matteColor: '#f1e9d6',
    textureOpacity: 0.6,
    bevelColor: '#faf4e4',
    bevelWidth: 12,
    bevelTopShadow: 0.16,
    bevelBottomHighlight: 0.32,
    innerShadow: { opacity: 0.3, blur: 15, offsetY: 8 },
    dropShadow: { opacity: 0.26, blur: 20, offsetY: 10, spread: 5 }
  },
  'museum-black': {
    label: 'Museum Black',
    matteColor: '#131311',
    textureOpacity: 0.45,
    bevelColor: '#3b3933',
    bevelTopShadow: 0.4,
    bevelBottomHighlight: 0.12,
    bevelWidth: 10,
    innerShadow: { opacity: 0.5, blur: 18, offsetY: 10 },
    dropShadow: { opacity: 0.55, blur: 26, offsetY: 12, spread: 6 }
  }
};

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

/**
 * Validate a recipe and fill defaults. Throws on structural problems;
 * clamps out-of-range numbers rather than rejecting them.
 */
function normalizeRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') {
    throw new Error('Recipe must be an object');
  }

  const template = getTemplate(recipe.template);

  const matte = recipe.matte || {};
  const presetName = matte.preset || 'gallery-white';
  if (!MATTE_PRESETS[presetName]) {
    throw new Error(
      `Unknown matte preset "${presetName}". Valid presets: ${Object.keys(MATTE_PRESETS).join(', ')}`
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

  const borderNum = Number(matte.borderWidth);
  const borderWidth = Number.isFinite(borderNum)
    ? clamp(borderNum, BORDER_WIDTH.min, BORDER_WIDTH.max)
    : BORDER_WIDTH.default;

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
    matte: { preset: presetName, borderWidth, depthStyle, texture },
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
function revealColor(preset) {
  return luminance(preset.matteColor) > 0.5
    ? shade(preset.matteColor, -0.07)
    : shade(preset.matteColor, 0.12);
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

/** Soft drop shadows behind each print, composited before the photos. */
function buildDropShadowSvg(width, height, windows, preset, scale) {
  const { opacity, blur, offsetY, spread } = preset.dropShadow;
  const blurPx = Math.max(0.5, blur * scale);
  const dy = offsetY * scale;
  const sp = spread * scale;

  const rects = windows.map(win =>
    `<rect x="${win.left - sp}" y="${win.top - sp + dy}" ` +
    `width="${win.width + 2 * sp}" height="${win.height + 2 * sp}" ` +
    `fill="#000000" fill-opacity="${opacity}" filter="url(#ds)"/>`
  ).join('');

  const body =
    `<defs><filter id="ds" x="-30%" y="-30%" width="160%" height="160%">` +
    `<feGaussianBlur stdDeviation="${blurPx}"/></filter></defs>` + rects;

  return svgDocument(width, height, body);
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
function depthBands(preset, depthStyle, scale, win) {
  const base = Math.max(1, Math.round(preset.bevelWidth * scale));
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

/**
 * Four mitered bevel faces between two concentric rects, as trapezoids.
 * Uniform insets make the seams meet at 45°. Top face sits in shadow,
 * bottom catches light (top-lit shadowbox), left/right at half strength.
 */
function miterFaces(outer, inner, preset) {
  const oL = outer.x, oT = outer.y, oR = outer.x + outer.w, oB = outer.y + outer.h;
  const iL = inner.x, iT = inner.y, iR = inner.x + inner.w, iB = inner.y + inner.h;
  const c = preset.bevelColor;
  const face = (points, fill) => `<polygon points="${points}" fill="${fill}"/>`;
  return (
    face(`${oL},${oT} ${oR},${oT} ${iR},${iT} ${iL},${iT}`, shade(c, -preset.bevelTopShadow)) +
    face(`${oL},${oT} ${iL},${iT} ${iL},${iB} ${oL},${oB}`, shade(c, -preset.bevelTopShadow * 0.55)) +
    face(`${oL},${oB} ${iL},${iB} ${iR},${iB} ${oR},${oB}`, shade(c, preset.bevelBottomHighlight)) +
    face(`${oR},${oT} ${oR},${oB} ${iR},${iB} ${iR},${iT}`, shade(c, preset.bevelBottomHighlight * 0.5))
  );
}

/** Hairline where the matte board was cut, along a rect's edge. */
function cutLine(rect, preset, scale, opacity) {
  const w = Math.max(1, Math.round(CUT_LINE_WIDTH * scale));
  return (
    `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" ` +
    `fill="none" stroke="${shade(preset.bevelColor, -0.45)}" ` +
    `stroke-opacity="${opacity}" stroke-width="${w}"/>`
  );
}

/**
 * Per-window matting physics, composited after the photos: the inner shadow
 * the matte casts onto the print, then the depth treatment's bevel bands
 * (mitered faces / reveal ring) overlapping the print edge, plus the
 * recess treatment's top-weighted gradient and corner occlusion.
 */
function buildWindowEffectsSvg(width, height, windows, preset, scale, depthStyle) {
  const { opacity, blur, offsetY } = preset.innerShadow;
  const blurPx = Math.max(0.5, blur * scale);
  const dy = offsetY * scale;
  const pad = Math.ceil(blurPx * 4);

  const defs = [
    `<filter id="is" x="-30%" y="-30%" width="160%" height="160%">` +
    `<feGaussianBlur stdDeviation="${blurPx}"/></filter>`
  ];

  if (depthStyle === 'recess') {
    const gradOpacity = clamp(opacity * 0.5, 0, 1);
    const cornerOpacity = clamp(opacity * 0.4, 0, 1);
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
    const bands = depthBands(preset, depthStyle, scale, win);
    const totalInset = bands.reduce((sum, band) => sum + band.width, 0);
    const inner = insetRect(win, totalInset);

    defs.push(
      `<clipPath id="win${i}"><rect x="${inner.x}" y="${inner.y}" ` +
      `width="${inner.w}" height="${inner.h}"/></clipPath>`
    );

    // Inner shadow: a blurred "donut" around the window, clipped so only the
    // bleed into the print shows; offset down for top-lit depth.
    const donut =
      rectPath(inner.x - pad, inner.y - pad, inner.w + 2 * pad, inner.h + 2 * pad) +
      rectPath(inner.x, inner.y, inner.w, inner.h);
    parts.push(
      `<g clip-path="url(#win${i})">` +
      `<path d="${donut}" fill-rule="evenodd" fill="#000000" ` +
      `fill-opacity="${opacity}" filter="url(#is)" transform="translate(0 ${dy})"/></g>`
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
        parts.push(miterFaces(outerRect, innerRect, preset));
      } else {
        const ring =
          rectPath(outerRect.x, outerRect.y, outerRect.w, outerRect.h) +
          rectPath(innerRect.x, innerRect.y, innerRect.w, innerRect.h);
        parts.push(`<path d="${ring}" fill-rule="evenodd" fill="${revealColor(preset)}"/>`);
      }
      cursor += band.width;
    }

    // Cut line where the matte surface was cut, plus a fainter one at the
    // double treatment's inner matte cut.
    parts.push(cutLine(insetRect(win, 0), preset, scale, 0.55));
    if (bands.length > 1) {
      const innerCutInset = bands[0].width + bands[1].width;
      parts.push(cutLine(insetRect(win, innerCutInset), preset, scale, 0.35));
    }
  });

  return svgDocument(width, height, `<defs>${defs.join('')}</defs>${parts.join('')}`);
}

/**
 * Load a texture tile, scaled to the render (so preview and full renders
 * show the same weave, smaller) with the swatch's opacity baked into its
 * alpha. Composited with tile:true + soft-light over the matte.
 */
async function buildTextureTile(texture, preset, scale) {
  const tilePath = path.join(__dirname, 'assets', `texture-${texture}.png`);
  const size = Math.max(16, Math.round(TEXTURE_TILE_SIZE * scale));
  return sharp(tilePath)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .ensureAlpha(clamp(preset.textureOpacity, 0, 1))
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
  const preset = MATTE_PRESETS[normalized.matte.preset];

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

  const dropShadowSvg = buildDropShadowSvg(width, height, windows, preset, scale);
  const effectsSvg = buildWindowEffectsSvg(
    width, height, windows, preset, scale, normalized.matte.depthStyle
  );

  const composites = [];
  if (normalized.matte.texture !== 'none') {
    const tile = await buildTextureTile(normalized.matte.texture, preset, scale);
    composites.push({ input: tile, tile: true, blend: 'soft-light' });
  }
  composites.push(
    { input: dropShadowSvg, blend: 'over' },
    ...slotLayers.map(layer => ({ ...layer, blend: 'over' })),
    { input: effectsSvg, blend: 'over' }
  );

  const quality = width >= CANVAS.width ? JPEG_QUALITY_FULL : JPEG_QUALITY_PREVIEW;

  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: hexToRgb(preset.matteColor)
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
  MATTE_PRESETS,
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
