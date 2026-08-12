#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const sharp = require('sharp');

const {
  CANVAS,
  TEMPLATES,
  MATTE_SWATCHES,
  DEPTH_STYLES,
  TEXTURES,
  SOLO_WINDOW_ASPECT,
  soloOrientation,
  normalizeRecipe,
  computeLayout,
  computeCoverCrop,
  isHeicBuffer,
  renderCollage,
  renderPreview
} = require('../collage_service');

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function logSuccess(message) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function logError(message) {
  console.log(`${colors.red}✗${colors.reset} ${message}`);
}

const tests = [];
let testPath;

function test(name, fn) {
  tests.push({ name, fn });
}

async function setupTestEnv() {
  testPath = path.join(os.tmpdir(), `frame-art-collage-test-${Date.now()}`);
  await fs.mkdir(testPath, { recursive: true });
}

async function cleanupTestEnv() {
  if (testPath) {
    await fs.rm(testPath, { recursive: true, force: true });
  }
}

async function createSampleImage(filename, width, height, color) {
  const imagePath = path.join(testPath, filename);
  const buffer = await sharp({
    create: { width, height, channels: 3, background: color }
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  await fs.writeFile(imagePath, buffer);
  return imagePath;
}

function makeRecipe(overrides = {}) {
  return {
    template: 'diptych-2',
    matte: { preset: 'gallery-white', borderWidth: 120 },
    slots: [
      { imageId: 'a.jpg', focal: { x: 0.5, y: 0.5 } },
      { imageId: 'b.jpg', focal: { x: 0.5, y: 0.5 } }
    ],
    ...overrides
  };
}

// --- Layout geometry ---

test('computeLayout diptych-2: two symmetric portrait windows inside the border', () => {
  const windows = computeLayout('diptych-2', 120);
  assert.strictEqual(windows.length, 2);

  const [left, right] = windows;
  // Outer margins respected
  assert.strictEqual(left.left, 120);
  assert.strictEqual(left.top, 120);
  assert.strictEqual(right.left + right.width, CANVAS.width - 120);
  assert.strictEqual(left.top + left.height, CANVAS.height - 120);

  // Equal sizes, gutter between them equals borderWidth
  assert.strictEqual(left.width, right.width);
  assert.strictEqual(left.height, right.height);
  assert.strictEqual(right.left - (left.left + left.width), 120);

  // Portrait-leaning windows (the point of a diptych on a landscape canvas)
  assert.ok(left.height > left.width);
});

test('computeLayout triptych-3: three equal-width windows', () => {
  const windows = computeLayout('triptych-3', 120);
  assert.strictEqual(windows.length, 3);
  const widths = windows.map(w => w.width);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 1);
  // All share the same row
  assert.ok(windows.every(w => w.top === windows[0].top));
  // Strongly portrait
  assert.ok(windows[0].height > windows[0].width * 1.5);
});

test('computeLayout grid-2x2: four windows in two rows and two columns', () => {
  const windows = computeLayout('grid-2x2', 120);
  assert.strictEqual(windows.length, 4);
  const tops = [...new Set(windows.map(w => w.top))];
  const lefts = [...new Set(windows.map(w => w.left))];
  assert.strictEqual(tops.length, 2);
  assert.strictEqual(lefts.length, 2);
  // Vertical gutter equals borderWidth
  const [row1, row2] = tops.sort((a, b) => a - b);
  const topWindow = windows.find(w => w.top === row1);
  assert.strictEqual(row2 - (row1 + topWindow.height), 120);
});

test('computeLayout hero-left: one large window plus two stacked equal windows', () => {
  const windows = computeLayout('hero-left', 120);
  assert.strictEqual(windows.length, 3);
  const [hero, topRight, bottomRight] = windows;

  // Hero is the biggest and spans full content height
  assert.ok(hero.width > topRight.width);
  assert.ok(hero.height > topRight.height);
  assert.strictEqual(hero.height, CANVAS.height - 240);

  // Stacked pair aligned in the same column, equal size
  assert.strictEqual(topRight.left, bottomRight.left);
  assert.strictEqual(topRight.width, bottomRight.width);
  assert.ok(Math.abs(topRight.height - bottomRight.height) <= 1);
  assert.strictEqual(bottomRight.top - (topRight.top + topRight.height), 120);
});

test('computeLayout borderWidth scales margins and gutters together', () => {
  const narrow = computeLayout('diptych-2', 60);
  const wide = computeLayout('diptych-2', 240);
  assert.strictEqual(narrow[0].left, 60);
  assert.strictEqual(wide[0].left, 240);
  assert.strictEqual(narrow[1].left - (narrow[0].left + narrow[0].width), 60);
  assert.strictEqual(wide[1].left - (wide[0].left + wide[0].width), 240);
  assert.ok(wide[0].width < narrow[0].width);
  assert.ok(wide[0].height < narrow[0].height);
});

test('computeLayout scale factor shrinks everything proportionally', () => {
  const full = computeLayout('grid-2x2', 120, 1);
  const quarter = computeLayout('grid-2x2', 120, 0.25);
  for (let i = 0; i < full.length; i++) {
    assert.ok(Math.abs(quarter[i].left - full[i].left * 0.25) <= 1);
    assert.ok(Math.abs(quarter[i].top - full[i].top * 0.25) <= 1);
    assert.ok(Math.abs(quarter[i].width - full[i].width * 0.25) <= 1);
    assert.ok(Math.abs(quarter[i].height - full[i].height * 0.25) <= 1);
  }
});

test('computeLayout throws on unknown template', () => {
  assert.throws(() => computeLayout('mosaic-9', 120), /template/i);
});

test('computeLayout solo portrait: one centered 3:4 window spanning content height', () => {
  const windows = computeLayout('solo', 120, 1, 'portrait');
  assert.strictEqual(windows.length, 1);
  const [win] = windows;
  assert.strictEqual(win.height, CANVAS.height - 240);
  assert.strictEqual(win.width, Math.round(win.height * SOLO_WINDOW_ASPECT.portrait));
  // Centered horizontally: equal matte on both sides (±1 rounding)
  const rightGap = CANVAS.width - 120 - (win.left + win.width);
  assert.ok(Math.abs((win.left - 120) - rightGap) <= 1, `off-center: left=${win.left} rightGap=${rightGap}`);
  assert.ok(win.height > win.width);
});

test('computeLayout solo landscape: wider-than-tall 4:3 window; portrait is the default', () => {
  const landscape = computeLayout('solo', 120, 1, 'landscape')[0];
  assert.strictEqual(landscape.width, Math.round(landscape.height * SOLO_WINDOW_ASPECT.landscape));
  assert.ok(landscape.width > landscape.height);

  const defaulted = computeLayout('solo', 120)[0];
  assert.deepStrictEqual(defaulted, computeLayout('solo', 120, 1, 'portrait')[0]);
});

test('soloOrientation maps aspect to window variant, square counts as portrait', () => {
  assert.strictEqual(soloOrientation(3024, 4032), 'portrait');
  assert.strictEqual(soloOrientation(4032, 3024), 'landscape');
  assert.strictEqual(soloOrientation(1000, 1000), 'portrait');
});

// --- Cover crop / focal math ---

test('computeCoverCrop scales source to cover the window', () => {
  const crop = computeCoverCrop(4000, 3000, 1740, 1920, { x: 0.5, y: 0.5 });
  assert.ok(crop.scaledW >= 1740);
  assert.ok(crop.scaledH >= 1920);
  // Height is the binding dimension here: scaledH should match window height
  assert.strictEqual(crop.scaledH, 1920);
  // Crop stays in bounds
  assert.ok(crop.left >= 0);
  assert.ok(crop.left + 1740 <= crop.scaledW);
  assert.strictEqual(crop.top, 0);
});

test('computeCoverCrop centers the crop on the focal point', () => {
  const centered = computeCoverCrop(4000, 2000, 1000, 1000, { x: 0.5, y: 0.5 });
  const expectedCenter = Math.round(0.5 * centered.scaledW - 500);
  assert.strictEqual(centered.left, expectedCenter);

  const left = computeCoverCrop(4000, 2000, 1000, 1000, { x: 0, y: 0.5 });
  assert.strictEqual(left.left, 0);

  const right = computeCoverCrop(4000, 2000, 1000, 1000, { x: 1, y: 0.5 });
  assert.strictEqual(right.left, right.scaledW - 1000);
});

test('computeCoverCrop clamps focal points outside 0..1', () => {
  const crop = computeCoverCrop(4000, 2000, 1000, 1000, { x: 7, y: -3 });
  assert.strictEqual(crop.left, crop.scaledW - 1000);
  assert.strictEqual(crop.top, 0);
});

test('computeCoverCrop upscales sources smaller than the window', () => {
  const crop = computeCoverCrop(400, 300, 1740, 1920, { x: 0.5, y: 0.5 });
  assert.ok(crop.scaledW >= 1740);
  assert.ok(crop.scaledH >= 1920);
});

// --- Recipe validation ---

test('normalizeRecipe fills defaults for focal, swatch, and borderWidth', () => {
  const normalized = normalizeRecipe({
    template: 'diptych-2',
    slots: [{ imageId: 'a.jpg' }, { imageId: 'b.jpg' }]
  });
  assert.strictEqual(normalized.matte.swatch, 'gallery-white');
  assert.strictEqual(typeof normalized.matte.borderWidth, 'number');
  assert.deepStrictEqual(normalized.slots[0].focal, { x: 0.5, y: 0.5 });
});

// --- Recipe v2 resolution (#9) ---

test('legacy v1 recipes resolve to the full v2 matte spec', () => {
  const normalized = normalizeRecipe(makeRecipe({
    matte: { preset: 'museum-black', borderWidth: 100 }
  }));
  const swatch = MATTE_SWATCHES['museum-black'];
  assert.strictEqual(normalized.matte.swatch, 'museum-black');
  assert.strictEqual(normalized.matte.matteColor, swatch.matteColor);
  assert.strictEqual(normalized.matte.bevelColor, swatch.bevelColor);
  assert.strictEqual(normalized.matte.depthStyle, 'miter');
  assert.strictEqual(normalized.matte.texture, 'none');
  assert.strictEqual(normalized.matte.dropShadow, true);
  assert.strictEqual(normalized.matte.depth, true);
  assert.strictEqual(normalized.matte.borderWidth, 100);
  assert.strictEqual(normalized.matte.shadowParams.bevelWidth, swatch.bevelWidth);
  assert.strictEqual(normalized.matte.shadowParams.textureOpacity, swatch.textureOpacity);
  assert.strictEqual(normalized.matte.shadowParams.shadowAngle, 135);
  assert.strictEqual(normalized.matte.shadowParams.umbraOpacity, 0.12);
});

test('normalizeRecipe is idempotent on resolved v2 recipes', () => {
  const once = normalizeRecipe(makeRecipe());
  const twice = normalizeRecipe(once);
  assert.deepStrictEqual(twice, once);
});

test('stored resolved values win over the catalogue', () => {
  // A saved recipe carries its render params; re-tuning the catalogue must
  // not change what an already-saved collage renders.
  const normalized = normalizeRecipe(makeRecipe({
    matte: {
      swatch: 'gallery-white',
      matteColor: '#123456',
      bevelColor: '#654321',
      borderWidth: 120,
      shadowParams: {
        bevelWidth: 20,
        umbraOpacity: 0.9,
        faceTop: -0.6
      }
    }
  }));
  assert.strictEqual(normalized.matte.matteColor, '#123456');
  assert.strictEqual(normalized.matte.bevelColor, '#654321');
  assert.strictEqual(normalized.matte.shadowParams.bevelWidth, 20);
  assert.strictEqual(normalized.matte.shadowParams.umbraOpacity, 0.9);
  assert.strictEqual(normalized.matte.shadowParams.faceTop, -0.6);
  // Untouched params still fill from the light-model defaults
  assert.strictEqual(normalized.matte.shadowParams.umbraBlur, 2);
  assert.strictEqual(normalized.matte.shadowParams.rimWidth, 2.2);
});

test('normalizeRecipe resolves the baked light-model defaults', () => {
  const params = normalizeRecipe(makeRecipe()).matte.shadowParams;
  assert.strictEqual(params.bevelFeather, 0.25);
  assert.strictEqual(params.rimWidth, 2.2);
  assert.strictEqual(params.rimOpacity, 1);
  assert.strictEqual(params.rimFeather, 0.75);
  assert.strictEqual(params.faceTop, -0.23);
  assert.strictEqual(params.faceLeft, 0.45);
  assert.strictEqual(params.rimTop, -0.16);
  assert.strictEqual(params.rimLeft, 0.42);
  assert.strictEqual(params.shadowAngle, 135);
  assert.strictEqual(params.shadowDistance, 10);
  assert.strictEqual(params.umbraOpacity, 0.12);
  assert.strictEqual(params.umbraBlur, 2);
  assert.strictEqual(params.umbraSpread, 0);
  assert.strictEqual(params.penumbraOpacity, 0.08);
  assert.strictEqual(params.penumbraBlur, 6);
  assert.strictEqual(params.penumbraSpread, 7);
});

test('normalizeRecipe rejects malformed colour overrides', () => {
  assert.throws(
    () => normalizeRecipe(makeRecipe({ matte: { swatch: 'ivory', matteColor: 'red' } })),
    /matteColor/
  );
  assert.throws(
    () => normalizeRecipe(makeRecipe({ matte: { swatch: 'ivory', bevelColor: '#12345' } })),
    /bevelColor/
  );
});

test('dropShadow and depth toggles default true and honor false', () => {
  const defaults = normalizeRecipe(makeRecipe()).matte;
  assert.strictEqual(defaults.dropShadow, true);
  assert.strictEqual(defaults.depth, true);

  const flat = normalizeRecipe(makeRecipe({
    matte: { swatch: 'ivory', dropShadow: false, depth: false, borderWidth: 120 }
  })).matte;
  assert.strictEqual(flat.dropShadow, false);
  assert.strictEqual(flat.depth, false);
});

test('normalizeRecipe defaults depthStyle to miter and texture to none', () => {
  const normalized = normalizeRecipe(makeRecipe());
  assert.strictEqual(normalized.matte.depthStyle, 'miter');
  assert.strictEqual(normalized.matte.texture, 'none');
});

test('normalizeRecipe accepts every depth style and texture', () => {
  for (const depthStyle of DEPTH_STYLES) {
    for (const texture of TEXTURES) {
      const normalized = normalizeRecipe(makeRecipe({
        matte: { preset: 'ivory', borderWidth: 120, depthStyle, texture }
      }));
      assert.strictEqual(normalized.matte.depthStyle, depthStyle);
      assert.strictEqual(normalized.matte.texture, texture);
    }
  }
});

test('normalizeRecipe rejects unknown depth styles and textures', () => {
  assert.throws(
    () => normalizeRecipe(makeRecipe({ matte: { depthStyle: 'chamfer' } })),
    /depth style/i
  );
  assert.throws(
    () => normalizeRecipe(makeRecipe({ matte: { texture: 'burlap' } })),
    /texture/i
  );
});

test('normalizeRecipe clamps focal and borderWidth into range', () => {
  const normalized = normalizeRecipe(makeRecipe({
    matte: { preset: 'ivory', borderWidth: 99999 },
    slots: [
      { imageId: 'a.jpg', focal: { x: 4, y: -2 } },
      { imageId: 'b.jpg', focal: { x: 0.25, y: 0.75 } }
    ]
  }));
  assert.ok(normalized.matte.borderWidth <= 400);
  assert.strictEqual(normalized.slots[0].focal.x, 1);
  assert.strictEqual(normalized.slots[0].focal.y, 0);
  assert.strictEqual(normalized.slots[1].focal.x, 0.25);
});

test('normalizeRecipe rejects unknown templates and swatches', () => {
  assert.throws(() => normalizeRecipe(makeRecipe({ template: 'freeform' })), /template/i);
  assert.throws(
    () => normalizeRecipe(makeRecipe({ matte: { preset: 'neon-pink', borderWidth: 120 } })),
    /swatch/i
  );
  assert.throws(
    () => normalizeRecipe(makeRecipe({ matte: { swatch: 'neon-pink', borderWidth: 120 } })),
    /swatch/i
  );
});

test('normalizeRecipe rejects slot count mismatch and missing imageId', () => {
  assert.throws(
    () => normalizeRecipe(makeRecipe({ slots: [{ imageId: 'a.jpg' }] })),
    /slots?/i
  );
  assert.throws(
    () => normalizeRecipe(makeRecipe({
      slots: [{ imageId: 'a.jpg' }, { focal: { x: 0.5, y: 0.5 } }]
    })),
    /imageId/i
  );
});

test('TEMPLATES and MATTE_SWATCHES expose the required entries', () => {
  for (const name of ['diptych-2', 'triptych-3', 'grid-2x2', 'hero-left']) {
    assert.ok(TEMPLATES[name], `missing template ${name}`);
    assert.ok(TEMPLATES[name].slotCount >= 2);
  }
  // The v1 presets plus the #9 off-white family must all exist.
  const required = [
    'gallery-white', 'ivory', 'museum-black',
    'museum-white', 'antique-white', 'warm-grey-white', 'cool-white'
  ];
  for (const name of required) {
    assert.ok(MATTE_SWATCHES[name], `missing swatch ${name}`);
  }
  for (const [name, swatch] of Object.entries(MATTE_SWATCHES)) {
    assert.ok(/^#[0-9a-f]{6}$/i.test(swatch.matteColor), `matteColor for ${name}`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(swatch.bevelColor), `bevelColor for ${name}`);
    assert.ok(swatch.bevelWidth > 0, `bevelWidth for ${name}`);
    assert.ok(swatch.textureOpacity >= 0 && swatch.textureOpacity <= 1, `textureOpacity for ${name}`);
  }
});

// --- HEIC sniffing ---

test('isHeicBuffer detects ftyp/heic containers and rejects JPEG', async () => {
  const fake = Buffer.alloc(24);
  fake.writeUInt32BE(24, 0);
  fake.write('ftyp', 4);
  fake.write('heic', 8);
  assert.strictEqual(isHeicBuffer(fake), true);

  const mif1 = Buffer.alloc(24);
  mif1.writeUInt32BE(24, 0);
  mif1.write('ftyp', 4);
  mif1.write('mif1', 8);
  assert.strictEqual(isHeicBuffer(mif1), true);

  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } }
  }).jpeg().toBuffer();
  assert.strictEqual(isHeicBuffer(jpeg), false);
  assert.strictEqual(isHeicBuffer(Buffer.alloc(4)), false);
});

// --- Render integration ---

test('INTEGRATION: renderCollage produces a 3840x2160 JPEG', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });

  const { buffer, width, height } = await renderCollage(makeRecipe(), {
    'a.jpg': a,
    'b.jpg': b
  });

  const meta = await sharp(buffer).metadata();
  assert.strictEqual(meta.format, 'jpeg');
  assert.strictEqual(meta.width, CANVAS.width);
  assert.strictEqual(meta.height, CANVAS.height);
  assert.strictEqual(width, CANVAS.width);
  assert.strictEqual(height, CANVAS.height);
});

test('INTEGRATION: matte color shows at the canvas corner, photo inside the window', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });

  const { buffer } = await renderCollage(makeRecipe(), { 'a.jpg': a, 'b.jpg': b });

  const raw = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * raw.info.width + x) * raw.info.channels;
    return [raw.data[i], raw.data[i + 1], raw.data[i + 2]];
  };

  // Gutter center (between the two windows, far from every edge) is the one
  // matte region clear of both the frame shadow and the window shadows:
  // expect gallery-white matte there.
  const matte = MATTE_SWATCHES['gallery-white'].matteColor;
  const expected = [
    parseInt(matte.slice(1, 3), 16),
    parseInt(matte.slice(3, 5), 16),
    parseInt(matte.slice(5, 7), 16)
  ];
  const gutter = px(Math.floor(CANVAS.width / 2), Math.floor(CANVAS.height / 2));
  for (let c = 0; c < 3; c++) {
    assert.ok(
      Math.abs(gutter[c] - expected[c]) <= 16,
      `gutter channel ${c}: got ${gutter[c]}, expected ~${expected[c]}`
    );
  }

  // The canvas corner is bare matte too (no frame shadow, no outer drop
  // shadow — nothing paints outside the windows).
  const corner = px(10, 10);
  for (let c = 0; c < 3; c++) {
    assert.ok(
      Math.abs(corner[c] - expected[c]) <= 16,
      `corner channel ${c}: got ${corner[c]}, expected ~${expected[c]}`
    );
  }

  // Center of the left window: red-ish photo should dominate
  const windows = computeLayout('diptych-2', 120);
  const cx = windows[0].left + Math.floor(windows[0].width / 2);
  const cy = windows[0].top + Math.floor(windows[0].height / 2);
  const center = px(cx, cy);
  assert.ok(center[0] > 120, `expected red-dominant pixel, got ${center}`);
  assert.ok(center[0] > center[1] && center[0] > center[2]);
});

test('INTEGRATION: renderPreview uses the same pipeline at ~960px wide', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });

  const { buffer, width, height } = await renderPreview(makeRecipe(), {
    'a.jpg': a,
    'b.jpg': b
  });

  const meta = await sharp(buffer).metadata();
  assert.strictEqual(meta.format, 'jpeg');
  assert.strictEqual(meta.width, 960);
  assert.strictEqual(meta.height, 540);
  assert.strictEqual(width, 960);
  assert.strictEqual(height, 540);
});

test('INTEGRATION: renderCollage accepts buffers as sources and renders all templates', async () => {
  const srcBuffer = await sharp({
    create: { width: 800, height: 1000, channels: 3, background: { r: 60, g: 80, b: 180 } }
  }).jpeg().toBuffer();

  for (const [name, template] of Object.entries(TEMPLATES)) {
    const slots = [];
    const sources = {};
    for (let i = 0; i < template.slotCount; i++) {
      const id = `img-${i}.jpg`;
      slots.push({ imageId: id, focal: { x: 0.5, y: 0.5 } });
      sources[id] = srcBuffer;
    }
    const { buffer } = await renderCollage(
      { template: name, matte: { preset: 'museum-black', borderWidth: 100 }, slots },
      sources,
      { width: 960 }
    );
    const meta = await sharp(buffer).metadata();
    assert.strictEqual(meta.width, 960, `template ${name} width`);
    assert.strictEqual(meta.height, 540, `template ${name} height`);
  }
});

test('INTEGRATION: identical recipe and sources render byte-identical output', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });
  const sources = { 'a.jpg': a, 'b.jpg': b };

  const first = await renderPreview(makeRecipe(), sources);
  const second = await renderPreview(makeRecipe(), sources);
  assert.ok(first.buffer.equals(second.buffer), 'renders should be deterministic');
});

test('INTEGRATION: legacy v1 recipe and its resolved v2 form render byte-identically', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });
  const sources = { 'a.jpg': a, 'b.jpg': b };

  for (const preset of ['gallery-white', 'ivory', 'museum-black']) {
    const legacy = makeRecipe({ matte: { preset, borderWidth: 120 } });
    const resolved = normalizeRecipe(legacy);
    const legacyRender = await renderPreview(legacy, sources);
    const resolvedRender = await renderPreview(resolved, sources);
    assert.ok(
      legacyRender.buffer.equals(resolvedRender.buffer),
      `${preset}: legacy and resolved renders should be byte-identical`
    );
  }
});

test('INTEGRATION: depth toggle changes the render; legacy dropShadow flag does not', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });
  const sources = { 'a.jpg': a, 'b.jpg': b };

  const variants = {};
  for (const [name, matte] of Object.entries({
    on: { swatch: 'gallery-white', borderWidth: 120 },
    noDrop: { swatch: 'gallery-white', borderWidth: 120, dropShadow: false },
    noDepth: { swatch: 'gallery-white', borderWidth: 120, depth: false }
  })) {
    const { buffer } = await renderPreview(makeRecipe({ matte }), sources);
    const meta = await sharp(buffer).metadata();
    assert.strictEqual(meta.width, 960, `${name} width`);
    variants[name] = buffer;
  }
  assert.ok(!variants.on.equals(variants.noDepth), 'depth off should change pixels');
  // The outer drop shadow was removed (a recessed print casts nothing onto
  // the matte); the stored flag survives but no longer affects the render.
  assert.ok(variants.on.equals(variants.noDrop), 'dropShadow flag must not change pixels');
});

test('INTEGRATION: inner shadows stay at the window edge, print centre unchanged', async () => {
  // Regression: a malformed donut hole once collapsed the umbra/penumbra
  // rings into full-window fills, uniformly darkening every print (~19%).
  const src = await createSampleImage('flat.jpg', 1200, 1600, { r: 180, g: 170, b: 160 });
  const { buffer } = await renderCollage(
    { template: 'solo', matte: { swatch: 'gallery-white', borderWidth: 220 }, slots: [{ imageId: 'flat.jpg' }] },
    { 'flat.jpg': src }
  );
  const raw = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (y * raw.info.width + x) * raw.info.channels;
    return [raw.data[i], raw.data[i + 1], raw.data[i + 2]];
  };
  const win = computeLayout('solo', 220, 1, 'portrait')[0];
  const cx = win.left + Math.floor(win.width / 2);
  const cy = win.top + Math.floor(win.height / 2);

  const centre = px(cx, cy);
  for (const [i, expected] of [[0, 180], [1, 170], [2, 160]]) {
    assert.ok(
      Math.abs(centre[i] - expected) <= 8,
      `print centre channel ${i}: got ${centre[i]}, expected ~${expected} (uniform darkening regression)`
    );
  }

  // The shadow band exists near the top cut but has fully decayed by 80px in
  const nearEdge = px(cx, win.top + 18);
  const inside = px(cx, win.top + 80);
  assert.ok(nearEdge[0] < centre[0] - 8, 'expected an edge shadow band near the cut');
  assert.ok(Math.abs(inside[0] - centre[0]) <= 4, 'shadow must decay within the edge band');
});

test('INTEGRATION: tuning overrides change the render', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });
  const sources = { 'a.jpg': a, 'b.jpg': b };

  const base = await renderPreview(makeRecipe(), sources);
  const tuned = await renderPreview(makeRecipe({
    matte: {
      swatch: 'gallery-white', borderWidth: 120,
      shadowParams: { bevelWidth: 30, rimBottom: 0.9, umbraOpacity: 0.8, shadowAngle: 315 }
    }
  }), sources);
  assert.ok(!base.buffer.equals(tuned.buffer), 'tuned params must change pixels');
});

test('INTEGRATION: every catalogue swatch renders', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });
  const sources = { 'a.jpg': a, 'b.jpg': b };

  for (const swatch of Object.keys(MATTE_SWATCHES)) {
    const { buffer } = await renderPreview(
      makeRecipe({ matte: { swatch, borderWidth: 120 } }),
      sources
    );
    const meta = await sharp(buffer).metadata();
    assert.strictEqual(meta.width, 960, `${swatch} width`);
  }
});

test('INTEGRATION: all depth treatments render on light and dark mattes', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });
  const sources = { 'a.jpg': a, 'b.jpg': b };

  const outputs = {};
  for (const preset of ['gallery-white', 'museum-black']) {
    for (const depthStyle of DEPTH_STYLES) {
      const { buffer } = await renderPreview(
        makeRecipe({ matte: { preset, borderWidth: 120, depthStyle } }),
        sources
      );
      const meta = await sharp(buffer).metadata();
      assert.strictEqual(meta.width, 960, `${preset}/${depthStyle} width`);
      assert.strictEqual(meta.height, 540, `${preset}/${depthStyle} height`);
      outputs[`${preset}/${depthStyle}`] = buffer;
    }
    // The treatments must actually look different from each other
    assert.ok(
      !outputs[`${preset}/miter`].equals(outputs[`${preset}/recess`]),
      `${preset}: recess should differ from miter`
    );
    assert.ok(
      !outputs[`${preset}/miter`].equals(outputs[`${preset}/double`]),
      `${preset}: double should differ from miter`
    );
  }
});

test('INTEGRATION: fibre and weave textures modulate the matte, none leaves it flat', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });
  const sources = { 'a.jpg': a, 'b.jpg': b };

  const rendered = {};
  for (const texture of TEXTURES) {
    const { buffer } = await renderPreview(
      makeRecipe({ matte: { preset: 'gallery-white', borderWidth: 120, texture } }),
      sources
    );
    rendered[texture] = buffer;
  }

  assert.ok(!rendered.none.equals(rendered.fibre), 'fibre should change the render');
  assert.ok(!rendered.none.equals(rendered.weave), 'weave should change the render');
  assert.ok(!rendered.fibre.equals(rendered.weave), 'fibre and weave should differ');
});

test('INTEGRATION: solo template picks the window orientation from the source', async () => {
  const portrait = await createSampleImage('p.jpg', 1200, 1600, { r: 60, g: 80, b: 180 });
  const landscape = await createSampleImage('l.jpg', 1600, 1200, { r: 60, g: 80, b: 180 });

  for (const [imageId, filePath, orientation] of [
    ['p.jpg', portrait, 'portrait'],
    ['l.jpg', landscape, 'landscape']
  ]) {
    const recipe = {
      template: 'solo',
      matte: { preset: 'gallery-white', borderWidth: 120 },
      slots: [{ imageId, focal: { x: 0.5, y: 0.5 } }]
    };
    const { buffer } = await renderPreview(recipe, { [imageId]: filePath });

    const raw = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const win = computeLayout('solo', 120, 960 / CANVAS.width, orientation)[0];
    const cx = win.left + Math.floor(win.width / 2);
    const cy = win.top + Math.floor(win.height / 2);
    const i = (cy * raw.info.width + cx) * raw.info.channels;
    // Blue-ish photo pixel at the expected window center for this orientation
    assert.ok(
      raw.data[i + 2] > raw.data[i] && raw.data[i + 2] > 120,
      `${orientation}: expected photo pixel at window center, got ` +
      `[${raw.data[i]}, ${raw.data[i + 1]}, ${raw.data[i + 2]}]`
    );
    // Just inside the canvas edge, past the border, sits matte (not photo):
    // solo windows leave wide matte flanks
    const j = (cy * raw.info.width + Math.floor(win.left / 2)) * raw.info.channels;
    assert.ok(raw.data[j] > 200, `${orientation}: expected matte at window flank`);
  }
});

test('INTEGRATION: treatment + texture recipes render byte-identical across runs', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  const b = await createSampleImage('b.jpg', 1600, 1200, { r: 40, g: 200, b: 40 });
  const sources = { 'a.jpg': a, 'b.jpg': b };
  const recipe = makeRecipe({
    matte: { preset: 'museum-black', borderWidth: 120, depthStyle: 'double', texture: 'weave' }
  });

  const first = await renderPreview(recipe, sources);
  const second = await renderPreview(recipe, sources);
  assert.ok(first.buffer.equals(second.buffer), 'renders should be deterministic');
});

test('INTEGRATION: renderCollage throws when a slot has no source', async () => {
  const a = await createSampleImage('a.jpg', 1200, 1600, { r: 200, g: 40, b: 40 });
  await assert.rejects(
    () => renderCollage(makeRecipe(), { 'a.jpg': a }),
    /b\.jpg/
  );
});

// --- Runner ---

async function runTests() {
  console.log(`${colors.blue}Collage Service Tests${colors.reset}\n`);

  await setupTestEnv();

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      logSuccess(name);
      passed++;
    } catch (error) {
      logError(`${name}`);
      console.error(`  ${error.message}`);
      failed++;
    }
  }

  await cleanupTestEnv();

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(async (err) => {
  console.error('Fatal error:', err);
  await cleanupTestEnv();
  process.exit(1);
});
