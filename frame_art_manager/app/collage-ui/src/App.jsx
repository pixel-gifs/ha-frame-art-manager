import { useEffect, useMemo, useState } from 'react';
import { editIdFromQuery, fetchLibrary, fetchTags, idsFromQuery } from './api.js';
import { BORDER_WIDTH, TEMPLATES } from './geometry.js';
import { usePreview } from './usePreview.js';
import TemplatePicker from './components/TemplatePicker.jsx';
import SlotStrip from './components/SlotStrip.jsx';
import MattePanel from './components/MattePanel.jsx';
import PreviewPane from './components/PreviewPane.jsx';
import DicePanel from './components/DicePanel.jsx';
import SavePanel from './components/SavePanel.jsx';

const MIN_IMAGES = 2;
const MAX_IMAGES = 4;

const DEFAULT_TEMPLATE_BY_COUNT = {
  2: 'diptych-2',
  3: 'triptych-3',
  4: 'grid-2x2',
};

function defaultSlots(imageIds) {
  return imageIds.map((imageId) => ({ imageId, focal: { x: 0.5, y: 0.5 } }));
}

export default function App() {
  const [ids] = useState(idsFromQuery);
  const [editId, setEditId] = useState(editIdFromQuery);
  const [library, setLibrary] = useState(null);
  const [allTags, setAllTags] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [recipe, setRecipe] = useState(null);
  // Photos available to the builder: the gallery selection, or whatever the
  // last dice-roll / loaded recipe brought in. Template switches draw from it.
  const [pool, setPool] = useState([]);

  const { url: previewUrl, loading: previewLoading, error: previewError } = usePreview(recipe);

  useEffect(() => {
    Promise.all([fetchLibrary(), fetchTags().catch(() => [])])
      .then(([images, tags]) => {
        setLibrary(images);
        setAllTags(Array.isArray(tags) ? tags : []);
      })
      .catch((err) => setLoadError(err.message));
  }, []);

  // Initialize the recipe once the library arrives: either the stored recipe
  // of the collage being re-edited, or a default layout over the URL ids.
  useEffect(() => {
    if (!library || recipe) return;

    if (editId) {
      const entry = library[editId];
      if (entry && entry.collageRecipe) {
        setRecipe(entry.collageRecipe);
        setPool(entry.collageRecipe.slots.map((slot) => slot.imageId));
      }
      return;
    }

    const known = ids.filter((id) => id in library);
    if (known.length >= MIN_IMAGES && known.length <= MAX_IMAGES) {
      setRecipe({
        template: DEFAULT_TEMPLATE_BY_COUNT[known.length],
        matte: { preset: 'gallery-white', borderWidth: BORDER_WIDTH.default },
        slots: defaultSlots(known),
      });
      setPool(known);
    }
  }, [library, recipe, editId, ids]);

  const missing = useMemo(
    () => (library && !editId ? ids.filter((id) => !(id in library)) : []),
    [library, editId, ids]
  );

  const changeTemplate = (templateKey) => {
    setRecipe((cur) => {
      const slotCount = TEMPLATES[templateKey].slotCount;
      const focalByImage = new Map(cur.slots.map((slot) => [slot.imageId, slot.focal]));
      const ordered = [
        ...cur.slots.map((slot) => slot.imageId),
        ...pool.filter((id) => !cur.slots.some((slot) => slot.imageId === id)),
      ];
      return {
        ...cur,
        template: templateKey,
        slots: ordered.slice(0, slotCount).map((imageId) => ({
          imageId,
          focal: focalByImage.get(imageId) || { x: 0.5, y: 0.5 },
        })),
      };
    });
  };

  const swapSlots = (i, j) => {
    setRecipe((cur) => {
      const slots = cur.slots.slice();
      [slots[i], slots[j]] = [slots[j], slots[i]];
      return { ...cur, slots };
    });
  };

  const setFocal = (slotIndex, focal) => {
    setRecipe((cur) => ({
      ...cur,
      slots: cur.slots.map((slot, i) => (i === slotIndex ? { ...slot, focal } : slot)),
    }));
  };

  const applySuggestion = (suggested) => {
    setRecipe(suggested);
    setPool(suggested.slots.map((slot) => slot.imageId));
  };

  const editEntryProblem =
    editId && library
      ? !library[editId]
        ? `"${editId}" is not in the library.`
        : !library[editId].collageRecipe
          ? `"${editId}" is not a collage — only collages can be re-edited.`
          : null
      : null;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4 flex items-baseline gap-4">
        <h1 className="text-xl font-semibold">Collage Builder</h1>
        {editId && recipe && (
          <span className="text-sm text-neutral-500 truncate">
            editing <span className="font-mono text-neutral-400">{editId}</span>
          </span>
        )}
        <a href="../" className="ml-auto text-sm text-neutral-400 hover:text-neutral-200">
          ← Back to gallery
        </a>
      </header>

      <main className="p-6">
        {loadError && <p className="text-red-400">Could not load the library: {loadError}</p>}

        {editEntryProblem && <p className="text-amber-400">{editEntryProblem}</p>}

        {library && !editId && !recipe && (
          <div className="space-y-2">
            <p className="text-amber-400">
              Select {MIN_IMAGES}–{MAX_IMAGES} images in the gallery, then choose “Create
              collage”. Got {ids.filter((id) => id in library).length}.
            </p>
            {missing.length > 0 && (
              <p className="text-amber-400">Not found in the library: {missing.join(', ')}</p>
            )}
          </div>
        )}

        {!library && !loadError && <p className="text-neutral-500">Loading library…</p>}

        {library && recipe && (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-6 min-w-0">
              <PreviewPane
                recipe={recipe}
                library={library}
                previewUrl={previewUrl}
                loading={previewLoading}
                error={previewError}
                onFocalChange={setFocal}
              />
              <SlotStrip slots={recipe.slots} onSwap={swapSlots} />
            </div>

            <div className="space-y-8">
              <TemplatePicker
                value={recipe.template}
                poolSize={pool.length}
                borderWidth={recipe.matte.borderWidth}
                onChange={changeTemplate}
              />
              <MattePanel
                matte={recipe.matte}
                onChange={(matte) => setRecipe((cur) => ({ ...cur, matte }))}
              />
              <DicePanel allTags={allTags} onRecipe={applySuggestion} />
              <SavePanel recipe={recipe} editId={editId} onSaved={setEditId} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
