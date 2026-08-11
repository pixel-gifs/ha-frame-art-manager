import { useEffect, useRef, useState } from 'react';
import { fetchPreviewUrl } from './api.js';

const DEBOUNCE_MS = 400;

/**
 * Debounced server-rendered preview: any recipe change schedules a
 * POST /api/collage/preview ~400ms out; the returned JPG object URL is the
 * live preview. The last-issued request always wins (stale responses are
 * dropped and their object URLs revoked), so rapid slider drags can't leave
 * the preview showing an older recipe.
 */
export function usePreview(recipe) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const requestSeq = useRef(0);
  const currentUrl = useRef(null);

  useEffect(() => () => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
  }, []);

  // Effect keyed on content, not identity: recipe objects are rebuilt on
  // every edit, and value-equal recipes must not re-render the preview.
  const recipeKey = recipe ? JSON.stringify(recipe) : null;
  const recipeRef = useRef(recipe);
  recipeRef.current = recipe;

  useEffect(() => {
    if (!recipeKey) return undefined;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);

    const timer = setTimeout(async () => {
      try {
        const objectUrl = await fetchPreviewUrl(recipeRef.current);
        if (seq !== requestSeq.current) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
        currentUrl.current = objectUrl;
        setUrl(objectUrl);
        setLoading(false);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err.message);
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [recipeKey]);

  return { url, loading, error };
}
