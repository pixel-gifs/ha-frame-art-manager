#!/usr/bin/env node

// HTTP-level tests for /api/collage — the router is mounted in a minimal
// express app over a throwaway FRAME_ART_PATH, and exercised with fetch.

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const express = require('express');
const sharp = require('sharp');

const collageRouter = require('../routes/collage');
const MetadataHelper = require('../metadata_helper');
const { CANVAS } = require('../collage_service');

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m'
};

const tests = [];
let frameArtPath;
let server;
let baseUrl;

function test(name, fn) {
  tests.push({ name, fn });
}

async function createLibraryImage(filename, width, height, color, tags = []) {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: color }
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  await fs.writeFile(path.join(frameArtPath, 'library', filename), buffer);
  const helper = new MetadataHelper(frameArtPath);
  await helper.addImage(filename, 'none', 'None', tags);
}

async function setupTestEnv() {
  frameArtPath = path.join(os.tmpdir(), `frame-art-collage-routes-${Date.now()}`);
  for (const dir of ['library', 'thumbs', 'originals']) {
    await fs.mkdir(path.join(frameArtPath, dir), { recursive: true });
  }
  await fs.writeFile(
    path.join(frameArtPath, 'metadata.json'),
    JSON.stringify({ version: '1.0', images: {}, tags: [] }, null, 2)
  );

  await createLibraryImage('portrait-a.jpg', 600, 900, { r: 180, g: 60, b: 60 }, ['family']);
  await createLibraryImage('portrait-b.jpg', 600, 900, { r: 60, g: 180, b: 60 }, ['family']);
  await createLibraryImage('portrait-c.jpg', 600, 900, { r: 60, g: 60, b: 180 }, ['family', 'hawaii']);
  await createLibraryImage('landscape-a.jpg', 900, 600, { r: 120, g: 120, b: 120 }, ['family']);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.frameArtPath = frameArtPath;
    next();
  });
  app.use('/api/collage', collageRouter);

  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function cleanupTestEnv() {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  if (frameArtPath) {
    await fs.rm(frameArtPath, { recursive: true, force: true });
  }
}

function makeRecipe(overrides = {}) {
  return {
    template: 'diptych-2',
    matte: { preset: 'gallery-white', borderWidth: 120 },
    slots: [
      { imageId: 'portrait-a.jpg', focal: { x: 0.5, y: 0.5 } },
      { imageId: 'portrait-b.jpg', focal: { x: 0.5, y: 0.5 } }
    ],
    ...overrides
  };
}

async function postJson(route, body) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function putJson(route, body) {
  return fetch(`${baseUrl}${route}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function readMetadata() {
  return JSON.parse(await fs.readFile(path.join(frameArtPath, 'metadata.json'), 'utf8'));
}

// --- POST /api/collage/preview ---

test('preview returns a low-res JPEG for a valid recipe', async () => {
  const res = await postJson('/api/collage/preview', { recipe: makeRecipe() });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');

  const buffer = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buffer).metadata();
  assert.strictEqual(meta.width, 960);
  assert.strictEqual(meta.height, 540);
});

// --- Legacy (v1) recipe resolution (#9 acceptance) ---

test('preview accepts a legacy v1 recipe (matte.preset)', async () => {
  const res = await postJson('/api/collage/preview', {
    recipe: makeRecipe({ matte: { preset: 'museum-black', borderWidth: 100 } })
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
});

test('saving a legacy v1 recipe stores the fully-resolved v2 matte spec', async () => {
  const res = await postJson('/api/collage', {
    recipe: makeRecipe({ matte: { preset: 'ivory', borderWidth: 60 } }),
    tags: []
  });
  assert.strictEqual(res.status, 200);
  const { filename } = await res.json();

  const matte = (await readMetadata()).images[filename].collageRecipe.matte;
  assert.strictEqual(matte.swatch, 'ivory');
  assert.strictEqual(matte.preset, undefined, 'preset must not survive resolution');
  assert.strictEqual(matte.borderWidth, 60);
  assert.strictEqual(matte.depthStyle, 'miter');
  assert.strictEqual(matte.texture, 'none');
  assert.strictEqual(matte.dropShadow, true);
  assert.strictEqual(matte.depth, true);
  assert.ok(/^#[0-9a-f]{6}$/i.test(matte.matteColor), 'matteColor resolved');
  assert.ok(/^#[0-9a-f]{6}$/i.test(matte.bevelColor), 'bevelColor resolved');
  assert.ok(matte.shadowParams && matte.shadowParams.innerShadow && matte.shadowParams.dropShadow,
    'shadowParams resolved');
});

test('re-rendering a stored v1 collage via PUT resolves and renders identically', async () => {
  // Save with a legacy recipe, then PUT the same legacy recipe back —
  // the re-render must reproduce the stored file byte-for-byte.
  const legacy = makeRecipe({ matte: { preset: 'gallery-white', borderWidth: 120 } });
  const saveRes = await postJson('/api/collage', { recipe: legacy, tags: [] });
  const { filename } = await saveRes.json();
  const filePath = path.join(frameArtPath, 'library', filename);
  const originalBuffer = await fs.readFile(filePath);

  const res = await putJson(`/api/collage/${filename}`, { recipe: legacy });
  assert.strictEqual(res.status, 200);
  const newBuffer = await fs.readFile(filePath);
  assert.ok(newBuffer.equals(originalBuffer), 'v1 recipe must re-render byte-identically');
});

test('preview rejects an unknown swatch with 400', async () => {
  const res = await postJson('/api/collage/preview', {
    recipe: makeRecipe({ matte: { swatch: 'neon-pink', borderWidth: 120 } })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /swatch/i);
});

test('preview accepts a sparse v2 recipe with toggles and new swatches', async () => {
  const res = await postJson('/api/collage/preview', {
    recipe: makeRecipe({
      matte: {
        swatch: 'warm-grey-white', borderWidth: 220,
        depthStyle: 'double', texture: 'weave', dropShadow: false, depth: true
      }
    })
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
});

test('preview rejects an invalid recipe with 400', async () => {
  const res = await postJson('/api/collage/preview', {
    recipe: makeRecipe({ template: 'bogus' })
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Unknown collage template/);
});

test('preview rejects a missing recipe with 400', async () => {
  const res = await postJson('/api/collage/preview', {});
  assert.strictEqual(res.status, 400);
});

test('preview returns 404 when a slot image is not in the library', async () => {
  const recipe = makeRecipe();
  recipe.slots[1].imageId = 'missing.jpg';
  const res = await postJson('/api/collage/preview', { recipe });
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /missing\.jpg/);
});

test('preview rejects path-traversal imageIds', async () => {
  const recipe = makeRecipe();
  recipe.slots[0].imageId = '../metadata.json';
  const res = await postJson('/api/collage/preview', { recipe });
  assert.strictEqual(res.status, 400);
});

// --- POST /api/collage (save) ---

test('save renders a full-size collage into the library and registers it', async () => {
  const res = await postJson('/api/collage', {
    recipe: makeRecipe(),
    tags: ['collage', 'family']
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.success, true);
  assert.ok(body.filename.endsWith('.jpg'));

  // Full 4K render on disk
  const filePath = path.join(frameArtPath, 'library', body.filename);
  const meta = await sharp(filePath).metadata();
  assert.strictEqual(meta.width, CANVAS.width);
  assert.strictEqual(meta.height, CANVAS.height);

  // Registered in metadata with recipe + tags
  const metadata = await readMetadata();
  const entry = metadata.images[body.filename];
  assert.ok(entry, 'image must be registered in metadata.json');
  assert.deepStrictEqual(entry.tags, ['collage', 'family']);
  assert.strictEqual(entry.collageRecipe.template, 'diptych-2');
  assert.strictEqual(entry.collageRecipe.slots.length, 2);
  assert.ok(metadata.tags.includes('collage'), 'new tags join the global tag list');

  // Thumbnail generated
  await fs.access(path.join(frameArtPath, 'thumbs', `thumb_${body.filename}`));
});

test('save rejects an invalid recipe with 400 and writes nothing', async () => {
  const before = Object.keys((await readMetadata()).images).length;
  const res = await postJson('/api/collage', {
    recipe: makeRecipe({ template: 'bogus' })
  });
  assert.strictEqual(res.status, 400);
  const after = Object.keys((await readMetadata()).images).length;
  assert.strictEqual(after, before, 'no metadata entry on failure');
});

// --- PUT /api/collage/:imageId (re-render) ---

test('put re-renders an existing collage in place with the edited recipe', async () => {
  const saveRes = await postJson('/api/collage', { recipe: makeRecipe(), tags: [] });
  const { filename } = await saveRes.json();
  const filePath = path.join(frameArtPath, 'library', filename);
  const originalBuffer = await fs.readFile(filePath);

  const edited = makeRecipe({ matte: { preset: 'museum-black', borderWidth: 200 } });
  const res = await putJson(`/api/collage/${filename}`, { recipe: edited });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.filename, filename);

  const newBuffer = await fs.readFile(filePath);
  assert.ok(!newBuffer.equals(originalBuffer), 'JPG must be replaced in place');

  const entry = (await readMetadata()).images[filename];
  assert.strictEqual(entry.collageRecipe.matte.swatch, 'museum-black');
  assert.strictEqual(entry.collageRecipe.matte.borderWidth, 200);
});

test('put returns 404 for an image that does not exist', async () => {
  const res = await putJson('/api/collage/nope.jpg', { recipe: makeRecipe() });
  assert.strictEqual(res.status, 404);
});

test('put returns 400 for an image that is not a collage', async () => {
  const res = await putJson('/api/collage/portrait-a.jpg', { recipe: makeRecipe() });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /not a collage/i);
});

// --- POST /api/collage/auto ---

test('auto builds and saves a collage unattended from a tag pool', async () => {
  const res = await postJson('/api/collage/auto', {
    tagPool: ['family'],
    template: 'diptych-2',
    mattePreset: 'ivory',
    tags: ['auto-collage']
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.success, true);
  assert.ok(body.filename);

  const entry = (await readMetadata()).images[body.filename];
  assert.ok(entry, 'auto collage must be registered');
  assert.deepStrictEqual(entry.tags, ['auto-collage']);
  assert.strictEqual(entry.collageRecipe.template, 'diptych-2');
  assert.strictEqual(entry.collageRecipe.matte.swatch, 'ivory');

  // Slots drawn from tagged portraits only (never the landscape, never other collages)
  entry.collageRecipe.slots.forEach(slot => {
    assert.ok(
      ['portrait-a.jpg', 'portrait-b.jpg', 'portrait-c.jpg'].includes(slot.imageId),
      `unexpected slot image ${slot.imageId}`
    );
  });

  const meta = await sharp(path.join(frameArtPath, 'library', body.filename)).metadata();
  assert.strictEqual(meta.width, CANVAS.width);
});

test('auto rejects a missing tagPool with 400', async () => {
  const res = await postJson('/api/collage/auto', {});
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /tagPool/);
});

test('auto returns 400 when the pool has too few compatible portraits', async () => {
  const res = await postJson('/api/collage/auto', {
    tagPool: ['hawaii'],
    template: 'triptych-3'
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Not enough/);
});

// --- POST /api/collage/suggest ---

test('suggest returns a renderable recipe without saving anything', async () => {
  const imagesBefore = Object.keys((await readMetadata()).images);
  const libraryBefore = await fs.readdir(path.join(frameArtPath, 'library'));

  const res = await postJson('/api/collage/suggest', {
    tagPool: ['family'],
    template: 'diptych-2',
    mattePreset: 'ivory'
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.recipe, 'response must include a recipe');
  assert.strictEqual(body.recipe.template, 'diptych-2');
  assert.strictEqual(body.recipe.matte.swatch, 'ivory');
  assert.strictEqual(body.recipe.slots.length, 2);
  body.recipe.slots.forEach(slot => {
    assert.ok(
      ['portrait-a.jpg', 'portrait-b.jpg', 'portrait-c.jpg'].includes(slot.imageId),
      `unexpected slot image ${slot.imageId}`
    );
    assert.deepStrictEqual(slot.focal, { x: 0.5, y: 0.5 });
  });

  // Dry run: no new metadata entry, no new library file
  const imagesAfter = Object.keys((await readMetadata()).images);
  assert.deepStrictEqual(imagesAfter, imagesBefore, 'suggest must not register images');
  const libraryAfter = await fs.readdir(path.join(frameArtPath, 'library'));
  assert.deepStrictEqual(libraryAfter, libraryBefore, 'suggest must not write library files');
});

test('suggest works with only a tagPool (random template + preset)', async () => {
  const res = await postJson('/api/collage/suggest', { tagPool: ['family'] });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.recipe.template, 'recipe must have a template');
  assert.ok(body.recipe.matte.swatch, 'recipe must have a matte swatch');
  assert.ok(body.recipe.slots.length >= 2);
});

test('suggest rejects a missing tagPool with 400', async () => {
  const res = await postJson('/api/collage/suggest', {});
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /tagPool/);
});

test('suggest returns 400 when the pool has too few compatible portraits', async () => {
  const res = await postJson('/api/collage/suggest', {
    tagPool: ['hawaii'],
    template: 'grid-2x2'
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Not enough/);
});

async function runTests() {
  let passed = 0;
  let failed = 0;

  try {
    await setupTestEnv();

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
  } finally {
    await cleanupTestEnv();
  }

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  // No process.exit(): a hard exit races libuv handle teardown (sharp/undici)
  // on Windows and aborts with a UV_HANDLE_CLOSING assertion.
  process.exitCode = failed > 0 ? 1 : 0;
}

runTests();
