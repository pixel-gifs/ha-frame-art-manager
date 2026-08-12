import { useState } from 'react';
import {
  BORDER_CHIPS,
  BORDER_WIDTH,
  MATTE_SWATCHES,
  SHADOW_PARAM_BOUNDS,
  effectiveShadowParams,
} from '../geometry.js';

// Fine-tune sliders: [group, key, label, min, max, step] — slider ranges are
// the useful subranges of SHADOW_PARAM_BOUNDS. Shade sliders run -1..1:
// negative = darker than the bevel colour, positive = brighter.
const TUNING_SLIDERS = [
  ['Bevel', 'bevelWidth', 'Width (px)', 0, 40, 1],
  ['Bevel', 'bevelFeather', 'Feather (px)', 0, 12, 0.25],
  ['Bevel faces', 'faceTop', 'Top shade', -1, 1, 0.01],
  ['Bevel faces', 'faceRight', 'Right shade', -1, 1, 0.01],
  ['Bevel faces', 'faceBottom', 'Bottom shade', -1, 1, 0.01],
  ['Bevel faces', 'faceLeft', 'Left shade', -1, 1, 0.01],
  ['Edge rims', 'rimWidth', 'Width (px)', 0, 8, 0.2],
  ['Edge rims', 'rimOpacity', 'Opacity', 0, 1, 0.05],
  ['Edge rims', 'rimFeather', 'Feather (px)', 0, 6, 0.25],
  ['Edge rims', 'rimTop', 'Top shade', -1, 1, 0.01],
  ['Edge rims', 'rimRight', 'Right shade', -1, 1, 0.01],
  ['Edge rims', 'rimBottom', 'Bottom shade', -1, 1, 0.01],
  ['Edge rims', 'rimLeft', 'Left shade', -1, 1, 0.01],
  ['Shadow fall', 'shadowAngle', 'Direction (°)', 0, 360, 5],
  ['Shadow fall', 'shadowDistance', 'Distance (px)', 0, 40, 1],
  ['Umbra', 'umbraOpacity', 'Opacity', 0, 1, 0.02],
  ['Umbra', 'umbraBlur', 'Blur', 0, 60, 1],
  ['Umbra', 'umbraSpread', 'Spread (px)', 0, 40, 1],
  ['Penumbra', 'penumbraOpacity', 'Opacity', 0, 1, 0.02],
  ['Penumbra', 'penumbraBlur', 'Blur', 0, 160, 2],
  ['Penumbra', 'penumbraSpread', 'Spread (px)', 0, 60, 1],
];

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

/**
 * Sliders over every tunable look param. Writes overrides into
 * matte.shadowParams (the recipe stores them; the server resolves anything
 * untouched from the swatch), so the debounced preview is the live readout.
 */
function TuningPanel({ matte, onChange }) {
  const params = effectiveShadowParams(matte);
  const [copied, setCopied] = useState(false);

  const setParam = (key, value) => {
    onChange({ ...matte, shadowParams: { ...(matte.shadowParams || {}), [key]: value } });
  };

  const copyValues = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ swatch: matte.swatch, shadowParams: matte.shadowParams || {} }, null, 2)
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (http origin) — values stay visible in the UI
    }
  };

  let lastGroup = null;
  return (
    <div className="space-y-1 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      {TUNING_SLIDERS.map(([group, key, label, min, max, step]) => {
        const value = params[key];
        const heading = group !== lastGroup ? group : null;
        lastGroup = group;
        return (
          <div key={key}>
            {heading && (
              <p className="mt-2 mb-1 text-[10px] uppercase tracking-wider text-neutral-500 first:mt-0">
                {heading}
              </p>
            )}
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              <span className="w-32 shrink-0">{label}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => setParam(key, Number(e.target.value))}
                className="min-w-0 flex-1 accent-sky-400"
              />
              <span className="w-12 text-right tabular-nums text-neutral-300">
                {Number(value).toFixed(step >= 1 ? 0 : 2)}
              </span>
            </label>
          </div>
        );
      })}
      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={() => onChange({ ...matte, shadowParams: undefined })}
          className="rounded-lg border border-neutral-600 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-400 cursor-pointer"
        >
          Reset to swatch
        </button>
        <button
          type="button"
          onClick={copyValues}
          className="rounded-lg border border-neutral-600 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-400 cursor-pointer"
        >
          {copied ? 'Copied ✓' : 'Copy values'}
        </button>
      </div>
    </div>
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
  const [tuningOpen, setTuningOpen] = useState(false);

  const set = (patch) => onChange({ ...matte, ...patch });
  // A new swatch is a fresh hand-tuned package — stale tuning overrides
  // from the previous swatch must not carry across.
  const pickSwatch = (key) => onChange({ ...matte, swatch: key, shadowParams: undefined });

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
                onClick={() => pickSwatch(key)}
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
          id="matte-depth"
          label="Shadowbox depth"
          hint="bevel, lit edges + recess shading"
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

      <div>
        <button
          type="button"
          onClick={() => setTuningOpen((open) => !open)}
          className="text-sm font-medium text-neutral-300 hover:text-neutral-100 cursor-pointer"
        >
          {tuningOpen ? '▾' : '▸'} Fine-tune matte{' '}
          <span className="text-neutral-500 font-normal">
            (bevel, rims, shadows{matte.shadowParams ? ' · tuned' : ''})
          </span>
        </button>
        {tuningOpen && (
          <div className="mt-2">
            <TuningPanel matte={matte} onChange={onChange} />
          </div>
        )}
      </div>
    </section>
  );
}
