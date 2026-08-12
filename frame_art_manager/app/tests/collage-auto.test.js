#!/usr/bin/env node

const assert = require('assert');

const { buildAutoRecipe } = require('../collage_auto');
const { TEMPLATES, MATTE_SWATCHES } = require('../collage_service');

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
  return {
    tags,
    dimensions: { width: 2000, height: 3000 },
    aspectRatio: 0.67,
    ...overrides
  };
}

function sampleImages() {
  return {
    'a.jpg': portraitEntry(['family']),
    'b.jpg': portraitEntry(['family']),
    'c.jpg': portraitEntry(['family', 'hawaii']),
    'd.jpg': portraitEntry(['landscape-stuff'], { dimensions: { width: 3000, height: 2000 }, aspectRatio: 1.5 })
  };
}

test('fills a diptych with distinct portrait images from the tag pool', () => {
  const recipe = buildAutoRecipe({
    images: sampleImages(),
    tagPool: ['family'],
    template: 'diptych-2',
    mattePreset: 'gallery-white',
    rng: seededRng()
  });

  assert.strictEqual(recipe.template, 'diptych-2');
  assert.strictEqual(recipe.matte.swatch, 'gallery-white');
  assert.strictEqual(recipe.slots.length, 2);

  const ids = recipe.slots.map(s => s.imageId);
  assert.strictEqual(new Set(ids).size, 2, 'slots must use distinct images');
  ids.forEach(id => assert.ok(['a.jpg', 'b.jpg', 'c.jpg'].includes(id), `${id} should come from the family pool`));
});

test('never picks landscape images or existing collages', () => {
  const images = {
    ...sampleImages(),
    'old-collage.jpg': portraitEntry(['family'], { collageRecipe: { template: 'diptych-2' } })
  };
  images['d.jpg'].tags = ['family']; // landscape now in the pool by tag

  for (let seed = 1; seed <= 10; seed++) {
    const recipe = buildAutoRecipe({
      images,
      tagPool: ['family'],
      template: 'diptych-2',
      mattePreset: 'ivory',
      rng: seededRng(seed)
    });
    recipe.slots.forEach(slot => {
      assert.notStrictEqual(slot.imageId, 'd.jpg', 'landscape image must be excluded');
      assert.notStrictEqual(slot.imageId, 'old-collage.jpg', 'existing collages must be excluded');
    });
  }
});

test('rejects a missing or empty tagPool', () => {
  assert.throws(() => buildAutoRecipe({ images: sampleImages() }), /tagPool/);
  assert.throws(() => buildAutoRecipe({ images: sampleImages(), tagPool: [] }), /tagPool/);
  assert.throws(() => buildAutoRecipe({ images: sampleImages(), tagPool: ['  '] }), /tagPool/);
});

test('rejects unknown template and matte preset by name', () => {
  assert.throws(
    () => buildAutoRecipe({ images: sampleImages(), tagPool: ['family'], template: 'nope' }),
    /Unknown collage template "nope"/
  );
  assert.throws(
    () => buildAutoRecipe({ images: sampleImages(), tagPool: ['family'], mattePreset: 'nope' }),
    /Unknown matte preset "nope"/
  );
});

test('throws when the pool cannot fill the requested template', () => {
  // grid-2x2 needs 4, only 3 family portraits exist
  assert.throws(
    () => buildAutoRecipe({ images: sampleImages(), tagPool: ['family'], template: 'grid-2x2' }),
    /Not enough aspect-compatible portrait images/
  );
});

test('random template choice only considers templates the pool can fill', () => {
  // 3 candidates: grid-2x2 (4 slots) must never be chosen
  for (let seed = 1; seed <= 20; seed++) {
    const recipe = buildAutoRecipe({
      images: sampleImages(),
      tagPool: ['family'],
      rng: seededRng(seed)
    });
    assert.notStrictEqual(recipe.template, 'grid-2x2');
    assert.ok(TEMPLATES[recipe.template], 'template must be valid');
    assert.ok(MATTE_SWATCHES[recipe.matte.swatch], 'matte swatch must be valid');
  }
});

test('random template choice never picks solo (explicit solo still works)', () => {
  // A single portrait candidate could only fill solo — random choice must
  // refuse rather than degrade to a 1-up (that routing is #10's job).
  const images = { 'a.jpg': portraitEntry(['family']) };
  assert.throws(
    () => buildAutoRecipe({ images, tagPool: ['family'], rng: seededRng() }),
    /Not enough aspect-compatible portrait images/
  );

  const recipe = buildAutoRecipe({
    images,
    tagPool: ['family'],
    template: 'solo',
    mattePreset: 'gallery-white',
    rng: seededRng()
  });
  assert.strictEqual(recipe.template, 'solo');
  assert.strictEqual(recipe.slots.length, 1);
  assert.strictEqual(recipe.slots[0].imageId, 'a.jpg');
});

test('tagPool matching is case-insensitive', () => {
  const recipe = buildAutoRecipe({
    images: sampleImages(), // tagged 'family'
    tagPool: ['FAMILY'],
    template: 'diptych-2',
    mattePreset: 'gallery-white',
    rng: seededRng()
  });
  assert.strictEqual(recipe.slots.length, 2);
});

test('same rng seed produces the same recipe', () => {
  const a = buildAutoRecipe({ images: sampleImages(), tagPool: ['family'], rng: seededRng(7) });
  const b = buildAutoRecipe({ images: sampleImages(), tagPool: ['family'], rng: seededRng(7) });
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
