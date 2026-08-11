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
