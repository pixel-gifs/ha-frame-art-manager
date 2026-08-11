import { useState } from 'react';
import { saveCollage, updateCollage } from '../api.js';

/**
 * Save flow: tags input → POST /api/collage (new) or PUT /api/collage/:id
 * (re-edit). After a first save the builder stays open in edit mode, so
 * further saves update the same library file instead of minting new ones.
 */
export default function SavePanel({ recipe, editId, onSaved }) {
  const [tagsInput, setTagsInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAs, setSavedAs] = useState(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      let filename = editId;
      if (editId) {
        await updateCollage(editId, recipe);
      } else {
        ({ filename } = await saveCollage(recipe, tagsInput));
      }
      setSavedAs(filename);
      onSaved(filename);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3">
      {!editId && (
        <div>
          <label htmlFor="collage-tags" className="block text-sm font-medium text-neutral-300 mb-1">
            Tags <span className="text-neutral-500 font-normal">(comma-separated)</span>
          </label>
          <input
            id="collage-tags"
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="collage, family"
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-400 focus:outline-none"
          />
        </div>
      )}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-lg bg-sky-500 px-5 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {saving ? 'Rendering 4K…' : editId ? 'Update collage' : 'Save to library'}
      </button>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {savedAs && !error && (
        <div className="rounded-lg border border-emerald-700 bg-emerald-950/50 px-4 py-3 text-sm">
          <p className="text-emerald-300">
            Saved as <span className="font-mono">{savedAs}</span>.
          </p>
          <p className="mt-1 text-neutral-400">
            <a href="../" className="text-sky-400 hover:text-sky-300">
              ← Back to the gallery
            </a>{' '}
            or keep tweaking — saving again updates this collage.
          </p>
        </div>
      )}
    </section>
  );
}
