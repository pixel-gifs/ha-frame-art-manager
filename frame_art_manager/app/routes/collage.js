const express = require('express');

const router = express.Router();

const MetadataHelper = require('../metadata_helper');
const { normalizeRecipe, renderPreview } = require('../collage_service');
const { buildAutoRecipe } = require('../collage_auto');
const {
  badRequest,
  notFound,
  sendError,
  assertSafeImageId,
  resolveSources,
  renderToLibrary,
  generateThumbnailSafe,
  saveNewCollage
} = require('../collage_library');
const groupsRouter = require('./collage_groups');
const { normalizeGroupName } = require('../collage_groups');
const { promoteLoggedRecipe } = require('../collage_fluid');

function parseRecipe(body) {
  if (!body || typeof body.recipe !== 'object' || body.recipe === null) {
    throw badRequest('Request body must include a recipe object');
  }
  try {
    return normalizeRecipe(body.recipe);
  } catch (error) {
    throw badRequest(error.message);
  }
}

// POST /api/collage/preview — fast low-res render, no disk writes
router.post('/preview', async (req, res) => {
  try {
    const recipe = parseRecipe(req.body);
    const sources = await resolveSources(req.frameArtPath, recipe);
    const { buffer } = await renderPreview(recipe, sources);

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    sendError(res, error, 'Failed to render collage preview');
  }
});

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map(tag => String(tag).trim()).filter(Boolean);
  }
  if (typeof tags === 'string') {
    return tags.split(',').map(tag => tag.trim()).filter(Boolean);
  }
  return [];
}

// Collage groups (#11) — config CRUD + coverage builds. Mounted before the
// /:imageId routes below, which would otherwise swallow "groups" as a filename.
router.use('/groups', groupsRouter);

// POST /api/collage — render full-size, save to library, register metadata
router.post('/', async (req, res) => {
  try {
    const recipe = parseRecipe(req.body);
    const tags = normalizeTags(req.body.tags);
    const { filename, data } = await saveNewCollage(req.frameArtPath, recipe, tags);
    res.json({ success: true, filename, data });
  } catch (error) {
    sendError(res, error, 'Failed to save collage');
  }
});

/**
 * Run the auto-pair selection for a request body. Returns { recipe, skipped }.
 */
async function autoSelect(req) {
  const { tagPool, template, mattePreset, landscapeSolo } = req.body || {};
  const helper = new MetadataHelper(req.frameArtPath);
  const metadata = await helper.readMetadata();

  return buildAutoRecipe({
    images: metadata.images,
    tagPool,
    template,
    mattePreset,
    landscapeSolo: landscapeSolo === true
  });
}

// POST /api/collage/auto — unattended slot-fill + save (nightly HA automations)
router.post('/auto', async (req, res) => {
  try {
    const tags = normalizeTags(req.body && req.body.tags);
    const { recipe, skipped } = await autoSelect(req);

    const { filename, data } = await saveNewCollage(req.frameArtPath, recipe, tags);
    res.json({ success: true, filename, recipe, skipped, data });
  } catch (error) {
    sendError(res, error, 'Failed to auto-generate collage');
  }
});

// POST /api/collage/suggest — dry-run auto-pair for the builder's dice-roll:
// same selection logic as /auto, but nothing is rendered or saved, so the user
// can tweak the recipe before committing.
router.post('/suggest', async (req, res) => {
  try {
    const { recipe, skipped } = await autoSelect(req);
    res.json({ recipe, skipped });
  } catch (error) {
    sendError(res, error, 'Failed to suggest collage');
  }
});

// POST /api/collage/promote — rescue a collage the rotation has already
// deleted (or is about to): re-render a logged recipe as a permanent library
// image. It carries the caller's tags and no group stamp, so no later
// rotation step or coverage replace can touch it.
router.post('/promote', async (req, res) => {
  try {
    const { group, entry, tags } = req.body || {};
    const result = await promoteLoggedRecipe(req.frameArtPath, {
      group: normalizeGroupName(group),
      entry,
      tags: normalizeTags(tags)
    });
    res.json({ success: true, ...result });
  } catch (error) {
    sendError(res, error, 'Failed to promote collage');
  }
});

// PUT /api/collage/:imageId — re-render an existing collage in place
router.put('/:imageId', async (req, res) => {
  try {
    const { imageId } = req.params;
    assertSafeImageId(imageId);

    const helper = new MetadataHelper(req.frameArtPath);
    const metadata = await helper.readMetadata();
    const entry = metadata.images[imageId];
    if (!entry) {
      throw notFound(`Image "${imageId}" not found`);
    }
    if (!entry.collageRecipe) {
      throw badRequest(`Image "${imageId}" is not a collage`);
    }

    const recipe = parseRecipe(req.body);
    await renderToLibrary(req.frameArtPath, recipe, imageId);
    const data = await helper.updateImage(imageId, { collageRecipe: recipe });
    await generateThumbnailSafe(helper, imageId);

    res.json({ success: true, filename: imageId, data });
  } catch (error) {
    sendError(res, error, 'Failed to update collage');
  }
});

module.exports = router;
