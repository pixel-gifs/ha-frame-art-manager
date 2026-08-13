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
const { sendError } = require('../collage_library');

/** A group as the UI wants it: config plus this process's last-run summary. */
function withLastRun(group) {
  return { ...group, lastRun: lastRunFor(group.name) };
}

// GET /api/collage/groups — every configured group
router.get('/', async (req, res) => {
  try {
    const groups = await new MetadataHelper(req.frameArtPath).getCollageGroups();
    res.json({ groups: groups.map(withLastRun) });
  } catch (error) {
    sendError(res, error, 'Failed to list collage groups');
  }
});

// POST /api/collage/groups — create one
router.post('/', async (req, res) => {
  try {
    const group = await createGroup(new MetadataHelper(req.frameArtPath), req.body);
    res.status(201).json({ success: true, group: withLastRun(group) });
  } catch (error) {
    sendError(res, error, 'Failed to create collage group');
  }
});

// GET /api/collage/groups/:name
router.get('/:name', async (req, res) => {
  try {
    const name = normalizeGroupName(req.params.name);
    const group = await requireGroup(new MetadataHelper(req.frameArtPath), name);
    res.json({ group: withLastRun(group) });
  } catch (error) {
    sendError(res, error, 'Failed to read collage group');
  }
});

// PUT /api/collage/groups/:name — edit in place (renames are rejected)
router.put('/:name', async (req, res) => {
  try {
    const name = normalizeGroupName(req.params.name);
    const group = await updateGroup(new MetadataHelper(req.frameArtPath), name, req.body);
    res.json({ success: true, group: withLastRun(group) });
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

module.exports = router;
