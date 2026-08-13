#!/usr/bin/env node

// Unit tests for fluid rotation's pure parts (#12): the one-step planner in
// collage_auto.js (unused-first, LRU padding, cycle reset, churn) and the
// cycle state file in collage_state.js (per-group entries, ring-buffered
// recipe log). Nothing here renders or writes a library.

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { planFluidStep, SKIP_REASONS } = require('../collage_auto');
const {
  LOG_LIMIT,
  readState,
  writeState,
  groupEntry,
  hasGroupState,
  recordStep,
  findLogEntry,
  forgetGroupState
} = require('../collage_state');

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m'
};

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// Deterministic rng so shuffles are repeatable across runs
function seededRng(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function portraitEntry(tags) {
  return { tags, dimensions: { width: 2000, height: 3000 }, aspectRatio: 0.67 };
}

function landscapeEntry(tags) {
  return { tags, dimensions: { width: 3000, height: 2000 }, aspectRatio: 1.5 };
}

/** n portraits tagged `tag`, named p1.jpg… */
function portraits(n, tag = 'family') {
  const images = {};
  for (let i = 1; i <= n; i++) images[`p${i}.jpg`] = portraitEntry([tag]);
  return images;
}

function landscapes(n, tag = 'family') {
  const images = {};
  for (let i = 1; i <= n; i++) images[`l${i}.jpg`] = landscapeEntry([tag]);
  return images;
}

function step(images, overrides = {}) {
  return planFluidStep({
    images,
    sourceTags: ['family'],
    matte: { swatch: 'ivory', borderWidth: 120 },
    templatePool: ['diptych-2'],
    rng: seededRng(5),
    ...overrides
  });
}

const idsOf = plan => plan.recipe.slots.map(slot => slot.imageId).sort();

// --- cycle ordering ---

test('a step draws from the unused pool before repeating anything', () => {
  const plan = step(portraits(4), { used: ['p1.jpg', 'p2.jpg'], recent: ['p2.jpg', 'p1.jpg'] });

  assert.deepStrictEqual(idsOf(plan), ['p3.jpg', 'p4.jpg'], 'the two unused photos go first');
  assert.strictEqual(plan.cycleReset, false);
  assert.deepStrictEqual(plan.cycle, { used: 4, total: 4 });
});

test('a short unused pool is padded with the least recently used photo', () => {
  // p3 is the only photo left this cycle; the second window must come from the
  // already-featured pair, oldest first.
  const plan = step(portraits(3), { used: ['p1.jpg', 'p2.jpg'], recent: ['p2.jpg', 'p1.jpg'] });

  assert.deepStrictEqual(idsOf(plan), ['p1.jpg', 'p3.jpg'], 'p1 is older than p2');
  assert.strictEqual(plan.cycleReset, false, 'the cycle only resets once the unused pool empties');
  assert.deepStrictEqual(plan.recent.slice(0, 2).sort(), ['p1.jpg', 'p3.jpg'],
    'this step\'s photos become the most recent');
  assert.deepStrictEqual(plan.used.slice().sort(), ['p1.jpg', 'p2.jpg', 'p3.jpg']);
});

test('the cycle resets when the unused pool empties', () => {
  const used = ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg'];
  const plan = step(portraits(4), { used, recent: ['p4.jpg', 'p3.jpg', 'p2.jpg', 'p1.jpg'] });

  assert.strictEqual(plan.cycleReset, true);
  assert.strictEqual(plan.cycle.used, 2, 'a fresh cycle counts only this step');
  assert.strictEqual(plan.cycle.total, 4);
  assert.strictEqual(plan.used.length, 2, 'the used pool restarts from this step');
});

test('newly tagged photos join the unused pool immediately', () => {
  // Four photos have all featured; a fifth is tagged mid-cycle. It must be the
  // seed of the next step rather than waiting for a reset.
  const images = portraits(5);
  const plan = step(images, {
    used: ['p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg'],
    recent: ['p4.jpg', 'p3.jpg', 'p2.jpg', 'p1.jpg']
  });

  assert.strictEqual(plan.cycleReset, false, 'a new photo keeps the current cycle running');
  assert.ok(idsOf(plan).includes('p5.jpg'), 'the newly tagged photo is seeded');
  assert.ok(idsOf(plan).includes('p1.jpg'), 'the pad is the least recently used photo');
});

test('photos that leave the tag pool drop out of the cycle', () => {
  const plan = step(portraits(3), {
    used: ['p1.jpg', 'p2.jpg', 'gone.jpg'],
    recent: ['gone.jpg', 'p2.jpg', 'p1.jpg']
  });

  assert.strictEqual(plan.cycle.total, 3, 'totals count what is actually in the pool');
  assert.ok(!plan.used.includes('gone.jpg'), 'an untagged photo is forgotten');
  assert.ok(!plan.recent.includes('gone.jpg'));
});

test('an untagged pool is never touched', () => {
  const images = { ...portraits(2), 'other.jpg': portraitEntry(['holiday']) };
  const plan = step(images);

  assert.deepStrictEqual(idsOf(plan), ['p1.jpg', 'p2.jpg']);
  assert.strictEqual(plan.cycle.total, 2);
});

test('collages are never sources for a fluid step', () => {
  const images = {
    ...portraits(2),
    'collage-old.jpg': { ...portraitEntry(['family']), collageRecipe: { template: 'solo' } }
  };
  const plan = step(images);

  assert.strictEqual(plan.cycle.total, 2);
  assert.ok(!idsOf(plan).includes('collage-old.jpg'));
});

// --- routing and skips ---

test('landscapeSolo routes a landscape seed to a matted 1-up', () => {
  const images = { ...portraits(2), ...landscapes(1) };
  const plan = step(images, {
    landscapeSolo: true,
    templatePool: ['diptych-2'],
    used: ['p1.jpg', 'p2.jpg'],
    recent: ['p2.jpg', 'p1.jpg']
  });

  assert.strictEqual(plan.recipe.template, 'solo');
  assert.deepStrictEqual(idsOf(plan), ['l1.jpg']);
});

test('a step reports the photos it tried and could not place', () => {
  const images = { ...portraits(1), 'pano.jpg': { tags: ['family'], dimensions: { width: 6000, height: 600 } } };

  assert.throws(
    () => step(images),
    error => {
      assert.strictEqual(error.statusCode, 400);
      assert.deepStrictEqual(error.details.skipped, [
        { imageId: 'p1.jpg', reason: SKIP_REASONS.noFillableTemplate },
        { imageId: 'pano.jpg', reason: SKIP_REASONS.noFittingWindow }
      ]);
      return true;
    },
    'a step with nothing to render must say why, not throw a bare error'
  );
});

test('a step with no sized candidates refuses rather than rendering nothing', () => {
  const images = { 'sizeless.jpg': { tags: ['family'] } };

  assert.throws(() => step(images), /no photos|not enough/i);
});

test('sourceTags is required', () => {
  assert.throws(() => step(portraits(2), { sourceTags: [] }), /sourceTags/);
});

// --- cycle state file ---

test('reading a missing state file yields an empty state', async () => {
  const dir = await tempDir();
  const state = await readState(dir);
  assert.deepStrictEqual(groupEntry(state, 'hawaii').log, []);
  assert.deepStrictEqual(groupEntry(state, 'hawaii').used, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('reading a group\'s state never creates it', async () => {
  const state = { groups: {} };
  groupEntry(state, 'hawaii');
  assert.deepStrictEqual(state.groups, {}, 'a read must not persist a phantom group');
  assert.strictEqual(hasGroupState(state, 'hawaii'), false);

  recordStep(state, 'hawaii', { filename: 'c.jpg', recipe: {}, used: [], recent: [], cycleReset: false });
  assert.strictEqual(hasGroupState(state, 'HAWAII'), true);
});

test('state round-trips through collage_state.json and is git-ignored', async () => {
  const dir = await tempDir();
  const state = await readState(dir);
  recordStep(state, 'hawaii', {
    filename: 'c.jpg',
    recipe: { template: 'solo', slots: [{ imageId: 'p1.jpg' }] },
    used: ['p1.jpg'],
    recent: ['p1.jpg'],
    cycleReset: false
  });
  await writeState(dir, state);

  const reloaded = await readState(dir);
  assert.deepStrictEqual(groupEntry(reloaded, 'HAWAII').used, ['p1.jpg'], 'group lookup is case-insensitive');

  const ignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
  assert.match(ignore, /^collage_state\.json$/m, 'volatile state must stay out of library history');

  // Writing again must not duplicate the ignore rule.
  await writeState(dir, reloaded);
  const again = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
  assert.strictEqual(again, ignore);

  await fs.rm(dir, { recursive: true, force: true });
});

test('recordStep logs each step and rotates the ring buffer', () => {
  const state = { groups: {} };
  const recipe = { template: 'diptych-2', slots: [{ imageId: 'p1.jpg' }] };

  for (let i = 0; i < LOG_LIMIT + 5; i++) {
    recordStep(state, 'hawaii', {
      filename: `c${i}.jpg`,
      recipe,
      used: ['p1.jpg'],
      recent: ['p1.jpg'],
      cycleReset: false
    });
  }

  const entry = groupEntry(state, 'hawaii');
  assert.strictEqual(entry.log.length, LOG_LIMIT, 'the log is capped');
  assert.strictEqual(entry.log[0].filename, `c${LOG_LIMIT + 4}.jpg`, 'newest first');
  assert.strictEqual(entry.current, `c${LOG_LIMIT + 4}.jpg`);

  const ids = entry.log.map(item => item.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'log ids stay unique as the buffer rotates');
  assert.strictEqual(findLogEntry(state, 'hawaii', ids[0]).filename, `c${LOG_LIMIT + 4}.jpg`);
  assert.strictEqual(findLogEntry(state, 'hawaii', 999999), null, 'an unknown id is not a match');
});

test('recordStep counts completed cycles', () => {
  const state = { groups: {} };
  const base = { filename: 'c.jpg', recipe: {}, used: [], recent: [] };

  recordStep(state, 'hawaii', { ...base, cycleReset: false });
  assert.strictEqual(groupEntry(state, 'hawaii').cycles, 0);
  recordStep(state, 'hawaii', { ...base, cycleReset: true });
  assert.strictEqual(groupEntry(state, 'hawaii').cycles, 1, 'a reset closes the previous cycle');
});

test('forgetGroupState drops a deleted group', () => {
  const state = { groups: {} };
  recordStep(state, 'hawaii', { filename: 'c.jpg', recipe: {}, used: [], recent: [], cycleReset: false });
  forgetGroupState(state, 'HAWAII');
  assert.deepStrictEqual(state.groups, {});
});

async function tempDir() {
  const dir = path.join(os.tmpdir(), `frame-art-fluid-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function runTests() {
  let passed = 0;
  let failed = 0;

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
