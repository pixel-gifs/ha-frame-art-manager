#!/usr/bin/env node

// HTTP-level tests for fluid rotation (#12) and promote (#13):
// POST /api/collage/groups/:name/next advances a fluid group by exactly one
// collage — generate, then delete the previous one — and POST
// /api/collage/promote lifts any logged recipe back out of the rotation as a
// permanent collage. The router is mounted in a minimal express app over a
// throwaway FRAME_ART_PATH and exercised with fetch.

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const express = require('express');
const sharp = require('sharp');

const collageRouter = require('../routes/collage');
const MetadataHelper = require('../metadata_helper');
const { STATE_FILE } = require('../collage_state');

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

async function createLibraryImage(filename, width, height, tags = []) {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  await fs.writeFile(path.join(frameArtPath, 'library', filename), buffer);
  await new MetadataHelper(frameArtPath).addImage(filename, 'none', 'None', tags);
}

async function setupTestEnv() {
  frameArtPath = path.join(os.tmpdir(), `frame-art-rotation-${Date.now()}`);
  for (const dir of ['library', 'thumbs', 'originals']) {
    await fs.mkdir(path.join(frameArtPath, dir), { recursive: true });
  }
  await fs.writeFile(
    path.join(frameArtPath, 'metadata.json'),
    JSON.stringify({ version: '1.0', images: {}, tags: [] }, null, 2)
  );

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

function request(method, route, body) {
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const get = route => request('GET', route);
const post = (route, body) => request('POST', route, body);
const put = (route, body) => request('PUT', route, body);

/** POST/GET and parse in one step — the body may only be read once. */
async function json(res) {
  return { status: res.status, body: await res.json() };
}

async function readMetadata() {
  return JSON.parse(await fs.readFile(path.join(frameArtPath, 'metadata.json'), 'utf8'));
}

async function readState() {
  return JSON.parse(await fs.readFile(path.join(frameArtPath, STATE_FILE), 'utf8'));
}

/** The library filenames currently stamped as a group's batch. */
async function batchOf(groupName) {
  const metadata = await readMetadata();
  return Object.entries(metadata.images)
    .filter(([, entry]) => entry.collageGroup === groupName)
    .map(([filename]) => filename)
    .sort();
}

function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

const libraryFile = filename => path.join(frameArtPath, 'library', filename);
const thumbFile = filename => path.join(frameArtPath, 'thumbs', `thumb_${filename}`);

/** Advance the rotation, asserting it took. */
async function next(name = 'rotate') {
  const { status, body } = await json(await post(`/api/collage/groups/${name}/next`));
  assert.strictEqual(status, 200, `next failed: ${JSON.stringify(body)}`);
  return body;
}

async function createGroup(overrides = {}) {
  const { status, body } = await json(await post('/api/collage/groups', {
    name: 'rotate',
    sourceTags: ['family'],
    outputTag: 'rotate-collage',
    matteSpec: { swatch: 'ivory', borderWidth: 120 },
    templatePool: ['diptych-2'],
    mode: 'fluid',
    ...overrides
  }));
  assert.strictEqual(status, 201, `group create failed: ${JSON.stringify(body)}`);
  return body.group;
}

// --- fluid steps ---

test('next renders one collage into the rotation', async () => {
  for (const [name, w, h] of [['p1.jpg', 600, 900], ['p2.jpg', 600, 900], ['p3.jpg', 600, 900], ['p4.jpg', 600, 900]]) {
    await createLibraryImage(name, w, h, ['family']);
  }
  await createGroup();

  const body = await next();

  assert.strictEqual(body.success, true);
  assert.ok(body.filename, 'the new collage is named in the response');
  assert.deepStrictEqual(body.removed, [], 'the first step has nothing to replace');
  assert.deepStrictEqual(body.cycle, { used: 2, total: 4 }, 'cycle progress is reported');
  assert.strictEqual(body.imageIds.length, 2);
  assert.ok(body.entry, 'the step is logged and the log id comes back');

  const metadata = await readMetadata();
  const entry = metadata.images[body.filename];
  assert.ok(entry, 'the collage is registered');
  assert.deepStrictEqual(entry.tags, ['rotate-collage'], 'only the group output tag is applied');
  assert.strictEqual(entry.collageGroup, 'rotate', 'the collage is stamped with its group');
  assert.ok(await exists(libraryFile(body.filename)));
  assert.ok(await exists(thumbFile(body.filename)));

  const built = await sharp(libraryFile(body.filename)).metadata();
  assert.strictEqual(built.width, 3840);
});

test('the next step hard-deletes the previous collage', async () => {
  const before = await batchOf('rotate');
  assert.strictEqual(before.length, 1, 'precondition: one collage in rotation');

  const body = await next();

  assert.deepStrictEqual(body.removed, before, 'the previous collage is replaced');
  assert.deepStrictEqual(await batchOf('rotate'), [body.filename], 'exactly one collage rotates');

  const metadata = await readMetadata();
  assert.ok(!metadata.images[before[0]], 'the old entry is gone from metadata');
  assert.strictEqual(await exists(libraryFile(before[0])), false, 'the old file is gone');
  assert.strictEqual(await exists(thumbFile(before[0])), false, 'the old thumbnail is gone');
});

test('steps cover the pool before repeating, then start a new cycle', async () => {
  const second = await readState();
  assert.deepStrictEqual(second.groups.rotate.used.length, 4, 'two steps have shown all four photos');

  const third = await next();
  assert.deepStrictEqual(third.cycle, { used: 2, total: 4 }, 'the cycle resets once the pool empties');

  const state = await readState();
  assert.strictEqual(state.groups.rotate.cycles, 1, 'the completed cycle is counted');
  assert.strictEqual(state.groups.rotate.current, third.filename);
  assert.strictEqual(state.groups.rotate.log.length, 3, 'every step is logged');
  assert.strictEqual(state.groups.rotate.log[0].filename, third.filename, 'newest first');
});

test('the group listing carries cycle progress and the recipe log', async () => {
  const { groups } = await (await get('/api/collage/groups')).json();
  const group = groups.find(item => item.name === 'rotate');

  assert.ok(group.fluid, 'a fluid group reports its rotation state');
  assert.deepStrictEqual(group.fluid.cycle, { used: 2, total: 4 });
  assert.strictEqual(group.fluid.cycles, 1);
  assert.strictEqual(group.fluid.log.length, 3);
  assert.ok(group.fluid.log[0].recipe, 'logged recipes come back so the UI can preview them');
  assert.ok(group.fluid.current, 'the live collage is named');
});

test('a failed render leaves the live collage and the cycle untouched', async () => {
  const before = await batchOf('rotate');
  const stateBefore = await readState();

  // Metadata entries whose files are gone: selection still picks them, the
  // render cannot resolve them.
  for (const source of ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']) {
    await fs.unlink(libraryFile(source));
  }

  const res = await post('/api/collage/groups/rotate/next');
  assert.ok(res.status >= 400, 'a step that cannot render must fail loudly');

  assert.deepStrictEqual(await batchOf('rotate'), before, 'generate-before-delete keeps the rotation alive');
  assert.deepStrictEqual(await readState(), stateBefore, 'a failed step does not advance the cycle');

  for (const source of ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']) {
    await new MetadataHelper(frameArtPath).deleteImage(source);
    await createLibraryImage(source, 600, 900, ['family']);
  }
});

test('the first step of a group switched to fluid collapses its coverage batch', async () => {
  // A group's stamped collages are its live output, and a rotation is allowed
  // exactly one — so switching modes must not leave the old batch on the TV
  // under the same output tag.
  await createGroup({ name: 'switched', outputTag: 'switched-collage', mode: 'coverage' });
  const build = await (await post('/api/collage/groups/switched/build')).json();
  assert.ok(build.created.length > 1, 'precondition: a batch of several collages');

  await put('/api/collage/groups/switched', {
    name: 'switched',
    sourceTags: ['family'],
    outputTag: 'switched-collage',
    matteSpec: { swatch: 'ivory', borderWidth: 120 },
    templatePool: ['diptych-2'],
    mode: 'fluid'
  });

  const step = await next('switched');
  assert.deepStrictEqual(
    step.removed.sort(),
    build.created.map(item => item.filename).sort(),
    'the whole batch is replaced by the one rotating collage'
  );
  assert.deepStrictEqual(await batchOf('switched'), [step.filename]);

  await request('DELETE', '/api/collage/groups/switched');
});

test('next rejects a coverage group with 400 and an unknown group with 404', async () => {
  assert.strictEqual((await post('/api/collage/groups/nope/next')).status, 404);

  await createGroup({ name: 'batch', outputTag: 'batch-collage', mode: 'coverage' });
  const { status, body } = await json(await post('/api/collage/groups/batch/next'));
  assert.strictEqual(status, 400);
  assert.match(body.error, /fluid/i);
});

// --- promote ---

test('promote re-renders a logged recipe as a permanent collage', async () => {
  const state = await readState();
  const logged = state.groups.rotate.log[1];

  const { status, body } = await json(await post('/api/collage/promote', {
    group: 'rotate',
    entry: logged.id,
    tags: ['keepsake']
  }));

  assert.strictEqual(status, 200, JSON.stringify(body));
  assert.notStrictEqual(body.filename, logged.filename, 'promote renders a fresh file');

  const metadata = await readMetadata();
  const entry = metadata.images[body.filename];
  assert.ok(entry, 'the promoted collage is registered');
  assert.deepStrictEqual(entry.tags, ['keepsake'], 'promoted collages carry the caller\'s tags');
  assert.strictEqual(entry.collageGroup, undefined, 'a promoted collage is never group-stamped');
  assert.deepStrictEqual(
    entry.collageRecipe.slots.map(slot => slot.imageId),
    logged.recipe.slots.map(slot => slot.imageId),
    'it is the same recipe'
  );
  assert.ok(await exists(libraryFile(body.filename)));
  assert.ok(await exists(thumbFile(body.filename)));
});

test('a promoted collage survives the next fluid step', async () => {
  const promoted = Object.entries(await readMetadata().then(m => m.images))
    .filter(([, entry]) => (entry.tags || []).includes('keepsake'))
    .map(([filename]) => filename);
  assert.strictEqual(promoted.length, 1, 'precondition: one promoted collage');

  const body = await next();
  assert.ok(!body.removed.includes(promoted[0]), 'rotation never touches a promoted collage');
  assert.ok((await readMetadata()).images[promoted[0]]);
  assert.ok(await exists(libraryFile(promoted[0])));
});

test('a promoted collage survives a coverage replace', async () => {
  const promoted = Object.entries(await readMetadata().then(m => m.images))
    .filter(([, entry]) => (entry.tags || []).includes('keepsake'))
    .map(([filename]) => filename);

  // Switch the group to coverage and build: the replace must sweep only the
  // group's own batch.
  const switched = await put('/api/collage/groups/rotate', {
    name: 'rotate',
    sourceTags: ['family'],
    outputTag: 'rotate-collage',
    matteSpec: { swatch: 'ivory', borderWidth: 120 },
    templatePool: ['diptych-2'],
    mode: 'coverage'
  });
  assert.strictEqual(switched.status, 200);

  const build = await (await post('/api/collage/groups/rotate/build')).json();
  assert.ok(!build.removed.includes(promoted[0]), 'a coverage replace leaves promoted collages alone');
  assert.ok((await readMetadata()).images[promoted[0]]);
  assert.ok(await exists(libraryFile(promoted[0])));
});

test('promote 404s an unknown group or log entry', async () => {
  assert.strictEqual((await post('/api/collage/promote', { group: 'nope', entry: 1 })).status, 404);
  assert.strictEqual((await post('/api/collage/promote', { group: 'rotate', entry: 9999 })).status, 404);
  assert.strictEqual((await post('/api/collage/promote', { group: 'rotate' })).status, 400);
});

test('concurrent steps for one group are serialized', async () => {
  await createGroup({ name: 'twin', outputTag: 'twin-collage' });

  // Both requests are in flight before either is read — the serialization has
  // to come from the server, not from the test.
  const [first, second] = await Promise.all([
    post('/api/collage/groups/twin/next'),
    post('/api/collage/groups/twin/next')
  ]);
  const a = await json(first);
  const b = await json(second);
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.strictEqual(b.status, 200, JSON.stringify(b.body));

  const rotating = await batchOf('twin');
  assert.strictEqual(rotating.length, 1, 'two racing steps still leave exactly one collage');

  const state = await readState();
  assert.strictEqual(state.groups.twin.log.length, 2, 'both steps are logged');
  assert.strictEqual(state.groups.twin.current, rotating[0], 'the state agrees with the library');
  assert.strictEqual(await exists(libraryFile(state.groups.twin.log[1].filename)), false,
    'the step that lost the race had its collage swept up');

  await request('DELETE', '/api/collage/groups/twin');
});

test('deleting a group forgets its cycle state', async () => {
  await request('DELETE', '/api/collage/groups/rotate');
  const state = await readState();
  assert.ok(!state.groups.rotate, 'a deleted group leaves no rotation state behind');
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
