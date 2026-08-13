/**
 * /api/collage/groups — collage group config CRUD and coverage runs (#11).
 *
 * Config lives in metadata.json (collage_groups.js); the run itself and its
 * summary live in collage_build.js. This layer is only HTTP shape.
 */

const express = require('express');

const router = express.Router();

const MetadataHelper = require('../metadata_helper');
const {
  normalizeGroupName,
  requireGroup,
  createGroup,
  updateGroup,
  deleteGroup
} = require('../collage_groups');
const { runCoverageBuild, lastRunFor, forgetGroup, batchOf } = require('../collage_build');
const { runFluidStep, rotationState } = require('../collage_fluid');
const { readState, writeState, hasGroupState, forgetGroupState } = require('../collage_state');
const { sendError } = require('../collage_library');

/**
 * A group as the UI wants it: config, this process's last-run summary, and —
 * for a fluid group — where its rotation currently stands. The rotation state
 * needs the library and the state file, so callers read those once and pass
 * them in.
 */
function decorateGroup(group, { state, images }) {
  return {
    ...group,
    lastRun: lastRunFor(group.name),
    ...(group.mode === 'fluid' ? { fluid: rotationState(state, group, images) } : {})
  };
}

/**
 * Everything decorateGroup() needs, plus the configured groups themselves —
 * all from a single read of metadata.json.
 */
async function groupContext(frameArtPath) {
  const helper = new MetadataHelper(frameArtPath);
  const [metadata, state] = await Promise.all([helper.readMetadata(), readState(frameArtPath)]);
  return {
    state,
    images: metadata.images,
    groups: Array.isArray(metadata.collageGroups) ? metadata.collageGroups : []
  };
}

// GET /api/collage/groups — every configured group
router.get('/', async (req, res) => {
  try {
    const ctx = await groupContext(req.frameArtPath);
    res.json({ groups: ctx.groups.map(group => decorateGroup(group, ctx)) });
  } catch (error) {
    sendError(res, error, 'Failed to list collage groups');
  }
});

// POST /api/collage/groups — create one
router.post('/', async (req, res) => {
  try {
    const group = await createGroup(new MetadataHelper(req.frameArtPath), req.body);
    res.status(201).json({
      success: true,
      group: decorateGroup(group, await groupContext(req.frameArtPath))
    });
  } catch (error) {
    sendError(res, error, 'Failed to create collage group');
  }
});

// GET /api/collage/groups/:name
router.get('/:name', async (req, res) => {
  try {
    const name = normalizeGroupName(req.params.name);
    const group = await requireGroup(new MetadataHelper(req.frameArtPath), name);
    res.json({ group: decorateGroup(group, await groupContext(req.frameArtPath)) });
  } catch (error) {
    sendError(res, error, 'Failed to read collage group');
  }
});

// PUT /api/collage/groups/:name — edit in place (renames are rejected)
router.put('/:name', async (req, res) => {
  try {
    const name = normalizeGroupName(req.params.name);
    const group = await updateGroup(new MetadataHelper(req.frameArtPath), name, req.body);
    res.json({ success: true, group: decorateGroup(group, await groupContext(req.frameArtPath)) });
  } catch (error) {
    sendError(res, error, 'Failed to update collage group');
  }
});

// DELETE /api/collage/groups/:name — drops the config only. The collages it
// built stay in the library as ordinary images (still stamped, so recreating
// the group and re-running adopts them as the batch to replace).
router.delete('/:name', async (req, res) => {
  try {
    const name = normalizeGroupName(req.params.name);
    const helper = new MetadataHelper(req.frameArtPath);
    const group = await deleteGroup(helper, name);
    forgetGroup(group.name);

    // The rotation log goes with the config — its recipes point at a group
    // that no longer exists, and a recreated group starts a fresh cycle. A
    // group that never rotated has nothing to forget, and writing anyway would
    // create a state file for a library that has never needed one.
    const state = await readState(req.frameArtPath);
    if (hasGroupState(state, group.name)) {
      forgetGroupState(state, group.name);
      await writeState(req.frameArtPath, state);
    }

    const metadata = await helper.readMetadata();
    res.json({ success: true, keptCollages: batchOf(metadata.images, group.name).length });
  } catch (error) {
    sendError(res, error, 'Failed to delete collage group');
  }
});

// POST /api/collage/groups/:name/build — coverage run: render a fresh batch,
// then replace the previous one.
router.post('/:name/build', async (req, res) => {
  try {
    const name = normalizeGroupName(req.params.name);
    const group = await requireGroup(new MetadataHelper(req.frameArtPath), name);
    const summary = await runCoverageBuild(req.frameArtPath, group);
    res.json({ success: true, ...summary });
  } catch (error) {
    sendError(res, error, 'Failed to build collage group');
  }
});

// POST /api/collage/groups/:name/next — fluid rotation: one atomic step.
// Render the next collage, then drop the one it replaces. Meant to be called
// by an HA automation, which then triggers the shuffler push; the TV's tagset
// points at the group's outputTag, so exactly one image ever matches.
router.post('/:name/next', async (req, res) => {
  try {
    const name = normalizeGroupName(req.params.name);
    const group = await requireGroup(new MetadataHelper(req.frameArtPath), name);
    const summary = await runFluidStep(req.frameArtPath, group);
    res.json({ success: true, ...summary });
  } catch (error) {
    sendError(res, error, 'Failed to advance collage group');
  }
});

module.exports = router;
