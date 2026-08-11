import { useEffect, useState } from 'react';
import { API_BASE, thumbUrl, idsFromQuery } from './api.js';

const MIN_IMAGES = 2;
const MAX_IMAGES = 4;

export default function App() {
  const [ids] = useState(idsFromQuery);
  const [library, setLibrary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/images`)
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/images failed (${res.status})`);
        return res.json();
      })
      .then(setLibrary)
      .catch((err) => setError(err.message));
  }, []);

  const missing = library ? ids.filter((id) => !(id in library)) : [];
  const countOk = ids.length >= MIN_IMAGES && ids.length <= MAX_IMAGES;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4 flex items-baseline gap-4">
        <h1 className="text-xl font-semibold">Collage Builder</h1>
        <a href="../" className="text-sm text-neutral-400 hover:text-neutral-200">
          ← Back to gallery
        </a>
      </header>

      <main className="p-6 space-y-6">
        {error && (
          <p className="text-red-400">Could not load the library: {error}</p>
        )}

        {!countOk && (
          <p className="text-amber-400">
            Select {MIN_IMAGES}–{MAX_IMAGES} images in the gallery, then choose
            “Create collage”. Got {ids.length}.
          </p>
        )}

        {missing.length > 0 && (
          <p className="text-amber-400">
            Not found in the library: {missing.join(', ')}
          </p>
        )}

        {library && countOk && (
          <>
            <p className="text-neutral-400 text-sm">
              {ids.length} images selected — templates, mattes and preview land
              with the builder (issue #5).
            </p>
            <ul className="flex flex-wrap gap-4">
              {ids
                .filter((id) => id in library)
                .map((id) => (
                  <li key={id} className="w-40">
                    <img
                      src={thumbUrl(id)}
                      alt={id}
                      className="w-full rounded-lg border border-neutral-800 object-cover"
                    />
                    <p className="mt-1 truncate text-xs text-neutral-400">{id}</p>
                  </li>
                ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}
