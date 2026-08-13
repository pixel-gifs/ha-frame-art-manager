// All URLs are relative to the page URL so the app works behind the HA
// ingress prefix. The built app lives at <prefix>/collage/, so one level up
// reaches the Express roots (/api, /thumbs, /library). The Vite dev server
// serves the page at /, where '../api' still resolves to /api and hits the
// dev proxy.
export const API_BASE = '../api';

export function thumbUrl(filename) {
  return `../thumbs/thumb_${encodeURIComponent(filename)}`;
}

export function libraryUrl(filename) {
  return `../library/${encodeURIComponent(filename)}`;
}

/** Image ids selected in the gallery, from /collage?ids=a,b,c */
export function idsFromQuery(search = window.location.search) {
  const raw = new URLSearchParams(search).get('ids') || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Collage being re-edited, from /collage?edit=<imageId> */
export function editIdFromQuery(search = window.location.search) {
  return new URLSearchParams(search).get('edit') || null;
}

/** Which top-level view to open, from /collage?view=groups */
export function viewFromQuery(search = window.location.search) {
  return new URLSearchParams(search).get('view') === 'groups' ? 'groups' : 'builder';
}

async function throwApiError(res, fallbackMessage) {
  let message = fallbackMessage;
  let details = null;
  try {
    const body = await res.json();
    if (body && body.error) message = body.error;
    // Refused requests can carry structure worth showing (a build that
    // rendered nothing still reports why every photo was skipped).
    if (body && body.skipped) details = { skipped: body.skipped };
  } catch {
    // Non-JSON error body — keep the fallback message
  }
  const error = new Error(message);
  if (details) Object.assign(error, details);
  throw error;
}

async function parseJsonOrThrow(res, fallbackMessage) {
  if (res.ok) return res.json();
  return throwApiError(res, fallbackMessage);
}

export async function fetchLibrary() {
  const res = await fetch(`${API_BASE}/images`);
  return parseJsonOrThrow(res, `GET /api/images failed (${res.status})`);
}

export async function fetchTags() {
  const res = await fetch(`${API_BASE}/tags`);
  return parseJsonOrThrow(res, `GET /api/tags failed (${res.status})`);
}

function postJson(url, body, method = 'POST') {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Low-res WYSIWYG render of the recipe; resolves to an object URL. */
export async function fetchPreviewUrl(recipe) {
  const res = await postJson(`${API_BASE}/collage/preview`, { recipe });
  if (!res.ok) return throwApiError(res, `Preview failed (${res.status})`);
  return URL.createObjectURL(await res.blob());
}

/** Dice-roll: dry-run auto-pair from a tag pool, returns a recipe to tweak. */
export async function suggestCollage(tagPool) {
  const res = await postJson(`${API_BASE}/collage/suggest`, { tagPool });
  const body = await parseJsonOrThrow(res, 'Failed to suggest a collage');
  return body.recipe;
}

/** Save a new collage into the library. Returns { filename, data }. */
export async function saveCollage(recipe, tags) {
  const res = await postJson(`${API_BASE}/collage`, { recipe, tags });
  return parseJsonOrThrow(res, 'Failed to save collage');
}

/** Re-render an existing collage in place. */
export async function updateCollage(imageId, recipe) {
  const res = await postJson(
    `${API_BASE}/collage/${encodeURIComponent(imageId)}`,
    { recipe },
    'PUT'
  );
  return parseJsonOrThrow(res, 'Failed to update collage');
}

// --- Collage groups (#11) ---

const groupUrl = (name) => `${API_BASE}/collage/groups/${encodeURIComponent(name)}`;

/** Every configured group, each with this server run's last-run summary. */
export async function fetchGroups() {
  const res = await fetch(`${API_BASE}/collage/groups`);
  const body = await parseJsonOrThrow(res, `GET /api/collage/groups failed (${res.status})`);
  return body.groups || [];
}

export async function createGroup(group) {
  const res = await postJson(`${API_BASE}/collage/groups`, group);
  return (await parseJsonOrThrow(res, 'Failed to create the group')).group;
}

export async function updateGroup(name, group) {
  const res = await postJson(groupUrl(name), group, 'PUT');
  return (await parseJsonOrThrow(res, 'Failed to save the group')).group;
}

export async function deleteGroup(name) {
  const res = await fetch(groupUrl(name), { method: 'DELETE' });
  return parseJsonOrThrow(res, 'Failed to delete the group');
}

/** Run a coverage build: renders a fresh batch, then replaces the old one. */
export async function buildGroup(name) {
  const res = await postJson(`${groupUrl(name)}/build`, {});
  return parseJsonOrThrow(res, 'Failed to build the group');
}

// --- Fluid rotation (#12, #13) ---

/** Advance a fluid group: renders the next collage, then drops the old one. */
export async function advanceGroup(name) {
  const res = await postJson(`${groupUrl(name)}/next`, {});
  return parseJsonOrThrow(res, 'Failed to advance the rotation');
}

/** Re-render a logged rotation recipe as a permanent, ungrouped collage. */
export async function promoteLogEntry(group, entry, tags) {
  const res = await postJson(`${API_BASE}/collage/promote`, { group, entry, tags });
  return parseJsonOrThrow(res, 'Failed to promote the collage');
}
