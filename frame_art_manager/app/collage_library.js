/**
 * The library side of collages: turning a recipe into a registered library
 * image, and taking one back out again.
 *
 * Everything here touches the filesystem and metadata.json; the render engine
 * (collage_service.js) and the selection logic (collage_auto.js) stay pure.
 * Shared by the interactive routes (routes/collage.js) and group builds
 * (collage_build.js) so both create and delete collages the same way.
 */

const path = require('path');
const fs = require('fs').promises;

const MetadataHelper = require('./metadata_helper');
const { renderCollage } = require('./collage_service');

const LIBRARY_DIR = 'library';
const THUMBS_DIR = 'thumbs';

/** The error shape the collage routes turn into an HTTP status. */
function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const badRequest = message => statusError(400, message);
const notFound = message => statusError(404, message);
const conflict = message => statusError(409, message);

/**
 * The collage routes' shared error responder: anything carrying a statusCode
 * is the caller's problem and says so (plus whatever `details` it attached,
 * e.g. the skip list behind a refused build); anything else is a 500 with a
 * generic message and a logged stack.
 */
function sendError(res, error, fallbackMessage) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ error: error.message, ...(error.details || {}) });
  }
  console.error(fallbackMessage, error);
  return res.status(500).json({ error: fallbackMessage });
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

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * A free filename for a new collage. The owning group's name goes in front of
 * the template so a batch is recognizable on disk; group names are validated
 * to be filename-safe (collage_groups.js).
 */
async function uniqueCollageFilename(frameArtPath, template, label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const base = ['collage', label, template, stamp].filter(Boolean).join('-');
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

/**
 * Save a new collage: render, register in metadata (with recipe), thumbnail.
 * `collageGroup` names the group this collage belongs to — it is stamped on
 * the metadata entry (which is what makes a batch replaceable) and prefixes
 * the filename.
 *
 * Git push is intentionally not triggered here — the push sweep in server.js
 * picks up library changes and already respects GIT_AUTO_PUSH_ON_CHANGE.
 */
async function saveNewCollage(frameArtPath, recipe, tags, { collageGroup } = {}) {
  const helper = new MetadataHelper(frameArtPath);
  const filename = await uniqueCollageFilename(frameArtPath, recipe.template, collageGroup);
  const filePath = path.join(frameArtPath, LIBRARY_DIR, filename);

  await renderToLibrary(frameArtPath, recipe, filename);

  let data;
  try {
    await helper.addImage(filename, 'none', 'None', tags);
    data = await helper.updateImage(filename, {
      collageRecipe: recipe,
      ...(collageGroup ? { collageGroup } : {})
    });
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

/**
 * Remove a collage completely: metadata entry, library file, thumbnail.
 * Collages have no `originals/` backup — nothing else to sweep up.
 */
async function deleteCollage(frameArtPath, filename) {
  assertSafeImageId(filename);
  const helper = new MetadataHelper(frameArtPath);
  try {
    await helper.deleteImage(filename);
  } catch {
    // Already gone from metadata — still clear the files below
  }
  await removeFileIfExists(path.join(frameArtPath, LIBRARY_DIR, filename));
  await removeFileIfExists(path.join(frameArtPath, THUMBS_DIR, `thumb_${filename}`));
}

module.exports = {
  badRequest,
  notFound,
  conflict,
  sendError,
  assertSafeImageId,
  resolveSources,
  renderToLibrary,
  generateThumbnailSafe,
  saveNewCollage,
  deleteCollage
};
