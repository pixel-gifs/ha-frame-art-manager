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

function landscapeEntry(tags, overrides = {}) {
  return {
    tags,
    dimensions: { width: 3000, height: 2000 },
    aspectRatio: 1.5,
    ...overrides
  };
}

function sampleImages() {
  return {
    'a.jpg': portraitEntry(['family']),
    'b.jpg': portraitEntry(['family']),
    'c.jpg': portraitEntry(['family', 'hawaii']),
    'd.jpg': landscapeEntry(['landscape-stuff'])
  };
}

test('fills a diptych with distinct portrait images from the tag pool', () => {
  const { recipe, skipped } = buildAutoRecipe({
    images: sampleImages(),
    tagPool: ['family'],
    template: 'diptych-2',
    mattePreset: 'gallery-white',
    rng: seededRng()
  });

  assert.strictEqual(recipe.template, 'diptych-2');
  assert.strictEqual(recipe.matte.swatch, 'gallery-white');
  assert.strictEqual(recipe.slots.length, 2);
  assert.deepStrictEqual(skipped, [], 'every family portrait fits a diptych window');

  const ids = recipe.slots.map(s => s.imageId);
  assert.strictEqual(new Set(ids).size, 2, 'slots must use distinct images');
  ids.forEach(id => assert.ok(['a.jpg', 'b.jpg', 'c.jpg'].includes(id), `${id} should come from the family pool`));
});

test('never picks existing collages as sources', () => {
  const images = {
    ...sampleImages(),
    'old-collage.jpg': portraitEntry(['family'], { collageRecipe: { template: 'diptych-2' } })
  };

  for (let seed = 1; seed <= 10; seed++) {
    const { recipe, skipped } = buildAutoRecipe({
      images,
      tagPool: ['family'],
      template: 'diptych-2',
      mattePreset: 'ivory',
      rng: seededRng(seed)
    });
    recipe.slots.forEach(slot => {
      assert.notStrictEqual(slot.imageId, 'old-collage.jpg', 'existing collages must be excluded');
    });
    assert.ok(
      !skipped.some(s => s.imageId === 'old-collage.jpg'),
      'collages are not sources at all, so they are not "skipped" either'
    );
  }
});

test('landscapes fill the wide grid windows portraits cannot', () => {
  // grid-2x2 windows are ~1.93:1 — portraits (0.67) retain far under 50%.
  const images = {
    'l1.jpg': landscapeEntry(['family']),
    'l2.jpg': landscapeEntry(['family']),
    'l3.jpg': landscapeEntry(['family']),
    'l4.jpg': landscapeEntry(['family'])
  };

  const { recipe, skipped } = buildAutoRecipe({
    images,
    tagPool: ['family'],
    template: 'grid-2x2',
    mattePreset: 'ivory',
    rng: seededRng()
  });

  assert.strictEqual(recipe.template, 'grid-2x2');
  assert.strictEqual(recipe.slots.length, 4);
  assert.strictEqual(new Set(recipe.slots.map(s => s.imageId)).size, 4);
  assert.deepStrictEqual(skipped, []);
});

test('a landscape can carry a solo on its own (landscape solo window)', () => {
  const { recipe } = buildAutoRecipe({
    images: { 'l1.jpg': landscapeEntry(['family']) },
    tagPool: ['family'],
    template: 'solo',
    mattePreset: 'ivory',
    rng: seededRng()
  });
  assert.strictEqual(recipe.template, 'solo');
  assert.deepStrictEqual(recipe.slots.map(s => s.imageId), ['l1.jpg']);
});

test('a portrait is never forced into a window it does not fit', () => {
  // 4 landscapes fill grid-2x2; the lone portrait fits no window there.
  const images = {
    'l1.jpg': landscapeEntry(['family']),
    'l2.jpg': landscapeEntry(['family']),
    'l3.jpg': landscapeEntry(['family']),
    'l4.jpg': landscapeEntry(['family']),
    'p1.jpg': portraitEntry(['family'])
  };

  for (let seed = 1; seed <= 10; seed++) {
    const { recipe, skipped } = buildAutoRecipe({
      images,
      tagPool: ['family'],
      template: 'grid-2x2',
      mattePreset: 'ivory',
      rng: seededRng(seed)
    });
    assert.ok(
      !recipe.slots.some(slot => slot.imageId === 'p1.jpg'),
      'portrait must never land in a 1.93:1 grid window'
    );
    assert.deepStrictEqual(skipped, [{ imageId: 'p1.jpg', reason: 'no-fitting-window' }]);
  }
});

test('a mixed pool fills each window with an image that fits it', () => {
  // hero-left: [1.09, 1.55, 1.55]. The stack windows only fit landscapes, and
  // the hero window (which a portrait *could* fill) must yield the third one.
  const images = {
    'l1.jpg': landscapeEntry(['family']),
    'l2.jpg': landscapeEntry(['family']),
    'l3.jpg': landscapeEntry(['family']),
    'p1.jpg': portraitEntry(['family']),
    'p2.jpg': portraitEntry(['family'])
  };

  const { recipe, skipped } = buildAutoRecipe({
    images,
    tagPool: ['family'],
    template: 'hero-left',
    mattePreset: 'ivory',
    rng: seededRng(3)
  });

  assert.deepStrictEqual(recipe.slots.map(s => s.imageId).sort(), ['l1.jpg', 'l2.jpg', 'l3.jpg']);
  // The portraits fit the hero window, so they are unselected — not skipped.
  assert.deepStrictEqual(skipped, []);
});

test('landscapeSolo routes landscapes to solo and keeps them out of multi-photo templates', () => {
  const images = {
    'p1.jpg': portraitEntry(['family']),
    'p2.jpg': portraitEntry(['family']),
    'p3.jpg': portraitEntry(['family']),
    'l1.jpg': landscapeEntry(['family']),
    'l2.jpg': landscapeEntry(['family'])
  };

  let sawSolo = false;
  let sawMulti = false;
  for (let seed = 1; seed <= 30; seed++) {
    const { recipe, skipped } = buildAutoRecipe({
      images,
      tagPool: ['family'],
      landscapeSolo: true,
      mattePreset: 'ivory',
      rng: seededRng(seed)
    });

    const ids = recipe.slots.map(s => s.imageId);
    if (recipe.template === 'solo') {
      sawSolo = true;
      assert.ok(ids[0].startsWith('l'), 'auto solo exists to carry landscapes');
      assert.deepStrictEqual(
        skipped,
        [
          { imageId: 'p1.jpg', reason: 'landscape-solo' },
          { imageId: 'p2.jpg', reason: 'landscape-solo' },
          { imageId: 'p3.jpg', reason: 'landscape-solo' }
        ],
        'the portraits this landscape-carrying build leaves behind are reported too'
      );
    } else {
      sawMulti = true;
      ids.forEach(id => assert.ok(id.startsWith('p'), `landscape ${id} must not enter ${recipe.template}`));
      assert.deepStrictEqual(
        skipped,
        [
          { imageId: 'l1.jpg', reason: 'landscape-solo' },
          { imageId: 'l2.jpg', reason: 'landscape-solo' }
        ],
        'landscapes routed away are reported, never silently dropped'
      );
    }
  }
  assert.ok(sawSolo, 'landscapeSolo must make solo reachable by random choice');
  assert.ok(sawMulti, 'portraits must still build multi-photo templates');
});

test('landscapeSolo with landscapes only always builds a solo', () => {
  const images = {
    'l1.jpg': landscapeEntry(['family']),
    'l2.jpg': landscapeEntry(['family'])
  };
  for (let seed = 1; seed <= 10; seed++) {
    const { recipe } = buildAutoRecipe({
      images,
      tagPool: ['family'],
      landscapeSolo: true,
      mattePreset: 'ivory',
      rng: seededRng(seed)
    });
    assert.strictEqual(recipe.template, 'solo');
  }
});

test('an explicit solo with landscapeSolo takes the landscape first', () => {
  const images = {
    'p1.jpg': portraitEntry(['family']),
    'l1.jpg': landscapeEntry(['family'])
  };
  for (let seed = 1; seed <= 10; seed++) {
    const { recipe } = buildAutoRecipe({
      images,
      tagPool: ['family'],
      template: 'solo',
      landscapeSolo: true,
      mattePreset: 'ivory',
      rng: seededRng(seed)
    });
    assert.deepStrictEqual(recipe.slots.map(s => s.imageId), ['l1.jpg']);
  }
});

test('a square routes as a portrait, matching the solo window it would get', () => {
  const images = {
    'sq.jpg': portraitEntry(['family'], { dimensions: { width: 2000, height: 2000 }, aspectRatio: 1 }),
    'p1.jpg': portraitEntry(['family']),
    'l1.jpg': landscapeEntry(['family'])
  };
  const { recipe, skipped } = buildAutoRecipe({
    images,
    tagPool: ['family'],
    template: 'diptych-2',
    landscapeSolo: true,
    mattePreset: 'ivory',
    rng: seededRng()
  });
  // Squares are portraits, so landscapeSolo lets the square keep the diptych
  // and holds back only the landscape.
  assert.ok(recipe.slots.some(s => s.imageId === 'sq.jpg'), 'square must stay portrait-side');
  assert.deepStrictEqual(skipped, [{ imageId: 'l1.jpg', reason: 'landscape-solo' }]);
});

test('a blank template means "surprise me", not an invalid template', () => {
  for (const blank of ['', null]) {
    const { recipe } = buildAutoRecipe({
      images: sampleImages(),
      tagPool: ['family'],
      template: blank,
      mattePreset: '',
      rng: seededRng(5)
    });
    assert.ok(TEMPLATES[recipe.template], `blank template ${JSON.stringify(blank)} must pick one`);
    assert.ok(MATTE_SWATCHES[recipe.matte.swatch]);
  }
});

test('images with no known aspect are reported, never picked', () => {
  const images = {
    'a.jpg': portraitEntry(['family']),
    'b.jpg': portraitEntry(['family']),
    'sizeless.jpg': { tags: ['family'] }
  };

  const { recipe, skipped } = buildAutoRecipe({
    images,
    tagPool: ['family'],
    template: 'diptych-2',
    mattePreset: 'ivory',
    rng: seededRng()
  });

  assert.ok(!recipe.slots.some(s => s.imageId === 'sizeless.jpg'));
  assert.deepStrictEqual(skipped, [{ imageId: 'sizeless.jpg', reason: 'unknown-aspect' }]);
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
  // grid-2x2 needs 4 wide-window images; 3 portraits + 1 untagged landscape
  assert.throws(
    () => buildAutoRecipe({ images: sampleImages(), tagPool: ['family'], template: 'grid-2x2' }),
    /Not enough aspect-compatible images/
  );
});

test('random template choice only considers templates the pool can fill', () => {
  // 3 portraits: grid-2x2 (wide windows) must never be chosen
  for (let seed = 1; seed <= 20; seed++) {
    const { recipe } = buildAutoRecipe({
      images: sampleImages(),
      tagPool: ['family'],
      rng: seededRng(seed)
    });
    assert.notStrictEqual(recipe.template, 'grid-2x2');
    assert.ok(TEMPLATES[recipe.template], 'template must be valid');
    assert.ok(MATTE_SWATCHES[recipe.matte.swatch], 'matte swatch must be valid');
  }
});

test('random template choice never picks solo unless landscapeSolo asked for it', () => {
  // A single portrait candidate could only fill solo — without landscapeSolo,
  // random choice must refuse rather than degrade to a 1-up.
  const images = { 'a.jpg': portraitEntry(['family']) };
  assert.throws(
    () => buildAutoRecipe({ images, tagPool: ['family'], rng: seededRng() }),
    /Not enough aspect-compatible images/
  );

  const { recipe } = buildAutoRecipe({
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
  const { recipe } = buildAutoRecipe({
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
