import { useState } from 'react';
import { BORDER_CHIPS, BORDER_WIDTH, MATTE_SWATCHES } from '../geometry.js';

const DEPTH_STYLE_OPTIONS = [
  { key: 'miter', label: 'Mitered' },
  { key: 'recess', label: 'Recess' },
  { key: 'double', label: 'Double' },
];

const TEXTURE_OPTIONS = [
  { key: 'none', label: 'None' },
  { key: 'fibre', label: 'Fibre' },
  { key: 'weave', label: 'Weave' },
];

function Chip({ selected, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors cursor-pointer ${
        selected
          ? 'border-sky-400 bg-sky-400/15 text-sky-200'
          : 'border-neutral-700 text-neutral-400 hover:border-neutral-500'
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({ id, label, hint, checked, onChange }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 cursor-pointer select-none">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-sky-400 cursor-pointer"
      />
      <span className="text-xs text-neutral-300">
        {label}
        <span className="block text-neutral-500">{hint}</span>
      </span>
    </label>
  );
}

/**
 * Direct matte controls (#7 decisions 1, 2, 5): curated swatch grid, depth
 * treatment, texture, effect toggles, and named border chips with the raw
 * slider behind an "advanced" disclosure. Emits a sparse v2 matte spec —
 * the server resolves colours and shadow params from the shared catalogue.
 */
export default function MattePanel({ matte, onChange }) {
  const chipMatch = BORDER_CHIPS.some((chip) => chip.px === matte.borderWidth);
  const [advancedOpen, setAdvancedOpen] = useState(!chipMatch);

  const set = (patch) => onChange({ ...matte, ...patch });

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-neutral-300 mb-2">Matte</h2>
        <div className="grid grid-cols-4 gap-2">
          {Object.entries(MATTE_SWATCHES).map(([key, swatch]) => {
            const selected = key === matte.swatch;
            return (
              <button
                key={key}
                type="button"
                title={swatch.label}
                onClick={() => set({ swatch: key })}
                className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2 transition-colors cursor-pointer ${
                  selected
                    ? 'border-sky-400 bg-sky-400/10'
                    : 'border-neutral-700 hover:border-neutral-500'
                }`}
              >
                <span
                  className="h-6 w-6 rounded-full border border-neutral-600"
                  style={{
                    backgroundColor: swatch.matteColor,
                    boxShadow: `inset 0 0 0 2px ${swatch.bevelColor}`,
                  }}
                />
                <span className="text-[10px] leading-tight text-center text-neutral-300">
                  {swatch.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium text-neutral-300 mb-2">Depth treatment</h2>
        <div className="flex flex-wrap gap-2">
          {DEPTH_STYLE_OPTIONS.map(({ key, label }) => (
            <Chip key={key} selected={matte.depthStyle === key} onClick={() => set({ depthStyle: key })}>
              {label}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium text-neutral-300 mb-2">Paper texture</h2>
        <div className="flex flex-wrap gap-2">
          {TEXTURE_OPTIONS.map(({ key, label }) => (
            <Chip key={key} selected={matte.texture === key} onClick={() => set({ texture: key })}>
              {label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Toggle
          id="matte-drop-shadow"
          label="Drop shadow"
          hint="print casts onto the matte"
          checked={matte.dropShadow}
          onChange={(dropShadow) => set({ dropShadow })}
        />
        <Toggle
          id="matte-depth"
          label="Shadowbox depth"
          hint="bevel + recess shading"
          checked={matte.depth}
          onChange={(depth) => set({ depth })}
        />
      </div>

      <div>
        <h2 className="text-sm font-medium text-neutral-300 mb-2">
          Border{' '}
          <span className="text-neutral-500 font-normal tabular-nums">
            {matte.borderWidth}px
          </span>
        </h2>
        <div className="flex flex-wrap gap-2">
          {BORDER_CHIPS.map(({ label, px }) => (
            <Chip key={label} selected={matte.borderWidth === px} onClick={() => set({ borderWidth: px })}>
              {label}
            </Chip>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          className="mt-2 text-xs text-neutral-500 hover:text-neutral-300 cursor-pointer"
        >
          {advancedOpen ? '▾ Advanced' : '▸ Advanced'}
        </button>
        {advancedOpen && (
          <input
            id="border-width"
            type="range"
            aria-label="Border width"
            min={BORDER_WIDTH.min}
            max={BORDER_WIDTH.max}
            step={10}
            value={matte.borderWidth}
            onChange={(e) => set({ borderWidth: Number(e.target.value) })}
            className="mt-1 w-full accent-sky-400"
          />
        )}
      </div>
    </section>
  );
}
