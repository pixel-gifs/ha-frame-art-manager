/**
 * Auto-pair slot-filling for collages.
 *
 * Pure selection logic: given the library's metadata images map and a tag
 * pool, pick aspect-compatible portrait photos and produce a ready-to-render
 * recipe. No filesystem or network access - the route layer resolves files.
 */

const {
  BORDER_WIDTH,
  TEMPLATES,
  MATTE_PRESETS,
  computeLayout,
  normalizeRecipe
} = require('./collage_service');

// A photo is usable in a window when cover-cropping keeps at least this
// fraction of it (1 = aspect matches exactly, lower = more cropped away).
const MIN_CROP_RETENTION = 0.5;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function entryAspect(entry) {
  if (entry.dimensions && entry.dimensions.width > 0 && entry.dimensions.height > 0) {
    return entry.dimensions.width / entry.dimensions.height;
  }
  return typeof entry.aspectRatio === 'number' ? entry.aspectRatio : null;
}

function windowAspects(templateKey) {
  return computeLayout(templateKey, BORDER_WIDTH.default).map(w => w.width / w.height);
}

function cropRetention(imageAspect, windowAspect) {
  return Math.min(imageAspect / windowAspect, windowAspect / imageAspect);
}

/**
 * Portrait images from the tag pool, excluding existing collages.
 * Returns [{ imageId, aspect }].
 */
function poolCandidates(images, tagPool) {
  const pool = tagPool.map(tag => String(tag).trim()).filter(Boolean);
  return Object.entries(images || {})
    .filter(([, entry]) => entry && !entry.collageRecipe)
    .map(([imageId, entry]) => ({ imageId, entry, aspect: entryAspect(entry) }))
    .filter(({ entry, aspect }) => {
      if (!aspect || aspect >= 1) return false; // portraits only
      const tags = Array.isArray(entry.tags) ? entry.tags : [];
      return tags.some(tag => pool.includes(tag));
    })
    .map(({ imageId, aspect }) => ({ imageId, aspect }));
}

/** Candidates that fit every window of the template acceptably. */
function compatibleCandidates(candidates, templateKey) {
  const aspects = windowAspects(templateKey);
  return candidates.filter(({ aspect }) =>
    aspects.every(winAspect => cropRetention(aspect, winAspect) >= MIN_CROP_RETENTION)
  );
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
 * @param {string} [opts.mattePreset] matte preset key; random if omitted
 * @param {function} [opts.rng]      0..1 random source (injectable for tests)
 * @returns normalized recipe
 */
function buildAutoRecipe({ images, tagPool, template, mattePreset, rng = Math.random } = {}) {
  if (!Array.isArray(tagPool) || tagPool.filter(t => String(t).trim()).length === 0) {
    throw badRequest('tagPool must be a non-empty array of tags');
  }

  if (template !== undefined && !TEMPLATES[template]) {
    throw badRequest(
      `Unknown collage template "${template}". Valid templates: ${Object.keys(TEMPLATES).join(', ')}`
    );
  }
  if (mattePreset !== undefined && !MATTE_PRESETS[mattePreset]) {
    throw badRequest(
      `Unknown matte preset "${mattePreset}". Valid presets: ${Object.keys(MATTE_PRESETS).join(', ')}`
    );
  }

  const candidates = poolCandidates(images, tagPool);

  const templateKeys = template ? [template] : Object.keys(TEMPLATES);
  const feasible = templateKeys
    .map(key => ({ key, eligible: compatibleCandidates(candidates, key) }))
    .filter(({ key, eligible }) => eligible.length >= TEMPLATES[key].slotCount);

  if (feasible.length === 0) {
    const need = template ? TEMPLATES[template].slotCount : Math.min(...Object.values(TEMPLATES).map(t => t.slotCount));
    throw badRequest(
      `Not enough aspect-compatible portrait images tagged [${tagPool.join(', ')}] ` +
      `(need at least ${need}, found ${candidates.length} portrait candidates)`
    );
  }

  const chosen = feasible[Math.floor(rng() * feasible.length)];
  const preset = mattePreset || Object.keys(MATTE_PRESETS)[Math.floor(rng() * Object.keys(MATTE_PRESETS).length)];
  const picks = shuffle(chosen.eligible, rng).slice(0, TEMPLATES[chosen.key].slotCount);

  return normalizeRecipe({
    template: chosen.key,
    matte: { preset, borderWidth: BORDER_WIDTH.default },
    slots: picks.map(({ imageId }) => ({ imageId, focal: { x: 0.5, y: 0.5 } }))
  });
}

module.exports = {
  MIN_CROP_RETENTION,
  poolCandidates,
  compatibleCandidates,
  buildAutoRecipe
};
