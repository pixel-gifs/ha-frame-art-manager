#!/usr/bin/env node

// HTTP-level tests for /api/collage/groups (#11): config CRUD in
// metadata.json, and coverage builds with replace-the-previous-batch
// semantics. The router is mounted in a minimal express app over a
// throwaway FRAME_ART_PATH and exercised with fetch.

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const express = require('express');
const sharp = require('sharp');

const collageRouter = require('../routes/collage');
const MetadataHelper = require('../metadata_helper');

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
  const helper = new MetadataHelper(frameArtPath);
  await helper.addImage(filename, 'none', 'None', tags);
}

async function setupTestEnv() {
  frameArtPath = path.join(os.tmpdir(), `frame-art-collage-groups-${Date.now()}`);
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
const del = route => request('DELETE', route);

async function readMetadata() {
  return JSON.parse(await fs.readFile(path.join(frameArtPath, 'metadata.json'), 'utf8'));
}

/** The library filenames currently stamped as a group's batch. */
async function batchOf(groupName) {
  const metadata = await readMetadata();
  return Object.entries(metadata.images)
    .filter(([, entry]) => entry.collageGroup === groupName)
    .map(([filename]) => filename)
    .sort();
}

/** Reset the library + group config between tests that build collages. */
async function resetLibrary(images = []) {
  await fs.writeFile(
    path.join(frameArtPath, 'metadata.json'),
    JSON.stringify({ version: '1.0', images: {}, tags: [] }, null, 2)
  );
  for (const dir of ['library', 'thumbs']) {
    const dirPath = path.join(frameArtPath, dir);
    for (const file of await fs.readdir(dirPath)) {
      await fs.unlink(path.join(dirPath, file));
    }
  }
  for (const [filename, width, height, tags] of images) {
    await createLibraryImage(filename, width, height, tags);
  }
}

function groupBody(overrides = {}) {
  return {
    name: 'hawaii',
    sourceTags: ['family'],
    outputTag: 'hawaii-collage',
    matteSpec: { swatch: 'ivory', borderWidth: 120 },
    templatePool: ['diptych-2'],
    ...overrides
  };
}

/** POST/GET and parse in one step — the body may only be read once. */
async function json(res) {
  return { status: res.status, body: await res.json() };
}

/** Create a group, asserting it took. */
async function createGroup(overrides = {}) {
  const { status, body } = await json(await post('/api/collage/groups', groupBody(overrides)));
  assert.strictEqual(status, 201, `group create failed: ${JSON.stringify(body)}`);
  return body.group;
}

async function deleteAllGroups() {
  const { groups } = await (await get('/api/collage/groups')).json();
  for (const group of groups) {
    await del(`/api/collage/groups/${encodeURIComponent(group.name)}`);
  }
}

// --- CRUD ---

test('groups start empty', async () => {
  const res = await get('/api/collage/groups');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).groups, []);
});

test('create stores a normalized group in metadata.json', async () => {
  const group = await createGroup({ templatePool: undefined });

  assert.strictEqual(group.name, 'hawaii');
  assert.deepStrictEqual(group.sourceTags, ['family']);
  assert.strictEqual(group.outputTag, 'hawaii-collage');
  assert.strictEqual(group.landscapeSolo, false, 'landscapeSolo defaults off');
  assert.strictEqual(group.mode, 'coverage', 'mode defaults to coverage');
  assert.ok(group.templatePool.length > 0, 'templatePool defaults to the multi-photo templates');
  assert.ok(!group.templatePool.includes('solo'), 'solo is opt-in');
  assert.strictEqual(group.matteSpec.swatch, 'ivory');
  assert.ok(/^#[0-9a-f]{6}$/i.test(group.matteSpec.matteColor), 'matteSpec is stored resolved');

  const stored = (await readMetadata()).collageGroups;
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].name, 'hawaii');

  await deleteAllGroups();
});

test('create rejects a duplicate name with 409', async () => {
  await createGroup();
  const res = await post('/api/collage/groups', groupBody());
  assert.strictEqual(res.status, 409);
  assert.match((await res.json()).error, /already exists/i);
  await deleteAllGroups();
});

test('create rejects invalid configs with 400', async () => {
  const cases = [
    [{ name: '' }, /name/i],
    [{ name: 'has/slash' }, /name/i],
    [{ sourceTags: [] }, /sourceTags/i],
    [{ outputTag: '  ' }, /outputTag/i],
    [{ templatePool: ['bogus'] }, /template/i],
    [{ matteSpec: { swatch: 'neon-pink' } }, /swatch/i],
    [{ mode: 'sideways' }, /mode/i]
  ];

  for (const [overrides, pattern] of cases) {
    const res = await post('/api/collage/groups', groupBody(overrides));
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(overrides)}`);
    assert.match((await res.json()).error, pattern);
  }

  assert.deepStrictEqual((await readMetadata()).collageGroups || [], [], 'nothing persisted');
});

test('get returns one group, 404 for an unknown name', async () => {
  await createGroup();
  const res = await get('/api/collage/groups/hawaii');
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).group.name, 'hawaii');

  assert.strictEqual((await get('/api/collage/groups/nope')).status, 404);
  await deleteAllGroups();
});

test('update edits a group in place', async () => {
  await createGroup();
  const res = await put('/api/collage/groups/hawaii', groupBody({
    sourceTags: ['family', 'maui'],
    outputTag: 'maui-collage',
    landscapeSolo: true,
    matteSpec: { swatch: 'museum-black', borderWidth: 220 }
  }));
  assert.strictEqual(res.status, 200);
  const { group } = await res.json();

  assert.deepStrictEqual(group.sourceTags, ['family', 'maui']);
  assert.strictEqual(group.outputTag, 'maui-collage');
  assert.strictEqual(group.landscapeSolo, true);
  assert.strictEqual(group.matteSpec.borderWidth, 220);

  const stored = (await readMetadata()).collageGroups;
  assert.strictEqual(stored.length, 1, 'update must not duplicate the group');
  assert.strictEqual(stored[0].outputTag, 'maui-collage');

  await deleteAllGroups();
});

test('update rejects a rename and 404s an unknown group', async () => {
  await createGroup();
  const renamed = await put('/api/collage/groups/hawaii', groupBody({ name: 'oahu' }));
  assert.strictEqual(renamed.status, 400);
  assert.match((await renamed.json()).error, /rename/i);

  assert.strictEqual((await put('/api/collage/groups/nope', groupBody({ name: 'nope' }))).status, 404);
  await deleteAllGroups();
});

test('delete removes the config and 404s an unknown group', async () => {
  await createGroup();
  const res = await del('/api/collage/groups/hawaii');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await readMetadata()).collageGroups, []);
  assert.strictEqual((await del('/api/collage/groups/hawaii')).status, 404);
});

// --- coverage builds ---

test('build covers every fittable source image exactly once per batch', async () => {
  await resetLibrary([
    ['p1.jpg', 600, 900, ['family']],
    ['p2.jpg', 600, 900, ['family']],
    ['p3.jpg', 600, 900, ['family']],
    ['p4.jpg', 600, 900, ['family']]
  ]);
  await createGroup();

  const { status, body } = await json(await post('/api/collage/groups/hawaii/build'));
  assert.strictEqual(status, 200, JSON.stringify(body));

  assert.strictEqual(body.success, true);
  assert.strictEqual(body.created.length, 2, 'four portraits make two diptychs');
  assert.deepStrictEqual(body.removed, [], 'nothing to replace on the first run');
  assert.deepStrictEqual(body.skipped, []);

  const covered = new Set(body.created.flatMap(entry => entry.imageIds));
  assert.deepStrictEqual([...covered].sort(), ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg']);

  const metadata = await readMetadata();
  for (const { filename } of body.created) {
    const entry = metadata.images[filename];
    assert.ok(entry, `${filename} must be registered`);
    assert.deepStrictEqual(entry.tags, ['hawaii-collage'], 'only the group output tag is applied');
    assert.strictEqual(entry.collageGroup, 'hawaii', 'outputs are stamped with the group');
    assert.ok(entry.collageRecipe, 'outputs carry their recipe');
    await fs.access(path.join(frameArtPath, 'library', filename));
    await fs.access(path.join(frameArtPath, 'thumbs', `thumb_${filename}`));
  }

  const built = await sharp(path.join(frameArtPath, 'library', body.created[0].filename)).metadata();
  assert.strictEqual(built.width, 3840);
});

test('re-running replaces the previous batch instead of accumulating', async () => {
  const first = await (await post('/api/collage/groups/hawaii/build')).json();
  const second = await (await post('/api/collage/groups/hawaii/build')).json();

  const firstNames = first.created.map(c => c.filename);
  assert.deepStrictEqual(second.removed.sort(), firstNames.slice().sort());

  const metadata = await readMetadata();
  assert.strictEqual((await batchOf('hawaii')).length, 2, 'the batch stays the same size across runs');

  for (const filename of firstNames) {
    assert.ok(!metadata.images[filename], `${filename} must be gone from metadata`);
    await assert.rejects(fs.access(path.join(frameArtPath, 'library', filename)));
    await assert.rejects(fs.access(path.join(frameArtPath, 'thumbs', `thumb_${filename}`)));
  }
  for (const { filename } of second.created) {
    await fs.access(path.join(frameArtPath, 'library', filename));
  }
});

test('build leaves hand-made collages and other groups alone', async () => {
  const handMade = await (await post('/api/collage', {
    recipe: {
      template: 'diptych-2',
      matte: { swatch: 'ivory', borderWidth: 120 },
      slots: [
        { imageId: 'p1.jpg', focal: { x: 0.5, y: 0.5 } },
        { imageId: 'p2.jpg', focal: { x: 0.5, y: 0.5 } }
      ]
    },
    tags: ['keepsake']
  })).json();

  await createGroup({ name: 'other', outputTag: 'other-collage' });
  const other = await (await post('/api/collage/groups/other/build')).json();
  const rerun = await (await post('/api/collage/groups/hawaii/build')).json();

  const metadata = await readMetadata();
  assert.ok(metadata.images[handMade.filename], 'a hand-made collage is never part of a batch');
  assert.strictEqual(metadata.images[handMade.filename].collageGroup, undefined);
  assert.ok(!rerun.removed.includes(handMade.filename));

  for (const { filename } of other.created) {
    assert.ok(metadata.images[filename], 'another group\'s batch survives this build');
    assert.ok(!rerun.removed.includes(filename));
  }

  await del('/api/collage/groups/other');
});

test('build reports images it could not place', async () => {
  await createLibraryImage('pano.jpg', 6000, 600, ['family']);
  await createLibraryImage('sizeless.jpg', 600, 900, ['family']);
  const helper = new MetadataHelper(frameArtPath);
  await helper.updateImage('sizeless.jpg', { dimensions: null, aspectRatio: null });

  const body = await (await post('/api/collage/groups/hawaii/build')).json();
  assert.deepStrictEqual(body.skipped, [
    { imageId: 'pano.jpg', reason: 'no-fitting-window' },
    { imageId: 'sizeless.jpg', reason: 'unknown-aspect' }
  ]);

  await helper.deleteImage('pano.jpg');
  await helper.deleteImage('sizeless.jpg');
  await fs.unlink(path.join(frameArtPath, 'library', 'pano.jpg'));
  await fs.unlink(path.join(frameArtPath, 'library', 'sizeless.jpg'));
});

test('the last run summary is reported with the group', async () => {
  const { groups } = await (await get('/api/collage/groups')).json();
  const hawaii = groups.find(g => g.name === 'hawaii');
  assert.ok(hawaii.lastRun, 'a group that has run carries its last-run summary');
  assert.strictEqual(hawaii.lastRun.created.length, 2);
  assert.ok(hawaii.lastRun.finishedAt, 'the summary is timestamped');
});

test('a build that renders nothing keeps the previous batch, and says why', async () => {
  const before = await batchOf('hawaii');
  assert.strictEqual(before.length, 2, 'precondition: a batch exists');

  // Sources that exist but fit nothing: the refusal must still report them.
  await createLibraryImage('lonely.jpg', 600, 900, ['lonely']);
  await createGroup({ name: 'empty', sourceTags: ['lonely'], outputTag: 'empty-collage' });
  const { status, body } = await json(await post('/api/collage/groups/empty/build'));
  assert.strictEqual(status, 400);
  assert.match(body.error, /no collages/i);
  assert.deepStrictEqual(
    body.skipped,
    [{ imageId: 'lonely.jpg', reason: 'no-fillable-template' }],
    'a refused build still surfaces every skip'
  );

  assert.deepStrictEqual(await batchOf('hawaii'), before, 'the previous batch is kept');

  await del('/api/collage/groups/empty');
});

test('a failed render leaves the previous batch untouched', async () => {
  const before = await batchOf('hawaii');
  const libraryBefore = await fs.readdir(path.join(frameArtPath, 'library'));

  // A metadata entry whose file is gone: selection still picks it, the render
  // cannot resolve it.
  await fs.unlink(path.join(frameArtPath, 'library', 'p3.jpg'));

  const res = await post('/api/collage/groups/hawaii/build');
  assert.ok(res.status >= 400, 'a build that cannot render must fail loudly');

  assert.deepStrictEqual(await batchOf('hawaii'), before, 'the old batch survives a failed run');

  const libraryAfter = await fs.readdir(path.join(frameArtPath, 'library'));
  assert.deepStrictEqual(
    libraryAfter.sort(),
    libraryBefore.filter(f => f !== 'p3.jpg').sort(),
    'no half-built collage is left behind'
  );

  await createLibraryImage('p3.jpg', 600, 900, ['family']);
});

test('build rejects an unknown group with 404 and a fluid group with 400', async () => {
  assert.strictEqual((await post('/api/collage/groups/nope/build')).status, 404);

  await createGroup({ name: 'fluid-one', outputTag: 'fluid-collage', mode: 'fluid' });
  const res = await post('/api/collage/groups/fluid-one/build');
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /fluid/i);
  await del('/api/collage/groups/fluid-one');
});

test('deleting a group leaves its collages in the library', async () => {
  const batch = await batchOf('hawaii');

  const res = await del('/api/collage/groups/hawaii');
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).keptCollages, batch.length);

  const metadata = await readMetadata();
  for (const filename of batch) {
    assert.ok(metadata.images[filename], `${filename} must survive the config delete`);
  }
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
