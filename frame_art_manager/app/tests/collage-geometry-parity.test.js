#!/usr/bin/env node

// Parity guard: collage-ui/src/geometry.js is a client-side port of the pure
// layout math in collage_service.js. This suite runs both implementations
// over a grid of inputs and fails if they ever disagree, so the port cannot
// silently drift from what the server actually renders.

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const server = require('../collage_service');

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m'
};

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

let client;

test('client exports the same template and matte swatch catalogue', () => {
  assert.deepStrictEqual(Object.keys(client.TEMPLATES), Object.keys(server.TEMPLATES));
  for (const [key, tpl] of Object.entries(server.TEMPLATES)) {
    assert.strictEqual(client.TEMPLATES[key].slotCount, tpl.slotCount, `slotCount for ${key}`);
    assert.strictEqual(client.TEMPLATES[key].label, tpl.label, `label for ${key}`);
  }
  // Both sides load matte_swatches.json, so the full catalogue — colours,
  // bevels, shadow params — must be deep-equal, not just same-keyed.
  assert.deepStrictEqual(client.MATTE_SWATCHES, server.MATTE_SWATCHES);
  assert.deepStrictEqual(client.BORDER_CHIPS, server.BORDER_CHIPS);
  assert.deepStrictEqual(client.SHADOW_PARAM_BOUNDS, server.SHADOW_PARAM_BOUNDS);
});

test('client effectiveShadowParams mirrors server resolution for every swatch', () => {
  for (const key of Object.keys(server.MATTE_SWATCHES)) {
    const resolved = server.normalizeRecipe({
      template: 'solo',
      matte: { swatch: key },
      slots: [{ imageId: 'x.jpg' }]
    }).matte.shadowParams;
    const clientSide = client.effectiveShadowParams({ swatch: key });
    for (const param of Object.keys(server.SHADOW_PARAM_BOUNDS)) {
      assert.ok(
        Math.abs(clientSide[param] - resolved[param]) < 1e-9,
        `${key}.${param}: client ${clientSide[param]} vs server ${resolved[param]}`
      );
    }
    assert.deepStrictEqual(clientSide.innerShadow, resolved.innerShadow, `${key}.innerShadow`);
  }
});

test('client effectiveShadowParams honors overrides the way the server does', () => {
  const matte = {
    swatch: 'museum-black',
    shadowParams: {
      bevelTopShadow: 0.2, cutEdgeBottom: 0.7, bevelFeather: 6,
      innerShadow: { opacity: 0.8 }
    }
  };
  const resolved = server.normalizeRecipe({
    template: 'solo', matte, slots: [{ imageId: 'x.jpg' }]
  }).matte.shadowParams;
  const clientSide = client.effectiveShadowParams(matte);
  for (const param of Object.keys(server.SHADOW_PARAM_BOUNDS)) {
    assert.ok(
      Math.abs(clientSide[param] - resolved[param]) < 1e-9,
      `${param}: client ${clientSide[param]} vs server ${resolved[param]}`
    );
  }
  assert.deepStrictEqual(clientSide.innerShadow, resolved.innerShadow);
});

test('normalized v2 matte keys resolve from catalogue entries the client can select', () => {
  for (const key of Object.keys(server.MATTE_SWATCHES)) {
    const normalized = server.normalizeRecipe({
      template: 'solo',
      matte: { swatch: key },
      slots: [{ imageId: 'x.jpg' }]
    });
    assert.strictEqual(normalized.matte.swatch, key);
    assert.strictEqual(normalized.matte.matteColor, server.MATTE_SWATCHES[key].matteColor);
    assert.strictEqual(normalized.matte.bevelColor, server.MATTE_SWATCHES[key].bevelColor);
    assert.deepStrictEqual(
      normalized.matte.shadowParams.innerShadow,
      server.MATTE_SWATCHES[key].innerShadow
    );
    assert.deepStrictEqual(
      normalized.matte.shadowParams.dropShadow,
      server.MATTE_SWATCHES[key].dropShadow
    );
  }
});

test('client matteForUi round-trips legacy and resolved mattes to selector fields', () => {
  const legacy = client.matteForUi({ preset: 'museum-black', borderWidth: 60 });
  assert.strictEqual(legacy.swatch, 'museum-black');
  assert.strictEqual(legacy.borderWidth, 60);
  assert.strictEqual(legacy.depthStyle, 'miter');
  assert.strictEqual(legacy.texture, 'none');
  assert.strictEqual(legacy.dropShadow, true);
  assert.strictEqual(legacy.depth, true);

  const resolved = server.normalizeRecipe({
    template: 'solo',
    matte: { swatch: 'sage', depthStyle: 'double', texture: 'weave', dropShadow: false, depth: false, borderWidth: 220 },
    slots: [{ imageId: 'x.jpg' }]
  }).matte;
  const ui = client.matteForUi(resolved);
  assert.strictEqual(ui.swatch, 'sage');
  assert.strictEqual(ui.borderWidth, 220);
  assert.strictEqual(ui.depthStyle, 'double');
  assert.strictEqual(ui.texture, 'weave');
  assert.strictEqual(ui.dropShadow, false);
  assert.strictEqual(ui.depth, false);
  // Fine-tune params survive the reopen (stored values keep rendering).
  assert.deepStrictEqual(ui.shadowParams, resolved.shadowParams);
});

test('client canvas and border bounds match the server', () => {
  assert.deepStrictEqual(client.CANVAS, server.CANVAS);
  assert.deepStrictEqual(client.BORDER_WIDTH, server.BORDER_WIDTH);
});

test('client depth styles, textures and solo aspects match the server', () => {
  assert.deepStrictEqual(client.DEPTH_STYLES, server.DEPTH_STYLES);
  assert.deepStrictEqual(client.TEXTURES, server.TEXTURES);
  assert.deepStrictEqual(client.SOLO_WINDOW_ASPECT, server.SOLO_WINDOW_ASPECT);
});

test('soloOrientation agrees across aspect ratios including square', () => {
  const dims = [[600, 900], [900, 600], [1000, 1000], [3024, 4032], [4032, 3024]];
  for (const [w, h] of dims) {
    assert.strictEqual(
      client.soloOrientation(w, h),
      server.soloOrientation(w, h),
      `orientation mismatch for ${w}x${h}`
    );
  }
});

test('computeLayout agrees across every template, border width, scale and orientation', () => {
  const borders = [0, 40, 120, 250, 400];
  const scales = [1, 0.25, 960 / 3840];
  const orientations = [undefined, 'portrait', 'landscape'];
  for (const template of Object.keys(server.TEMPLATES)) {
    for (const border of borders) {
      for (const scale of scales) {
        for (const orientation of orientations) {
          assert.deepStrictEqual(
            client.computeLayout(template, border, scale, orientation),
            server.computeLayout(template, border, scale, orientation),
            `layout mismatch: ${template} border=${border} scale=${scale} orientation=${orientation}`
          );
        }
      }
    }
  }
});

test('computeCoverCrop agrees across aspect ratios and focal points', () => {
  const sources = [[600, 900], [900, 600], [1000, 1000], [3024, 4032]];
  const windows = [[1740, 1920], [960, 540], [1147, 927]];
  const focals = [
    {}, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.5 },
    { x: 0.31, y: 0.87 }, { x: -3, y: 5 }, { x: 'junk', y: null }
  ];
  for (const [srcW, srcH] of sources) {
    for (const [winW, winH] of windows) {
      for (const focal of focals) {
        assert.deepStrictEqual(
          client.computeCoverCrop(srcW, srcH, winW, winH, focal),
          server.computeCoverCrop(srcW, srcH, winW, winH, focal),
          `crop mismatch: src=${srcW}x${srcH} win=${winW}x${winH} focal=${JSON.stringify(focal)}`
        );
      }
    }
  }
});

async function runTests() {
  let passed = 0;
  let failed = 0;

  const geometryPath = path.join(__dirname, '..', 'collage-ui', 'src', 'geometry.js');
  client = await import(pathToFileURL(geometryPath).href);

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`${colors.green}✓${colors.reset} ${name}`);
      passed++;
    } catch (error) {
      console.log(`${colors.red}✗${colors.reset} ${name}`);
      console.log(`  ${error.message}`);
      failed++;
    }
  }

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests();
