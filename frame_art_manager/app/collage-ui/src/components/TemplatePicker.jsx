import { CANVAS, TEMPLATES, computeLayout } from '../geometry.js';

const THUMB_W = 96;

/** Miniature of one template's real window layout, drawn from computeLayout. */
function TemplateThumb({ templateKey, borderWidth }) {
  const scale = THUMB_W / CANVAS.width;
  const height = Math.round(CANVAS.height * scale);
  const windows = computeLayout(templateKey, borderWidth, scale);
  return (
    <svg
      width={THUMB_W}
      height={height}
      viewBox={`0 0 ${THUMB_W} ${height}`}
      className="rounded-sm"
      aria-hidden="true"
    >
      <rect x="0" y="0" width={THUMB_W} height={height} className="fill-neutral-700" />
      {windows.map((win, i) => (
        <rect
          key={i}
          x={win.left}
          y={win.top}
          width={win.width}
          height={win.height}
          className="fill-neutral-400"
        />
      ))}
    </svg>
  );
}

/**
 * The four layouts as visual thumbnails. Templates needing more photos than
 * are available stay visible but disabled.
 */
export default function TemplatePicker({ value, poolSize, borderWidth, onChange }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-neutral-300 mb-2">Layout</h2>
      <div className="flex flex-wrap gap-3">
        {Object.entries(TEMPLATES).map(([key, template]) => {
          const disabled = template.slotCount > poolSize;
          const selected = key === value;
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onChange(key)}
              title={
                disabled
                  ? `Needs ${template.slotCount} photos — only ${poolSize} available`
                  : template.label
              }
              className={`flex flex-col items-center gap-1.5 rounded-lg border p-2 transition-colors ${
                selected
                  ? 'border-sky-400 bg-sky-400/10'
                  : 'border-neutral-700 hover:border-neutral-500'
              } ${disabled ? 'opacity-35 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <TemplateThumb templateKey={key} borderWidth={borderWidth} />
              <span className="text-xs text-neutral-300">{template.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
