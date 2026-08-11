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

test('client exports the same template and matte preset keys', () => {
  assert.deepStrictEqual(Object.keys(client.TEMPLATES), Object.keys(server.TEMPLATES));
  for (const [key, tpl] of Object.entries(server.TEMPLATES)) {
    assert.strictEqual(client.TEMPLATES[key].slotCount, tpl.slotCount, `slotCount for ${key}`);
    assert.strictEqual(client.TEMPLATES[key].label, tpl.label, `label for ${key}`);
  }
  assert.deepStrictEqual(Object.keys(client.MATTE_PRESETS), Object.keys(server.MATTE_PRESETS));
  for (const [key, preset] of Object.entries(server.MATTE_PRESETS)) {
    assert.strictEqual(client.MATTE_PRESETS[key].label, preset.label, `label for ${key}`);
    assert.strictEqual(client.MATTE_PRESETS[key].matteColor, preset.matteColor, `matteColor for ${key}`);
  }
});

test('client canvas and border bounds match the server', () => {
  assert.deepStrictEqual(client.CANVAS, server.CANVAS);
  assert.deepStrictEqual(client.BORDER_WIDTH, server.BORDER_WIDTH);
});

test('computeLayout agrees across every template, border width and scale', () => {
  const borders = [0, 40, 120, 250, 400];
  const scales = [1, 0.25, 960 / 3840];
  for (const template of Object.keys(server.TEMPLATES)) {
    for (const border of borders) {
      for (const scale of scales) {
        assert.deepStrictEqual(
          client.computeLayout(template, border, scale),
          server.computeLayout(template, border, scale),
          `layout mismatch: ${template} border=${border} scale=${scale}`
        );
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
