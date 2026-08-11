import { useState } from 'react';
import { thumbUrl } from '../api.js';

/**
 * The recipe's slots in window order. Photos are reorderable between slots:
 * drag one card onto another (or use the arrow buttons) to swap them. The
 * focal point travels with its photo — it marks the subject, not the window.
 */
export default function SlotStrip({ slots, onSwap }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  const endDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <section>
      <h2 className="text-sm font-medium text-neutral-300 mb-2">
        Photos <span className="text-neutral-500 font-normal">(drag to swap slots)</span>
      </h2>
      <ol className="flex flex-wrap gap-3">
        {slots.map((slot, i) => (
          <li
            key={`${slot.imageId}-${i}`}
            draggable
            onDragStart={(e) => {
              setDragIndex(i);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIndex(i);
            }}
            onDragLeave={() => setOverIndex((cur) => (cur === i ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null && dragIndex !== i) onSwap(dragIndex, i);
              endDrag();
            }}
            onDragEnd={endDrag}
            className={`w-28 rounded-lg border p-1.5 cursor-grab active:cursor-grabbing transition-colors ${
              overIndex === i && dragIndex !== null && dragIndex !== i
                ? 'border-sky-400 bg-sky-400/10'
                : 'border-neutral-700'
            } ${dragIndex === i ? 'opacity-50' : ''}`}
          >
            <div className="relative">
              <img
                src={thumbUrl(slot.imageId)}
                alt={slot.imageId}
                className="w-full aspect-[3/4] rounded object-cover pointer-events-none"
              />
              <span className="absolute top-1 left-1 rounded bg-neutral-950/80 px-1.5 text-xs text-neutral-200">
                {i + 1}
              </span>
            </div>
            <p className="mt-1 truncate text-[11px] text-neutral-400" title={slot.imageId}>
              {slot.imageId}
            </p>
            <div className="mt-1 flex justify-between">
              <button
                type="button"
                onClick={() => onSwap(i, i - 1)}
                disabled={i === 0}
                className="px-1.5 text-xs text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
                aria-label={`Move ${slot.imageId} to slot ${i}`}
              >
                ←
              </button>
              <button
                type="button"
                onClick={() => onSwap(i, i + 1)}
                disabled={i === slots.length - 1}
                className="px-1.5 text-xs text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
                aria-label={`Move ${slot.imageId} to slot ${i + 2}`}
              >
                →
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
