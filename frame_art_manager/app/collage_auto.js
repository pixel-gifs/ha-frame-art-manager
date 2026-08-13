/**
 * Auto-pair slot-filling for collages.
 *
 * Pure selection logic: given the library's metadata images map and a tag
 * pool, fit photos to the windows their aspect can actually carry and produce
 * a ready-to-render recipe. No filesystem or network access — the route layer
 * resolves files.
 *
 * Selection is aspect-aware per window (#10): any image may fill any window it
 * fits, so landscapes are first-class citizens of the wide grid/hero windows
 * and of landscape solos. Nothing is ever dropped in silence — every candidate
 * the chosen template cannot accept comes back in `skipped`.
 */

const {
  BORDER_WIDTH,
  TEMPLATES,
  MATTE_SWATCHES,
  computeLayout,
  getTemplate,
  normalizeRecipe,
  soloOrientation
} = require('./collage_service');

// Templates a random or coverage build may reach for when the caller names
// none. Solo is opt-in: a 1-up is asked for by name, or routed to by the
// landscapeSolo split.
const MULTI_TEMPLATES = Object.keys(TEMPLATES).filter(key => key !== 'solo');

// A photo is usable in a window when cover-cropping keeps at least this
// fraction of it (1 = aspect matches exactly, lower = more cropped away).
const MIN_CROP_RETENTION = 0.5;

// Why a tagged, non-collage image did not make it into the build. Images that
// fit the chosen template but simply lost the draw are NOT skips — only images
// the build could not place at all.
const SKIP_REASONS = {
  unknownAspect: 'unknown-aspect',      // no dimensions to fit windows with
  noFittingWindow: 'no-fitting-window', // every window crops it below the floor
  landscapeSolo: 'landscape-solo',      // set aside by the landscapeSolo split:
                                        // a landscape barred from a multi-photo
                                        // template, or a portrait left out of a
                                        // build that exists to carry landscapes
  noFillableTemplate: 'no-fillable-template' // fits a window, but the pool has
                                        // too few compatible companions to
                                        // complete any template around it
};

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/** A caller-supplied template key, as a 400 rather than a 500. */
function assertTemplate(key) {
  try {
    getTemplate(key);
  } catch (error) {
    throw badRequest(error.message);
  }
}

function entryAspect(entry) {
  if (entry.dimensions && entry.dimensions.width > 0 && entry.dimensions.height > 0) {
    return entry.dimensions.width / entry.dimensions.height;
  }
  return typeof entry.aspectRatio === 'number' && entry.aspectRatio > 0 ? entry.aspectRatio : null;
}

/**
 * The orientation an aspect reads as — the renderer's own rule (a square is
 * portrait), so the landscapeSolo split and the solo window always agree.
 */
function orientationOf(aspect) {
  return soloOrientation(aspect, 1);
}

function windowAspects(templateKey, orientation = 'portrait') {
  return computeLayout(templateKey, BORDER_WIDTH.default, 1, orientation)
    .map(w => w.width / w.height);
}

function cropRetention(imageAspect, windowAspect) {
  return Math.min(imageAspect / windowAspect, windowAspect / imageAspect);
}

/**
 * Tagged, non-collage images from the pool, with their aspect resolved.
 * Returns { candidates: [{ imageId, aspect }], skipped: [{ imageId, reason }] }
 * — the skips here are images we cannot fit *anything* to, for lack of size.
 */
function poolCandidates(images, tagPool) {
  const pool = tagPool.map(tag => String(tag).trim().toLowerCase()).filter(Boolean);
  const candidates = [];
  const skipped = [];

  for (const [imageId, entry] of Object.entries(images || {})) {
    if (!entry || entry.collageRecipe) continue; // collages are never sources
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    if (!tags.some(tag => pool.includes(String(tag).toLowerCase()))) continue;

    const aspect = entryAspect(entry);
    if (aspect) {
      candidates.push({ imageId, aspect });
    } else {
      skipped.push({ imageId, reason: SKIP_REASONS.unknownAspect });
    }
  }

  return { candidates, skipped };
}

/**
 * Assign distinct candidates to a set of window aspects so that every window
 * gets an image it fits — a bipartite matching (Kuhn's augmenting paths) over
 * the image↔window "fits" relation. Each window prefers its best-retention
 * candidate, so a feasible layout also looks like a good one.
 *
 * Candidate order is the caller's (pre-shuffled) order and breaks ties, which
 * keeps the whole thing deterministic for a seeded rng.
 *
 * @param {number[]} aspects       window aspects, in window order
 * @param {object[]} candidates    {imageId, aspect}, in preference order
 * @param {object} [opts]
 * @param {number} [opts.reserved] window index to leave empty — the caller has
 *                                 already seated an image there (coverage
 *                                 builds force their seed into a window)
 * @param {number} [opts.firstTier] how many leading candidates outrank the
 *                                 rest whatever their crop retention (a
 *                                 coverage round puts its still-unused photos
 *                                 in the first tier, so reuse only ever pads)
 * @returns {object[]|null} picks in window order (the reserved slot is null),
 *                          or null when no complete assignment exists.
 */
function matchWindows(aspects, candidates, { reserved = -1, firstTier = candidates.length } = {}) {
  // Per window: the candidates that fit, preferred tier first, then best
  // retention.
  const tierOf = index => (index < firstTier ? 0 : 1);
  const preferences = aspects.map(winAspect =>
    candidates
      .map((candidate, index) => ({ index, retention: cropRetention(candidate.aspect, winAspect) }))
      .filter(({ retention }) => retention >= MIN_CROP_RETENTION)
      .sort((a, b) =>
        tierOf(a.index) - tierOf(b.index) || b.retention - a.retention || a.index - b.index)
      .map(({ index }) => index)
  );

  const windowOf = new Array(candidates.length).fill(-1); // candidate -> window
  const pickOf = new Array(aspects.length).fill(-1);      // window -> candidate

  const augment = (win, tried) => {
    for (const candidate of preferences[win]) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      const holder = windowOf[candidate];
      if (holder === -1 || augment(holder, tried)) {
        windowOf[candidate] = win;
        pickOf[win] = candidate;
        return true;
      }
    }
    return false;
  };

  // every() would short-circuit; matching all windows is the point.
  for (let win = 0; win < aspects.length; win++) {
    if (win === reserved) continue;
    if (!augment(win, new Set())) return null;
  }

  return pickOf.map(index => (index === -1 ? null : candidates[index]));
}

/**
 * Fill one multi-window template from a candidate pool.
 *
 * @returns {{ picks: object[]|null, unfittable: string[] }} picks in window
 *          order, or null when no complete assignment exists.
 */
function assignWindows(candidates, templateKey) {
  const aspects = windowAspects(templateKey);

  const unfittable = candidates
    .filter(({ aspect }) =>
      !aspects.some(winAspect => cropRetention(aspect, winAspect) >= MIN_CROP_RETENTION))
    .map(({ imageId }) => imageId);

  return { picks: matchWindows(aspects, candidates), unfittable };
}

/**
 * Solo is one window whose aspect follows the source, so each candidate is
 * measured against its own orientation's window. First fitting candidate wins
 * (the caller shuffles).
 */
function assignSolo(candidates) {
  const unfittable = [];
  let pick = null;

  for (const candidate of candidates) {
    const [winAspect] = windowAspects('solo', orientationOf(candidate.aspect));
    if (cropRetention(candidate.aspect, winAspect) >= MIN_CROP_RETENTION) {
      if (!pick) pick = candidate;
    } else {
      unfittable.push(candidate.imageId);
    }
  }

  return { picks: pick ? [pick] : null, unfittable };
}

function shuffle(items, rng) {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build a renderable recipe from the tag pool.
 *
 * @param {object} opts
 * @param {object} opts.images       metadata.json images map (filename to entry)
 * @param {string[]} opts.tagPool    tags to draw photos from (required)
 * @param {string} [opts.template]   template key; random compatible one if omitted
 * @param {string} [opts.mattePreset] matte swatch key; random if omitted
 *                                    (param name kept for HA automation compat)
 * @param {boolean} [opts.landscapeSolo] keep landscapes out of multi-photo
 *                                    templates and route them to solo instead
 * @param {function} [opts.rng]      0..1 random source (injectable for tests)
 * @returns {{ recipe: object, skipped: Array<{imageId: string, reason: string}> }}
 *          the normalized recipe, plus every candidate this build could not
 *          place, sorted by imageId. Candidates that fit the chosen template
 *          but lost the draw are not skips — they are still buildable.
 */
function buildAutoRecipe({
  images,
  tagPool,
  template,
  mattePreset,
  landscapeSolo = false,
  rng = Math.random
} = {}) {
  if (!Array.isArray(tagPool) || tagPool.filter(t => String(t).trim()).length === 0) {
    throw badRequest('tagPool must be a non-empty array of tags');
  }

  if (template) {
    assertTemplate(template);
  }
  if (mattePreset && !MATTE_SWATCHES[mattePreset]) {
    throw badRequest(
      `Unknown matte preset "${mattePreset}". Valid presets: ${Object.keys(MATTE_SWATCHES).join(', ')}`
    );
  }

  const { candidates, skipped: sizeless } = poolCandidates(images, tagPool);
  const shuffled = shuffle(candidates, rng);
  const landscapes = shuffled.filter(({ aspect }) => orientationOf(aspect) === 'landscape');
  const portraits = shuffled.filter(({ aspect }) => orientationOf(aspect) !== 'landscape');

  // Random choice picks solo only when landscapeSolo needs it as a landscape
  // route; otherwise a 1-up must be asked for by name.
  const explicit = Boolean(template);
  const templateKeys = explicit ? [template] : [...MULTI_TEMPLATES];
  if (!explicit && landscapeSolo && landscapes.length > 0) {
    templateKeys.push('solo');
  }

  /**
   * How a template is filled: the candidates it may draw from, whatever the
   * landscapeSolo split holds back from it, and its assignment strategy.
   * An explicitly requested solo may use anything, landscapes first.
   */
  const routeFor = (key) => {
    if (key === 'solo') {
      if (!landscapeSolo) return { pool: shuffled, setAside: [], assign: assignSolo };
      return explicit
        ? { pool: [...landscapes, ...portraits], setAside: [], assign: assignSolo }
        : { pool: landscapes, setAside: portraits, assign: assignSolo };
    }
    return {
      pool: landscapeSolo ? portraits : shuffled,
      setAside: landscapeSolo ? landscapes : [],
      assign: pool => assignWindows(pool, key)
    };
  };

  const feasible = templateKeys
    .map(key => {
      const { pool, setAside, assign } = routeFor(key);
      return { key, setAside, ...assign(pool) };
    })
    .filter(({ picks }) => picks !== null);

  if (feasible.length === 0) {
    const need = Math.min(...templateKeys.map(key => TEMPLATES[key].slotCount));
    throw badRequest(
      `Not enough aspect-compatible images tagged [${tagPool.join(', ')}] ` +
      `(need at least ${need} that fit ${explicit ? `template "${template}"` : 'a template'}'s ` +
      `windows, found ${candidates.length} sized candidate${candidates.length === 1 ? '' : 's'})`
    );
  }

  const chosen = feasible[Math.floor(rng() * feasible.length)];
  const swatchKeys = Object.keys(MATTE_SWATCHES);
  const swatch = mattePreset || swatchKeys[Math.floor(rng() * swatchKeys.length)];

  const skipped = [
    ...sizeless,
    ...chosen.unfittable.map(imageId => ({ imageId, reason: SKIP_REASONS.noFittingWindow })),
    ...chosen.setAside.map(({ imageId }) => ({ imageId, reason: SKIP_REASONS.landscapeSolo }))
  ].sort((a, b) => a.imageId.localeCompare(b.imageId));

  const recipe = normalizeRecipe({
    template: chosen.key,
    matte: { swatch, borderWidth: BORDER_WIDTH.default },
    slots: chosen.picks.map(({ imageId }) => ({ imageId, focal: { x: 0.5, y: 0.5 } }))
  });

  return { recipe, skipped };
}

/**
 * Seat one candidate in a template and fill the rest of its windows from the
 * companion pool. The seed is forced in (best-retention window first) so a
 * coverage round always advances, and companions are drawn in the caller's
 * order — unused photos ahead of already-featured ones.
 *
 * @returns {{ picks: object[]|null, fits: boolean }} `fits` says whether any
 *          window could carry the seed at all, which separates "this photo
 *          belongs nowhere" from "this photo has no companions".
 */
function seatCandidate(templateKey, seed, companions, unusedCount = companions.length) {
  if (templateKey === 'solo') {
    const [winAspect] = windowAspects('solo', orientationOf(seed.aspect));
    const fits = cropRetention(seed.aspect, winAspect) >= MIN_CROP_RETENTION;
    return { picks: fits ? [seed] : null, fits };
  }

  const aspects = windowAspects(templateKey);
  const seats = aspects
    .map((winAspect, index) => ({ index, retention: cropRetention(seed.aspect, winAspect) }))
    .filter(({ retention }) => retention >= MIN_CROP_RETENTION)
    .sort((a, b) => b.retention - a.retention || a.index - b.index);

  for (const { index: seat } of seats) {
    const picks = matchWindows(aspects, companions, { reserved: seat, firstTier: unusedCount });
    if (picks) {
      picks[seat] = seed;
      return { picks, fits: true };
    }
  }

  return { picks: null, fits: seats.length > 0 };
}

/**
 * The inputs every group planner shares: a non-empty tag pool and a validated
 * template pool (all the multi-photo templates when the group names none).
 */
function resolveTemplatePool(sourceTags, templatePool) {
  if (!Array.isArray(sourceTags) || sourceTags.filter(t => String(t).trim()).length === 0) {
    throw badRequest('sourceTags must be a non-empty array of tags');
  }
  const pool = Array.isArray(templatePool) && templatePool.length > 0
    ? templatePool
    : MULTI_TEMPLATES;
  pool.forEach(assertTemplate);
  return pool;
}

/**
 * Try to build a collage around one seed, template by template in random
 * order.
 *
 * @returns {{ seated: {key, picks}|null, skip: {imageId, reason}|null }} — a
 *          seed that lands nowhere comes back as a skip, told apart by whether
 *          any window could have carried it at all.
 */
function seatSeed(keys, seed, companions, unusedCount, rng) {
  let fitsSomewhere = false;

  for (const key of shuffle(keys, rng)) {
    const attempt = seatCandidate(key, seed, companions, unusedCount);
    fitsSomewhere = fitsSomewhere || attempt.fits;
    if (attempt.picks) {
      return { seated: { key, picks: attempt.picks }, skip: null };
    }
  }

  return {
    seated: null,
    skip: {
      imageId: seed.imageId,
      reason: fitsSomewhere ? SKIP_REASONS.noFillableTemplate : SKIP_REASONS.noFittingWindow
    }
  };
}

/** A seated template as a renderable recipe. Focal points start centred. */
function recipeFor(seated, matte) {
  return normalizeRecipe({
    template: seated.key,
    matte,
    slots: seated.picks.map(({ imageId }) => ({ imageId, focal: { x: 0.5, y: 0.5 } }))
  });
}

/**
 * Plan a group's coverage build: enough collages that every source image the
 * templates can carry appears at least once.
 *
 * Each round takes the first not-yet-featured photo, seats it in a template
 * that can be completed around it, and fills the remaining windows from the
 * still-unused pool before falling back to photos that already featured — so
 * reuse only ever pads the final collage. A photo that no round can place is
 * reported in `skipped`; nothing is dropped in silence.
 *
 * @param {object} opts
 * @param {object} opts.images          metadata.json images map
 * @param {string[]} opts.sourceTags    tags to draw photos from (required)
 * @param {object} [opts.matte]         the group's matte spec, used verbatim
 * @param {string[]} [opts.templatePool] templates the build may use; every
 *                                      multi-photo template when omitted
 * @param {boolean} [opts.landscapeSolo] route landscapes to matted 1-ups
 *                                      instead of multi-photo templates
 * @param {function} [opts.rng]         0..1 random source (injectable)
 * @returns {{ recipes: object[], skipped: Array<{imageId: string, reason: string}> }}
 */
function buildCoverageRecipes({
  images,
  sourceTags,
  matte = {},
  templatePool,
  landscapeSolo = false,
  rng = Math.random
} = {}) {
  const pool = resolveTemplatePool(sourceTags, templatePool);

  const { candidates, skipped } = poolCandidates(images, sourceTags);
  const shuffled = shuffle(candidates, rng);

  // With landscapeSolo the pool splits in two, each with its own templates:
  // landscapes get 1-ups (available whether or not the pool names solo),
  // portraits get everything else the pool allows.
  const multiKeys = pool.filter(key => key !== 'solo');
  const routes = landscapeSolo
    ? [
      { pool: shuffled.filter(c => orientationOf(c.aspect) === 'landscape'), keys: ['solo'] },
      {
        pool: shuffled.filter(c => orientationOf(c.aspect) !== 'landscape'),
        keys: pool.includes('solo') ? pool : multiKeys
      }
    ]
    : [{ pool: shuffled, keys: pool }];

  const recipes = [];

  for (const route of routes) {
    if (route.keys.length === 0) {
      route.pool.forEach(({ imageId }) =>
        skipped.push({ imageId, reason: SKIP_REASONS.noFittingWindow }));
      continue;
    }

    const unused = route.pool.slice();
    const featured = [];

    while (unused.length > 0) {
      const seed = unused.shift();
      const companions = [...unused, ...featured];

      const { seated, skip } = seatSeed(route.keys, seed, companions, unused.length, rng);
      if (!seated) {
        skipped.push(skip);
        continue;
      }

      // Everything this collage used has now featured, and none of it is
      // still waiting for a collage of its own.
      for (const pick of seated.picks) {
        const waiting = unused.indexOf(pick);
        if (waiting !== -1) unused.splice(waiting, 1);
        if (!featured.includes(pick)) featured.push(pick);
      }

      recipes.push(recipeFor(seated, matte));
    }
  }

  return { recipes, skipped: skipped.sort((a, b) => a.imageId.localeCompare(b.imageId)) };
}

/**
 * Plan one step of a group's fluid rotation (#7 decisions 8, 9; #12).
 *
 * Where a coverage build plans a whole batch at once, a fluid group holds a
 * single collage that is replaced over and over. Each step seats a photo the
 * current cycle has not shown yet and fills the rest of the windows from the
 * still-unused pool, padding with the least recently used photos when the pool
 * runs short. The cycle resets — every photo unused again — only once the pool
 * empties, so a newly tagged photo joins the *current* cycle rather than
 * waiting for the next one.
 *
 * Pure: the caller owns the state file and the render.
 *
 * @param {object} opts
 * @param {object} opts.images         metadata.json images map
 * @param {string[]} opts.sourceTags   tags to draw photos from (required)
 * @param {object} [opts.matte]        the group's matte spec, used verbatim
 * @param {string[]} [opts.templatePool] templates this step may use
 * @param {boolean} [opts.landscapeSolo] route landscapes to matted 1-ups
 * @param {string[]} [opts.used]       imageIds already shown this cycle
 * @param {string[]} [opts.recent]     imageIds most-recently-shown first — the
 *                                     LRU order padding draws from
 * @param {function} [opts.rng]        0..1 random source (injectable)
 * @returns {{ recipe: object, skipped: object[], used: string[],
 *             recent: string[], cycleReset: boolean,
 *             cycle: { used: number, total: number } }}
 *          the next collage plus the cycle state that follows from it.
 * @throws  a 400 carrying `details.skipped` when the pool can render nothing.
 */
function planFluidStep({
  images,
  sourceTags,
  matte = {},
  templatePool,
  landscapeSolo = false,
  used = [],
  recent = [],
  rng = Math.random
} = {}) {
  const pool = resolveTemplatePool(sourceTags, templatePool);

  const { candidates, skipped } = poolCandidates(images, sourceTags);
  if (candidates.length === 0) {
    const error = badRequest(
      `No photos with usable dimensions are tagged [${sourceTags.join(', ')}]`
    );
    error.details = { skipped };
    throw error;
  }

  // Photos that have left the tag pool since the last step leave the cycle
  // with it — the cycle is about the pool as it stands now.
  const inPool = new Set(candidates.map(({ imageId }) => imageId));
  const shown = new Set(used.filter(imageId => inPool.has(imageId)));
  const lru = recent.filter(imageId => inPool.has(imageId));

  const cycleReset = candidates.every(({ imageId }) => shown.has(imageId));
  if (cycleReset) shown.clear();

  const unusedOrder = shuffle(candidates.filter(({ imageId }) => !shown.has(imageId)), rng);
  // Padding order: least recently used first, and a photo the log has never
  // mentioned is as old as it gets (rank past the end of the LRU list).
  const rankOf = imageId => {
    const index = lru.indexOf(imageId);
    return index === -1 ? lru.length : index;
  };
  const padOrder = candidates
    .filter(({ imageId }) => shown.has(imageId))
    .sort((a, b) => rankOf(b.imageId) - rankOf(a.imageId) || a.imageId.localeCompare(b.imageId));

  // The landscapeSolo split decides per seed rather than per batch: a
  // landscape gets a 1-up, a portrait gets the multi-photo templates (and
  // portraits keep solo only when the group's pool asks for it by name).
  const multiKeys = pool.filter(key => key !== 'solo');
  const routeFor = seed => {
    if (!landscapeSolo) return { keys: pool, allow: () => true };
    if (orientationOf(seed.aspect) === 'landscape') {
      return { keys: ['solo'], allow: c => orientationOf(c.aspect) === 'landscape' };
    }
    return {
      keys: pool.includes('solo') ? pool : multiKeys,
      allow: c => orientationOf(c.aspect) !== 'landscape'
    };
  };

  const stepSkips = [];
  let seated = null;

  for (let index = 0; index < unusedOrder.length && !seated; index++) {
    const seed = unusedOrder[index];
    const { keys, allow } = routeFor(seed);
    const unusedCompanions = unusedOrder.filter((_, other) => other !== index).filter(allow);
    const companions = [...unusedCompanions, ...padOrder.filter(allow)];

    const attempt = seatSeed(keys, seed, companions, unusedCompanions.length, rng);
    seated = attempt.seated;
    if (attempt.skip) stepSkips.push(attempt.skip);
  }

  const report = [...skipped, ...stepSkips].sort((a, b) => a.imageId.localeCompare(b.imageId));

  if (!seated) {
    const error = badRequest(
      `Not enough aspect-compatible images tagged [${sourceTags.join(', ')}] ` +
      'to render the next collage in the rotation'
    );
    error.details = { skipped: report };
    throw error;
  }

  const pickedIds = seated.picks.map(({ imageId }) => imageId);
  pickedIds.forEach(imageId => shown.add(imageId));

  return {
    recipe: recipeFor(seated, matte),
    skipped: report,
    used: [...shown],
    recent: [...pickedIds, ...lru.filter(imageId => !pickedIds.includes(imageId))],
    cycleReset,
    cycle: { used: shown.size, total: candidates.length }
  };
}

module.exports = {
  MIN_CROP_RETENTION,
  MULTI_TEMPLATES,
  SKIP_REASONS,
  poolCandidates,
  buildAutoRecipe,
  buildCoverageRecipes,
  planFluidStep
};
