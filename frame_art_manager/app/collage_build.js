/**
 * Coverage builds for collage groups (#7 decision 6, #11).
 *
 * A run renders enough collages that every source photo the group's templates
 * can carry appears at least once, then *replaces* the group's previous batch.
 * The order is deliberate: the new set is rendered and registered in full
 * before a single old collage is removed, so a run that dies half-way leaves
 * the TV showing yesterday's batch rather than nothing at all. If the render
 * fails, everything this run wrote is swept up again.
 *
 * Only images stamped `collageGroup: <name>` are ever removed — hand-made
 * collages and other groups' batches are untouchable.
 *
 * Last-run summaries live in this module's memory, not in metadata.json: they
 * are per-run state, and the library file is config. They are lost on restart,
 * which is exactly what a summary of "what the last run did" is worth.
 */

const MetadataHelper = require('./metadata_helper');
const { buildCoverageRecipes } = require('./collage_auto');
const { badRequest, conflict, saveNewCollage, deleteCollage } = require('./collage_library');

const lastRuns = new Map();  // group name (lowercased) -> summary
const running = new Set();   // group names with a build in flight

function groupKey(name) {
  return name.toLowerCase();
}

/** The previous run's summary for a group, or null. */
function lastRunFor(name) {
  return lastRuns.get(groupKey(name)) || null;
}

/** Drop a deleted group's volatile state. */
function forgetGroup(name) {
  lastRuns.delete(groupKey(name));
}

/** Every library image stamped as part of this group's batch. */
function batchOf(images, name) {
  return Object.entries(images || {})
    .filter(([, entry]) => entry && entry.collageGroup === name)
    .map(([filename]) => filename);
}

/**
 * Run a group's coverage build.
 *
 * @param {string} frameArtPath
 * @param {object} group  a normalized group config
 * @returns {Promise<object>} the run summary: created collages, replaced
 *          filenames, and every source image the build could not place.
 */
async function runCoverageBuild(frameArtPath, group) {
  if (group.mode !== 'coverage') {
    throw badRequest(
      `Collage group "${group.name}" is in ${group.mode} mode — coverage builds need mode "coverage"`
    );
  }
  if (running.has(groupKey(group.name))) {
    throw conflict(`A build is already running for collage group "${group.name}"`);
  }
  running.add(groupKey(group.name));

  const startedAt = new Date().toISOString();
  try {
    const helper = new MetadataHelper(frameArtPath);
    const metadata = await helper.readMetadata();

    const { recipes, skipped } = buildCoverageRecipes({
      images: metadata.images,
      sourceTags: group.sourceTags,
      matte: group.matteSpec,
      templatePool: group.templatePool,
      landscapeSolo: group.landscapeSolo
    });

    // Refuse to swap an empty set in: a mistyped source tag must not wipe a
    // group's collages off the TV.
    if (recipes.length === 0) {
      const error = badRequest(
        `Collage group "${group.name}" produced no collages from tags ` +
        `[${group.sourceTags.join(', ')}] — the previous batch was kept`
      );
      error.details = { skipped };
      throw error;
    }

    const previous = batchOf(metadata.images, group.name);

    const created = [];
    try {
      for (const recipe of recipes) {
        const { filename } = await saveNewCollage(
          frameArtPath,
          recipe,
          [group.outputTag],
          { collageGroup: group.name }
        );
        created.push({
          filename,
          template: recipe.template,
          imageIds: recipe.slots.map(slot => slot.imageId)
        });
      }
    } catch (error) {
      // Generate-before-delete: the old batch is still whole, so all this run
      // has to undo is its own half-written set.
      for (const { filename } of created) {
        await deleteCollage(frameArtPath, filename);
      }
      throw error;
    }

    for (const filename of previous) {
      await deleteCollage(frameArtPath, filename);
    }

    const summary = {
      group: group.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      created,
      removed: previous,
      skipped
    };
    lastRuns.set(groupKey(group.name), summary);
    return summary;
  } finally {
    running.delete(groupKey(group.name));
  }
}

module.exports = { runCoverageBuild, lastRunFor, forgetGroup, batchOf };
