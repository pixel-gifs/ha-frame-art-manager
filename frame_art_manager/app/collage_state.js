/**
 * Volatile collage state: `collage_state.json`, beside metadata.json (#7
 * decision 11, #12).
 *
 * Fluid groups need state that changes on every step — which photos the
 * current cycle has shown, how many cycles have closed, which collage is live,
 * and the last ~50 recipes so any of them can be promoted back into a
 * permanent collage. None of that belongs in metadata.json: that file is the
 * library's config and history, synced through git, and a per-step scratchpad
 * would make it a merge-conflict machine for no gain. So this file sits next
 * to it and is added to the library's .gitignore on first write — losing it
 * costs a cycle's memory, nothing more.
 *
 * Shape:
 *   { version: 1, groups: { <lowercased name>: {
 *       used: [imageId],    // shown this cycle
 *       recent: [imageId],  // most recently shown first (the LRU order)
 *       cycles: n,          // completed cycles
 *       current: filename,  // the collage currently in rotation
 *       seq: n,             // last log id issued
 *       log: [{ id, at, filename, template, imageIds, recipe }]  // newest first
 *   } } }
 */

const path = require('path');
const fs = require('fs').promises;

const STATE_FILE = 'collage_state.json';
const GITIGNORE_FILE = '.gitignore';

// How many steps of a group's rotation stay promotable (#7 decision 10).
const LOG_LIMIT = 50;

function statePath(frameArtPath) {
  return path.join(frameArtPath, STATE_FILE);
}

function groupKey(name) {
  return String(name).toLowerCase();
}

function blankEntry() {
  return { used: [], recent: [], cycles: 0, current: null, seq: 0, log: [] };
}

/**
 * A group's state, or a blank one if it has never rotated. Reading never
 * writes: the state object is shared across every group in a listing, and a
 * getter that materialized entries would persist phantom groups the next time
 * anything saved it. recordStep is what creates an entry.
 */
function groupEntry(state, name) {
  return { ...blankEntry(), ...((state.groups || {})[groupKey(name)]) };
}

/** Whether a group has rotated at all — a blank entry is not a log. */
function hasGroupState(state, name) {
  return Boolean((state.groups || {})[groupKey(name)]);
}

/** Drop a deleted group's cycle state and recipe log. */
function forgetGroupState(state, name) {
  if (state.groups) delete state.groups[groupKey(name)];
}

/**
 * Read the state file. A missing or unreadable file is an empty state rather
 * than an error: the worst case is a rotation that starts its cycle over.
 */
async function readState(frameArtPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(frameArtPath), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, groups: {} };
    return { version: 1, ...parsed, groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {} };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[Collage] Unreadable collage_state.json — starting from an empty state:', error.message);
    }
    return { version: 1, groups: {} };
  }
}

/**
 * Keep the state file out of the library's git history. Anything else would
 * push a commit per rotation step and make the file a conflict hotspot
 * between instances.
 */
async function ensureIgnored(frameArtPath) {
  const ignorePath = path.join(frameArtPath, GITIGNORE_FILE);
  let current = '';
  try {
    current = await fs.readFile(ignorePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (current.split(/\r?\n/).some(line => line.trim() === STATE_FILE)) return;

  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  await fs.writeFile(ignorePath, `${prefix}${STATE_FILE}\n`);
}

async function writeState(frameArtPath, state) {
  await fs.writeFile(statePath(frameArtPath), JSON.stringify({ version: 1, ...state }, null, 2));
  try {
    await ensureIgnored(frameArtPath);
  } catch (error) {
    // A library that is not a git checkout (or a read-only .gitignore) is not
    // a reason to fail a rotation step.
    console.error('[Collage] Could not add collage_state.json to .gitignore:', error.message);
  }
}

/**
 * Record one fluid step against a group: advance the cycle, remember the live
 * collage, and push the recipe onto the ring-buffered log.
 *
 * @returns {object} the log entry that was written (its `id` is what promote
 *          refers to).
 */
function recordStep(state, name, { filename, recipe, used, recent, cycleReset, at = new Date().toISOString() }) {
  const key = groupKey(name);
  if (!state.groups) state.groups = {};
  const entry = groupEntry(state, name);

  const logEntry = {
    id: entry.seq + 1,
    at,
    filename,
    template: recipe.template,
    imageIds: (recipe.slots || []).map(slot => slot.imageId),
    recipe
  };

  state.groups[key] = {
    used,
    recent,
    // A reset means the cycle that just ended is complete.
    cycles: entry.cycles + (cycleReset ? 1 : 0),
    current: filename,
    seq: logEntry.id,
    log: [logEntry, ...entry.log].slice(0, LOG_LIMIT)
  };

  return logEntry;
}

/** A logged recipe by id, or null. Ids are per group and never reused. */
function findLogEntry(state, name, id) {
  const wanted = Number(id);
  if (!Number.isInteger(wanted)) return null;
  return groupEntry(state, name).log.find(item => item.id === wanted) || null;
}

module.exports = {
  STATE_FILE,
  LOG_LIMIT,
  readState,
  writeState,
  groupEntry,
  hasGroupState,
  forgetGroupState,
  recordStep,
  findLogEntry
};
