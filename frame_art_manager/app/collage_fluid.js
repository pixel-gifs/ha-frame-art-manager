/**
 * Fluid rotation for collage groups (#7 decisions 8, 9, 10; #12, #13).
 *
 * A fluid group holds exactly one collage at a time and replaces it on every
 * step. One call does the whole thing — plan the next collage from the cycle
 * state, render and register it, hard-delete the one it succeeds, log the
 * recipe — so a Home Assistant automation can advance the rotation and then
 * push to the TV without a second round trip or any shuffler change.
 *
 * The order is generate-before-delete: a step that fails to render leaves
 * yesterday's collage on the TV and the cycle exactly where it was. Nothing is
 * written to the state file until the new collage exists.
 *
 * Deleting is a hard delete (#7 decision 10) — but every step's recipe stays
 * in the group's log, so any of the last LOG_LIMIT collages can be re-rendered
 * as a permanent one with promote(). A promoted collage is a normal library
 * image: it is not group-stamped, so neither a later step nor a coverage
 * replace will ever sweep it up.
 */

const MetadataHelper = require('./metadata_helper');
const { planFluidStep, poolCandidates } = require('./collage_auto');
const { normalizeRecipe } = require('./collage_service');
const { badRequest, notFound, saveNewCollage, deleteCollage } = require('./collage_library');
const { batchOf } = require('./collage_build');
const {
  readState,
  writeState,
  groupEntry,
  hasGroupState,
  recordStep,
  findLogEntry
} = require('./collage_state');

// A step reads the library, renders, deletes and rewrites the state file, so
// two of them running at once for the same group would race over which
// collage is live. Steps for the same group queue up; different groups run
// freely. Unlike a coverage build — long, user-triggered, and so refused with
// a 409 while one is running — a rotation step is fired by an automation on a
// timer, where waiting a few seconds beats failing the call.
const locks = new Map();

function withGroupLock(name, task) {
  const key = name.toLowerCase();
  const settled = locks.get(key) || Promise.resolve();
  const run = settled.then(task, task);
  const tail = run.then(() => {}, () => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/**
 * How far through its cycle a fluid group is, plus its promotable recipe log.
 * Photos that have left the tag pool no longer count towards either side of
 * the progress, exactly as the planner treats them.
 */
function rotationState(state, group, images) {
  const entry = groupEntry(state, group.name);
  const { candidates } = poolCandidates(images, group.sourceTags);
  const inPool = new Set(candidates.map(({ imageId }) => imageId));

  return {
    cycle: {
      used: entry.used.filter(imageId => inPool.has(imageId)).length,
      total: candidates.length
    },
    cycles: entry.cycles,
    current: entry.current,
    log: entry.log
  };
}

async function stepOnce(frameArtPath, group) {
  const helper = new MetadataHelper(frameArtPath);
  const metadata = await helper.readMetadata();
  const state = await readState(frameArtPath);
  const entry = groupEntry(state, group.name);

  const plan = planFluidStep({
    images: metadata.images,
    sourceTags: group.sourceTags,
    matte: group.matteSpec,
    templatePool: group.templatePool,
    landscapeSolo: group.landscapeSolo,
    used: entry.used,
    recent: entry.recent
  });

  // Generate before delete: until this resolves, the group's current collage
  // is the only thing the TV can show.
  const { filename } = await saveNewCollage(
    frameArtPath,
    plan.recipe,
    [group.outputTag],
    { collageGroup: group.name }
  );

  // The recipe is logged before anything is deleted: a sweep that dies
  // half-way should cost a stale file (the next step sweeps it) rather than a
  // collage nobody can promote.
  const logged = recordStep(state, group.name, {
    filename,
    recipe: plan.recipe,
    used: plan.used,
    recent: plan.recent,
    cycleReset: plan.cycleReset
  });
  await writeState(frameArtPath, state);

  // Everything else the group has stamped, not just `current`: a group's
  // stamped collages are its live output, so this both replaces the previous
  // step and collapses a batch left behind by a coverage run (or by a lost
  // state file) down to the one collage a rotation is allowed to have.
  const previous = batchOf(metadata.images, group.name).filter(name => name !== filename);
  for (const old of previous) {
    await deleteCollage(frameArtPath, old);
  }

  return {
    group: group.name,
    filename,
    template: plan.recipe.template,
    imageIds: plan.recipe.slots.map(slot => slot.imageId),
    removed: previous,
    skipped: plan.skipped,
    cycle: plan.cycle,
    cycles: groupEntry(state, group.name).cycles,
    entry: logged.id
  };
}

/**
 * Advance a fluid group by one collage.
 *
 * @param {string} frameArtPath
 * @param {object} group  a normalized group config in fluid mode
 * @returns {Promise<object>} the new collage, what it replaced, and cycle
 *          progress (used/total) for the caller to display.
 */
async function runFluidStep(frameArtPath, group) {
  if (group.mode !== 'fluid') {
    throw badRequest(
      `Collage group "${group.name}" is in ${group.mode} mode — rotation steps need mode "fluid"`
    );
  }
  return withGroupLock(group.name, () => stepOnce(frameArtPath, group));
}

/**
 * Re-render a logged recipe as a permanent collage (#13). The output is an
 * ordinary library image with the caller's tags and no group stamp, so it
 * survives every later step and every coverage replace.
 *
 * @param {string} frameArtPath
 * @param {object} ref
 * @param {string} ref.group  group whose log holds the recipe
 * @param {number} ref.entry  log entry id
 * @param {string[]} [ref.tags]
 */
async function promoteLoggedRecipe(frameArtPath, { group, entry, tags = [] }) {
  const id = Number(entry);
  if (!Number.isInteger(id)) {
    throw badRequest('entry must be the id of a logged collage from the group\'s rotation');
  }

  const state = await readState(frameArtPath);
  if (!hasGroupState(state, group)) {
    throw notFound(`Collage group "${group}" has no rotation log`);
  }

  const logged = findLogEntry(state, group, id);
  if (!logged) {
    throw notFound(`Collage group "${group}" has no logged collage #${id} — the log keeps the most recent steps only`);
  }

  const { filename, data } = await saveNewCollage(frameArtPath, normalizeRecipe(logged.recipe), tags);
  return { filename, data, recipe: logged.recipe, promotedFrom: { group, entry: logged.id } };
}

module.exports = { runFluidStep, promoteLoggedRecipe, rotationState };
