const express = require('express');
const path = require('path');
const fs = require('fs').promises;

const router = express.Router();

const MetadataHelper = require('../metadata_helper');
const {
  normalizeRecipe,
  renderCollage,
  renderPreview
} = require('../collage_service');
const { buildAutoRecipe } = require('../collage_auto');

const LIBRARY_DIR = 'library';

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

// Recipe imageIds are library filenames — reject anything path-like.
function assertSafeImageId(imageId) {
  if (
    imageId.includes('/') ||
    imageId.includes('\\') ||
    imageId.includes('..') ||
    path.basename(imageId) !== imageId
  ) {
    throw badRequest(`Invalid imageId "${imageId}"`);
  }
}

// Map each slot's imageId to its library file path, verifying existence.
async function resolveSources(frameArtPath, recipe) {
  const sources = {};
  const missing = [];

  for (const slot of recipe.slots) {
    assertSafeImageId(slot.imageId);
    const filePath = path.join(frameArtPath, LIBRARY_DIR, slot.imageId);
    try {
      await fs.access(filePath);
      sources[slot.imageId] = filePath;
    } catch {
      missing.push(slot.imageId);
    }
  }

  if (missing.length > 0) {
    throw notFound(`Image(s) not found in library: ${missing.join(', ')}`);
  }

  return sources;
}

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

function sendError(res, error, fallbackMessage) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error(fallbackMessage, error);
  return res.status(500).json({ error: fallbackMessage });
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

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

async function uniqueCollageFilename(frameArtPath, template) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const base = `collage-${template}-${stamp}`;
  let filename = `${base}.jpg`;
  let counter = 1;
  while (true) {
    try {
      await fs.access(path.join(frameArtPath, LIBRARY_DIR, filename));
      filename = `${base}-${counter++}.jpg`;
    } catch {
      return filename;
    }
  }
}

// Render at full canvas size and write the JPG into the library dir.
async function renderToLibrary(frameArtPath, recipe, filename) {
  const sources = await resolveSources(frameArtPath, recipe);
  const { buffer } = await renderCollage(recipe, sources);
  await fs.writeFile(path.join(frameArtPath, LIBRARY_DIR, filename), buffer);
}

async function generateThumbnailSafe(helper, filename) {
  try {
    await helper.generateThumbnail(filename);
  } catch (thumbError) {
    console.error(`[Collage] Thumbnail generation failed for ${filename}:`, thumbError.message);
  }
}

// Save a new collage: render, register in metadata (with recipe), thumbnail.
// Git push is intentionally not triggered here — the push sweep in server.js
// picks up library changes and already respects GIT_AUTO_PUSH_ON_CHANGE.
async function saveNewCollage(frameArtPath, recipe, tags) {
  const helper = new MetadataHelper(frameArtPath);
  const filename = await uniqueCollageFilename(frameArtPath, recipe.template);
  const filePath = path.join(frameArtPath, LIBRARY_DIR, filename);

  await renderToLibrary(frameArtPath, recipe, filename);

  let data;
  try {
    await helper.addImage(filename, 'none', 'None', tags);
    data = await helper.updateImage(filename, { collageRecipe: recipe });
  } catch (error) {
    await removeFileIfExists(filePath);
    try {
      await helper.deleteImage(filename);
    } catch {
      // Entry was never registered — nothing to clean up
    }
    throw error;
  }

  await generateThumbnailSafe(helper, filename);
  return { filename, data };
}

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
