/**
 * Collage groups (#7 decision 11, #11): a named, persisted recipe for a whole
 * batch of collages — where the photos come from, how they are matted, which
 * templates they may fill, and what tag the outputs carry.
 *
 *   { name, sourceTags[], outputTag, matteSpec, templatePool[],
 *     landscapeSolo, mode: 'coverage' | 'fluid' }
 *
 * Config only. It lives in metadata.json under `collageGroups`; per-run state
 * (last-run summaries, fluid cycle logs) deliberately does not, so the git-
 * synced library file stays a description of intent rather than a scratchpad.
 *
 * The matte spec is stored fully resolved, exactly like a saved recipe: a
 * later re-tuning of a swatch cannot silently change what a group renders.
 */

const { getTemplate, resolveMatte } = require('./collage_service');
const { MULTI_TEMPLATES } = require('./collage_auto');
const { badRequest, notFound, conflict } = require('./collage_library');

const GROUP_MODES = ['coverage', 'fluid'];

// Group names reach both URLs and generated filenames, so keep them plain.
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;

/** Validate a group name from a request path or body. */
function normalizeGroupName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!NAME_PATTERN.test(name)) {
    throw badRequest(
      'Group name must be 1-48 characters of letters, digits, hyphen or ' +
      `underscore, starting with a letter or digit (got ${JSON.stringify(value)})`
    );
  }
  return name;
}

function normalizeTagList(value, field) {
  const list = Array.isArray(value) ? value : [];
  const tags = [...new Set(list.map(tag => String(tag).trim()).filter(Boolean))];
  if (tags.length === 0) {
    throw badRequest(`${field} must be a non-empty array of tags`);
  }
  return tags;
}

function normalizeTemplatePool(value) {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    return [...MULTI_TEMPLATES];
  }
  if (!Array.isArray(value)) {
    throw badRequest('templatePool must be an array of template keys');
  }
  const pool = [...new Set(value.map(key => String(key).trim()))];
  for (const key of pool) {
    try {
      getTemplate(key);
    } catch (error) {
      throw badRequest(error.message);
    }
  }
  return pool;
}

/**
 * Validate a group config and resolve it to its stored form. Throws a 400 for
 * anything malformed — a group that cannot build is not worth persisting.
 */
function normalizeGroup(input) {
  if (!input || typeof input !== 'object') {
    throw badRequest('Request body must be a group object');
  }

  const outputTag = typeof input.outputTag === 'string' ? input.outputTag.trim() : '';
  if (!outputTag) {
    throw badRequest('outputTag is required — group outputs never inherit tags from their photos');
  }

  const mode = input.mode === undefined ? 'coverage' : input.mode;
  if (!GROUP_MODES.includes(mode)) {
    throw badRequest(`Unknown group mode "${mode}". Valid modes: ${GROUP_MODES.join(', ')}`);
  }

  let matteSpec;
  try {
    matteSpec = resolveMatte(input.matteSpec && typeof input.matteSpec === 'object' ? input.matteSpec : {});
  } catch (error) {
    throw badRequest(error.message);
  }

  return {
    name: normalizeGroupName(input.name),
    sourceTags: normalizeTagList(input.sourceTags, 'sourceTags'),
    outputTag,
    matteSpec,
    templatePool: normalizeTemplatePool(input.templatePool),
    landscapeSolo: input.landscapeSolo === true,
    mode
  };
}

function findGroup(groups, name) {
  return groups.find(group => group.name.toLowerCase() === name.toLowerCase()) || null;
}

/** The group by that name, or a 404. */
async function requireGroup(helper, name) {
  const group = findGroup(await helper.getCollageGroups(), name);
  if (!group) {
    throw notFound(`Collage group "${name}" not found`);
  }
  return group;
}

async function createGroup(helper, input) {
  const group = normalizeGroup(input);
  const groups = await helper.getCollageGroups();
  if (findGroup(groups, group.name)) {
    throw conflict(`Collage group "${group.name}" already exists`);
  }
  await helper.saveCollageGroups([...groups, group]);
  return group;
}

async function updateGroup(helper, name, input) {
  const groups = await helper.getCollageGroups();
  const existing = findGroup(groups, name);
  if (!existing) {
    throw notFound(`Collage group "${name}" not found`);
  }

  // A group's name is stamped into every collage it has built; renaming would
  // orphan that batch, so it is a delete-and-recreate rather than an edit.
  const group = normalizeGroup({ ...input, name: input.name === undefined ? existing.name : input.name });
  if (group.name.toLowerCase() !== existing.name.toLowerCase()) {
    throw badRequest(
      `Collage groups cannot be renamed ("${existing.name}" is stamped on its collages) — ` +
      'delete the group and create a new one instead'
    );
  }

  await helper.saveCollageGroups(
    groups.map(candidate => (candidate === existing ? { ...group, name: existing.name } : candidate))
  );
  return { ...group, name: existing.name };
}

async function deleteGroup(helper, name) {
  const groups = await helper.getCollageGroups();
  const existing = findGroup(groups, name);
  if (!existing) {
    throw notFound(`Collage group "${name}" not found`);
  }
  await helper.saveCollageGroups(groups.filter(candidate => candidate !== existing));
  return existing;
}

module.exports = {
  GROUP_MODES,
  normalizeGroupName,
  normalizeGroup,
  findGroup,
  requireGroup,
  createGroup,
  updateGroup,
  deleteGroup
};
