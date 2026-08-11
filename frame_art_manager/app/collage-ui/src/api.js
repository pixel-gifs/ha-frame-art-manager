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

async function parseJsonOrThrow(res, fallbackMessage) {
  if (res.ok) return res.json();
  let message = fallbackMessage;
  try {
    const body = await res.json();
    if (body && body.error) message = body.error;
  } catch {
    // Non-JSON error body — keep the fallback message
  }
  throw new Error(message);
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
export async function fetchPreviewUrl(recipe, signal) {
  const res = await fetch(`${API_BASE}/collage/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipe }),
    signal,
  });
  if (!res.ok) {
    let message = `Preview failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch {
      // keep fallback
    }
    throw new Error(message);
  }
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
