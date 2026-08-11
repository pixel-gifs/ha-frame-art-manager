import { BORDER_WIDTH, MATTE_PRESETS } from '../geometry.js';

/**
 * Matte preset swatches + border-width slider. The slider is bounded to the
 * server's BORDER_WIDTH range so no layout can collapse a window to nothing.
 */
export default function MattePanel({ matte, onChange }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-neutral-300 mb-2">Matte</h2>
        <div className="flex gap-3">
          {Object.entries(MATTE_PRESETS).map(([key, preset]) => {
            const selected = key === matte.preset;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onChange({ ...matte, preset: key })}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors cursor-pointer ${
                  selected
                    ? 'border-sky-400 bg-sky-400/10'
                    : 'border-neutral-700 hover:border-neutral-500'
                }`}
              >
                <span
                  className="h-5 w-5 rounded-full border border-neutral-600"
                  style={{ backgroundColor: preset.matteColor }}
                />
                <span className="text-xs text-neutral-300">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label htmlFor="border-width" className="flex justify-between text-sm mb-1">
          <span className="font-medium text-neutral-300">Border width</span>
          <span className="text-neutral-500 tabular-nums">{matte.borderWidth}px</span>
        </label>
        <input
          id="border-width"
          type="range"
          min={BORDER_WIDTH.min}
          max={BORDER_WIDTH.max}
          step={10}
          value={matte.borderWidth}
          onChange={(e) => onChange({ ...matte, borderWidth: Number(e.target.value) })}
          className="w-full accent-sky-400"
        />
      </div>
    </section>
  );
}
