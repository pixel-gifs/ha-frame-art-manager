import { useState } from 'react';
import { suggestCollage } from '../api.js';

/**
 * Dice-roll: pick a tag pool, ask the server's auto-pair (dry-run
 * POST /api/collage/suggest) for a recipe, and load it for tweaking.
 */
export default function DicePanel({ allTags, onRecipe }) {
  const [selected, setSelected] = useState([]);
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState(null);

  const toggleTag = (tag) => {
    setError(null);
    setSelected((cur) =>
      cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]
    );
  };

  const roll = async () => {
    setRolling(true);
    setError(null);
    try {
      onRecipe(await suggestCollage(selected));
    } catch (err) {
      setError(err.message);
    } finally {
      setRolling(false);
    }
  };

  return (
    <section>
      <h2 className="text-sm font-medium text-neutral-300 mb-2">
        Dice roll{' '}
        <span className="text-neutral-500 font-normal">
          (auto-pick photos from a tag pool)
        </span>
      </h2>
      <div className="flex flex-wrap gap-2">
        {allTags.map((tag) => (
          <button
            key={tag}
            type="button"
            onClick={() => toggleTag(tag)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors cursor-pointer ${
              selected.includes(tag)
                ? 'border-sky-400 bg-sky-400/15 text-sky-200'
                : 'border-neutral-700 text-neutral-400 hover:border-neutral-500'
            }`}
          >
            {tag}
          </button>
        ))}
        {allTags.length === 0 && (
          <p className="text-xs text-neutral-500">No tags in the library yet.</p>
        )}
      </div>
      <button
        type="button"
        onClick={roll}
        disabled={rolling || selected.length === 0}
        className="mt-3 rounded-lg border border-neutral-600 px-4 py-2 text-sm text-neutral-200 hover:border-neutral-400 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        {rolling ? 'Rolling…' : '🎲 Roll a collage'}
      </button>
      {error && <p className="mt-2 text-sm text-amber-400">{error}</p>}
    </section>
  );
}
