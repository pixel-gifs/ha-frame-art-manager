#!/usr/bin/env node

// Unit tests for the coverage planner in collage_auto.js (#11): given a tag
// pool it must emit enough recipes that every fittable image appears at least
// once, prefer unused images, and report everything it could not place.

const assert = require('assert');

const { buildCoverageRecipes, SKIP_REASONS } = require('../collage_auto');
const { TEMPLATES } = require('../collage_service');

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m'
};

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

// Deterministic rng for repeatable selection tests
function seededRng(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function portraitEntry(tags, overrides = {}) {
  return { tags, dimensions: { width: 2000, height: 3000 }, aspectRatio: 0.67, ...overrides };
}

function landscapeEntry(tags, overrides = {}) {
  return { tags, dimensions: { width: 3000, height: 2000 }, aspectRatio: 1.5, ...overrides };
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

function placedIds(recipes) {
  return recipes.flatMap(recipe => recipe.slots.map(slot => slot.imageId));
}

function cover(images, overrides = {}) {
  return buildCoverageRecipes({
    images,
    sourceTags: ['family'],
    matte: { swatch: 'ivory', borderWidth: 120 },
    rng: seededRng(3),
    ...overrides
  });
}

// --- coverage completeness ---

test('every fittable image appears in at least one recipe', () => {
  const images = portraits(9);
  const { recipes, skipped } = cover(images);

  assert.deepStrictEqual(skipped, [], 'nine portraits all fit a diptych/triptych window');
  const placed = new Set(placedIds(recipes));
  for (const imageId of Object.keys(images)) {
    assert.ok(placed.has(imageId), `${imageId} never appeared in a collage`);
  }
});

test('coverage spans a mixed portrait + landscape pool', () => {
  const images = { ...portraits(5), ...landscapes(4) };
  const { recipes, skipped } = cover(images);

  assert.deepStrictEqual(skipped, []);
  const placed = new Set(placedIds(recipes));
  assert.strictEqual(placed.size, 9, 'every tagged image is covered');
});

test('untagged images are neither covered nor reported', () => {
  const images = { ...portraits(4), 'other.jpg': portraitEntry(['holiday']) };
  const { recipes, skipped } = cover(images);

  assert.ok(!placedIds(recipes).includes('other.jpg'));
  assert.ok(!skipped.some(s => s.imageId === 'other.jpg'));
});

test('existing collages are never used as sources', () => {
  const images = {
    ...portraits(4),
    'collage-old.jpg': portraitEntry(['family'], { collageRecipe: { template: 'solo' } })
  };
  const { recipes, skipped } = cover(images);

  assert.ok(!placedIds(recipes).includes('collage-old.jpg'));
  assert.ok(!skipped.some(s => s.imageId === 'collage-old.jpg'));
});

test('no recipe repeats an image within itself', () => {
  const { recipes } = cover(portraits(7));
  for (const recipe of recipes) {
    const ids = recipe.slots.map(slot => slot.imageId);
    assert.strictEqual(new Set(ids).size, ids.length, 'a collage must not repeat a photo');
  }
});

test('unused-first: a pool that divides evenly reuses nothing', () => {
  // Six portraits and diptychs only — three collages, no padding needed.
  const { recipes } = cover(portraits(6), { templatePool: ['diptych-2'] });
  const ids = placedIds(recipes);
  assert.strictEqual(recipes.length, 3);
  assert.strictEqual(new Set(ids).size, ids.length, 'no image should be reused');
});

test('unused-first beats crop retention when picking companions', () => {
  // Two photos matching the diptych window exactly and two ordinary portraits.
  // A featured photo always crops better than an unused portrait, so a purely
  // retention-driven fill would re-use it and strand the portrait in a third
  // collage. Coverage must spend the unused photos first, whatever the draw.
  const images = {
    'p1.jpg': portraitEntry(['family']),
    'p2.jpg': portraitEntry(['family']),
    'snug1.jpg': { tags: ['family'], dimensions: { width: 1740, height: 1920 } },
    'snug2.jpg': { tags: ['family'], dimensions: { width: 1740, height: 1920 } }
  };

  for (let seed = 1; seed <= 8; seed++) {
    const { recipes } = cover(images, { templatePool: ['diptych-2'], rng: seededRng(seed) });
    const ids = placedIds(recipes);
    assert.strictEqual(recipes.length, 2, `seed ${seed}: four photos should make two diptychs`);
    assert.strictEqual(new Set(ids).size, 4, `seed ${seed}: nothing should be re-used`);
  }
});

test('the last collage pads with an already-used image rather than dropping one', () => {
  // Five portraits into diptychs: two clean pairs, then one leftover that must
  // still appear — padded with a photo that already featured.
  const { recipes, skipped } = cover(portraits(5), { templatePool: ['diptych-2'] });
  const ids = placedIds(recipes);

  assert.deepStrictEqual(skipped, []);
  assert.strictEqual(recipes.length, 3);
  assert.strictEqual(ids.length, 6);
  assert.strictEqual(new Set(ids).size, 5, 'exactly one image repeats to pad the last pair');
});

// --- template pool ---

test('only templates from the pool are used', () => {
  const { recipes } = cover(portraits(8), { templatePool: ['triptych-3'] });
  assert.ok(recipes.length > 0);
  recipes.forEach(recipe => assert.strictEqual(recipe.template, 'triptych-3'));
});

test('an unknown template in the pool is rejected', () => {
  assert.throws(
    () => cover(portraits(4), { templatePool: ['diptych-2', 'bogus'] }),
    /Unknown collage template "bogus"/
  );
});

test('an empty source tag list is rejected', () => {
  assert.throws(() => cover(portraits(4), { sourceTags: [] }), /sourceTags/);
});

// --- landscape solos ---

test('landscapeSolo routes landscapes to solos and keeps portraits multi-up', () => {
  const images = { ...portraits(4), ...landscapes(3) };
  const { recipes, skipped } = cover(images, { landscapeSolo: true });

  assert.deepStrictEqual(skipped, [], 'landscapeSolo redirects landscapes, it does not drop them');

  const soloIds = recipes.filter(r => r.template === 'solo').flatMap(r => r.slots.map(s => s.imageId));
  const multiIds = recipes.filter(r => r.template !== 'solo').flatMap(r => r.slots.map(s => s.imageId));

  assert.deepStrictEqual(soloIds.sort(), ['l1.jpg', 'l2.jpg', 'l3.jpg']);
  multiIds.forEach(id => assert.ok(id.startsWith('p'), `${id} is a landscape in a multi-photo template`));
  assert.strictEqual(new Set([...soloIds, ...multiIds]).size, 7, 'everything is still covered');
});

test('without landscapeSolo, landscapes fill the windows they fit', () => {
  const images = { ...portraits(2), ...landscapes(4) };
  const { recipes } = cover(images);
  const multi = recipes.filter(r => r.template !== 'solo');
  assert.ok(
    multi.some(r => r.slots.some(s => s.imageId.startsWith('l'))),
    'landscapes belong in multi-photo templates when the toggle is off'
  );
});

// --- skip reporting ---

test('an image with no usable dimensions is reported, never guessed at', () => {
  const images = { ...portraits(4), 'sizeless.jpg': { tags: ['family'] } };
  const { recipes, skipped } = cover(images);

  assert.deepStrictEqual(skipped, [{ imageId: 'sizeless.jpg', reason: SKIP_REASONS.unknownAspect }]);
  assert.ok(!placedIds(recipes).includes('sizeless.jpg'));
});

test('an image no window can carry is reported as no-fitting-window', () => {
  const images = {
    ...portraits(4),
    'pano.jpg': { tags: ['family'], dimensions: { width: 6000, height: 600 } }
  };
  const { recipes, skipped } = cover(images);

  assert.deepStrictEqual(skipped, [{ imageId: 'pano.jpg', reason: SKIP_REASONS.noFittingWindow }]);
  assert.ok(!placedIds(recipes).includes('pano.jpg'));
});

test('an image that fits but has no companions is reported, not silently dropped', () => {
  const { recipes, skipped } = cover(portraits(1), { templatePool: ['diptych-2'] });

  assert.deepStrictEqual(recipes, []);
  assert.deepStrictEqual(skipped, [{ imageId: 'p1.jpg', reason: SKIP_REASONS.noFillableTemplate }]);
});

test('skips are sorted by imageId', () => {
  const images = {
    'z-sizeless.jpg': { tags: ['family'] },
    'a-sizeless.jpg': { tags: ['family'] },
    ...portraits(2)
  };
  const { skipped } = cover(images);
  assert.deepStrictEqual(skipped.map(s => s.imageId), ['a-sizeless.jpg', 'z-sizeless.jpg']);
});

// --- recipe shape ---

test('every recipe carries the group matte and a full slot set', () => {
  const { recipes } = cover(portraits(7), { matte: { swatch: 'museum-black', borderWidth: 220 } });
  assert.ok(recipes.length > 0);
  recipes.forEach(recipe => {
    assert.strictEqual(recipe.matte.swatch, 'museum-black');
    assert.strictEqual(recipe.matte.borderWidth, 220);
    assert.ok(/^#[0-9a-f]{6}$/i.test(recipe.matte.matteColor), 'matte is resolved, not sparse');
    assert.strictEqual(recipe.slots.length, TEMPLATES[recipe.template].slotCount);
    recipe.slots.forEach(slot => assert.deepStrictEqual(slot.focal, { x: 0.5, y: 0.5 }));
  });
});

test('an empty source pool produces no recipes and no skips', () => {
  const { recipes, skipped } = cover(portraits(3, 'holiday'));
  assert.deepStrictEqual(recipes, []);
  assert.deepStrictEqual(skipped, []);
});

// --- determinism ---

test('the same rng seed produces the same plan', () => {
  const images = { ...portraits(6), ...landscapes(3) };
  const a = buildCoverageRecipes({ images, sourceTags: ['family'], matte: {}, rng: seededRng(11) });
  const b = buildCoverageRecipes({ images, sourceTags: ['family'], matte: {}, rng: seededRng(11) });
  assert.deepStrictEqual(a, b);
});

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
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
