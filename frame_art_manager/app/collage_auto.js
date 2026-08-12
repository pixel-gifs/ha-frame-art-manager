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
  normalizeRecipe,
  soloOrientation
} = require('./collage_service');

// A photo is usable in a window when cover-cropping keeps at least this
// fraction of it (1 = aspect matches exactly, lower = more cropped away).
const MIN_CROP_RETENTION = 0.5;

// Why a tagged, non-collage image did not make it into the build. Images that
// fit the chosen template but simply lost the draw are NOT skips — only images
// the build could not place at all.
const SKIP_REASONS = {
  unknownAspect: 'unknown-aspect',      // no dimensions to fit windows with
  noFittingWindow: 'no-fitting-window', // every window crops it below the floor
  landscapeSolo: 'landscape-solo'       // set aside by the landscapeSolo split:
                                        // a landscape barred from a multi-photo
                                        // template, or a portrait left out of a
                                        // build that exists to carry landscapes
};

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
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
 * Assign distinct candidates to a multi-window template's windows so that
 * every window gets an image it fits — a bipartite matching (Kuhn's augmenting
 * paths) over the image↔window "fits" relation. Each window prefers its
 * best-retention candidate, so a feasible layout also looks like a good one.
 *
 * Candidate order is the caller's (pre-shuffled) order and breaks ties, which
 * keeps the whole thing deterministic for a seeded rng.
 *
 * @returns {{ picks: object[]|null, unfittable: string[] }} picks in window
 *          order, or null when no complete assignment exists.
 */
function assignWindows(candidates, templateKey) {
  const aspects = windowAspects(templateKey);

  // Per window: the candidates that fit, best retention first.
  const preferences = aspects.map(winAspect =>
    candidates
      .map((candidate, index) => ({ index, retention: cropRetention(candidate.aspect, winAspect) }))
      .filter(({ retention }) => retention >= MIN_CROP_RETENTION)
      .sort((a, b) => b.retention - a.retention || a.index - b.index)
      .map(({ index }) => index)
  );

  const unfittable = candidates
    .filter(({ aspect }) =>
      !aspects.some(winAspect => cropRetention(aspect, winAspect) >= MIN_CROP_RETENTION))
    .map(({ imageId }) => imageId);

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
  let complete = true;
  for (let win = 0; win < aspects.length; win++) {
    if (!augment(win, new Set())) {
      complete = false;
      break;
    }
  }

  return {
    picks: complete ? pickOf.map(index => candidates[index]) : null,
    unfittable
  };
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

  if (template && !TEMPLATES[template]) {
    throw badRequest(
      `Unknown collage template "${template}". Valid templates: ${Object.keys(TEMPLATES).join(', ')}`
    );
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
  const templateKeys = explicit
    ? [template]
    : Object.keys(TEMPLATES).filter(key => key !== 'solo');
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

module.exports = {
  MIN_CROP_RETENTION,
  SKIP_REASONS,
  poolCandidates,
  buildAutoRecipe
};
