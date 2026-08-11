const fs = require('fs').promises;
const sharp = require('sharp');
const heicConvert = require('heic-convert');

/**
 * Collage render engine: composites 2-4 library images into a single
 * 3840x2160 Frame TV canvas with shadowbox matting (matte board, bevel,
 * inner shadow, drop shadow).
 *
 * Pure function of (recipe, source files) — no routes, no metadata access.
 * The caller resolves each slot's imageId to a file path or Buffer.
 *
 * Recipe shape:
 *   {
 *     template: 'diptych-2' | 'triptych-3' | 'grid-2x2' | 'hero-left',
 *     matte: { preset: 'gallery-white' | 'ivory' | 'museum-black', borderWidth: px },
 *     slots: [{ imageId, focal: { x: 0..1, y: 0..1 } }, ...]
 *   }
 *
 * All matte/shadow measurements are expressed in pixels at the 4K reference
 * canvas and scaled uniformly for preview renders, so the preview is the
 * same picture, smaller.
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
  'hero-left': { label: 'Hero + 2 Stack', slotCount: 3 }
};

// Shadow/bevel params are px at 4K reference scale; opacities 0..1.
const MATTE_PRESETS = {
  'gallery-white': {
    label: 'Gallery White',
    matteColor: '#f4f1ea',
    textureTint: '#e6e1d4',
    textureOpacity: 0.05,
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
    textureTint: '#e3d7bc',
    textureOpacity: 0.06,
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
    textureTint: '#26251f',
    textureOpacity: 0.05,
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

// Deterministic PRNG (mulberry32) so identical (recipe, sources) renders are
// byte-identical — the library dedupes by content hash.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toUnit(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? clamp(num, 0, 1) : fallback;
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
 * uniformly (e.g. 0.25 for a 960px preview).
 */
function computeLayout(template, borderWidth, scale = 1) {
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
    matte: { preset: presetName, borderWidth },
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

/**
 * Per-window matting physics, composited after the photos:
 * inner shadow cast by the matte onto the print, then the bevel ring
 * (the cut matte-board core overlapping the print edge) with directional
 * shading — top edge in shadow, bottom edge catching light.
 */
function buildWindowEffectsSvg(width, height, windows, preset, scale) {
  const bevel = Math.max(1, Math.round(preset.bevelWidth * scale));
  const { opacity, blur, offsetY } = preset.innerShadow;
  const blurPx = Math.max(0.5, blur * scale);
  const dy = offsetY * scale;
  const pad = Math.ceil(blurPx * 4);

  const defs = [
    `<filter id="is" x="-30%" y="-30%" width="160%" height="160%">` +
    `<feGaussianBlur stdDeviation="${blurPx}"/></filter>`
  ];
  const parts = [];

  windows.forEach((win, i) => {
    const inner = {
      x: win.left + bevel,
      y: win.top + bevel,
      w: win.width - 2 * bevel,
      h: win.height - 2 * bevel
    };

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

    // Bevel ring: matte-board core color overlapping the print's outer edge.
    const ring =
      rectPath(win.left, win.top, win.width, win.height) +
      rectPath(inner.x, inner.y, inner.w, inner.h);
    parts.push(`<path d="${ring}" fill-rule="evenodd" fill="${preset.bevelColor}"/>`);

    // Directional shading on the ring: top/left recede, bottom/right catch light.
    parts.push(
      `<rect x="${win.left}" y="${win.top}" width="${win.width}" height="${bevel}" ` +
      `fill="#000000" fill-opacity="${preset.bevelTopShadow}"/>`,
      `<rect x="${win.left}" y="${win.top}" width="${bevel}" height="${win.height}" ` +
      `fill="#000000" fill-opacity="${preset.bevelTopShadow * 0.6}"/>`,
      `<rect x="${win.left}" y="${win.top + win.height - bevel}" width="${win.width}" height="${bevel}" ` +
      `fill="#ffffff" fill-opacity="${preset.bevelBottomHighlight}"/>`,
      `<rect x="${win.left + win.width - bevel}" y="${win.top}" width="${bevel}" height="${win.height}" ` +
      `fill="#ffffff" fill-opacity="${preset.bevelBottomHighlight * 0.5}"/>`
    );
  });

  return svgDocument(width, height, `<defs>${defs.join('')}</defs>${parts.join('')}`);
}

/**
 * Subtle paper-grain texture over the matte: per-pixel noise around a
 * neutral gray biased toward the preset's texture tint, alpha-baked and
 * composited with 'overlay' so it modulates rather than covers.
 */
async function buildTextureLayer(width, height, preset) {
  const tint = hexToRgb(preset.textureTint);
  const alpha = Math.round(255 * clamp(preset.textureOpacity, 0, 1));
  const channels = 4;
  const data = Buffer.allocUnsafe(width * height * channels);
  const random = mulberry32(0x9e3779b9 ^ (width * 31 + height));

  for (let i = 0; i < data.length; i += channels) {
    const grain = Math.round((random() * 2 - 1) * 24);
    data[i] = clamp(Math.round(128 * 0.75 + tint.r * 0.25) + grain, 0, 255);
    data[i + 1] = clamp(Math.round(128 * 0.75 + tint.g * 0.25) + grain, 0, 255);
    data[i + 2] = clamp(Math.round(128 * 0.75 + tint.b * 0.25) + grain, 0, 255);
    data[i + 3] = alpha;
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** Resize + focal-crop one source into its window; returns a PNG buffer. */
async function renderSlotImage(sourceBuffer, win, focal) {
  const meta = await sharp(sourceBuffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('Unable to read source image dimensions');
  }

  // .rotate() below applies EXIF orientation, so work in oriented dimensions.
  const swap = meta.orientation >= 5 && meta.orientation <= 8;
  const srcW = swap ? meta.height : meta.width;
  const srcH = swap ? meta.width : meta.height;

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

  const windows = computeLayout(normalized.template, normalized.matte.borderWidth, scale);

  const slotLayers = await Promise.all(normalized.slots.map(async (slot, i) => {
    const source = sources && sources[slot.imageId];
    if (source === undefined || source === null) {
      throw new Error(`No source provided for slot ${i} (imageId "${slot.imageId}")`);
    }
    const buffer = await loadSourceBuffer(source);
    const input = await renderSlotImage(buffer, windows[i], slot.focal);
    return { input, left: windows[i].left, top: windows[i].top };
  }));

  const textureLayer = await buildTextureLayer(width, height, preset);
  const dropShadowSvg = buildDropShadowSvg(width, height, windows, preset, scale);
  const effectsSvg = buildWindowEffectsSvg(width, height, windows, preset, scale);

  const quality = width >= CANVAS.width ? JPEG_QUALITY_FULL : JPEG_QUALITY_PREVIEW;

  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: hexToRgb(preset.matteColor)
    }
  })
    .composite([
      { input: textureLayer, blend: 'overlay' },
      { input: dropShadowSvg, blend: 'over' },
      ...slotLayers.map(layer => ({ ...layer, blend: 'over' })),
      { input: effectsSvg, blend: 'over' }
    ])
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
  normalizeRecipe,
  computeLayout,
  computeCoverCrop,
  isHeicBuffer,
  loadSourceBuffer,
  renderCollage,
  renderPreview
};
