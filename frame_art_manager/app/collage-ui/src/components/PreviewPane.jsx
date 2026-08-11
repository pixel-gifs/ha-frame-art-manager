import { useEffect, useRef, useState } from 'react';
import { CANVAS, clamp, computeCoverCrop, computeLayout } from '../geometry.js';

/**
 * Server-rendered live preview (WYSIWYG — the JPG from /api/collage/preview,
 * never a CSS approximation) with an invisible drag surface over each matte
 * window: pointer-dragging pans that photo's focal point.
 *
 * Drag math: a horizontal drag of dx CSS pixels is dx/dispScale pixels on the
 * 4K reference canvas; the photo covers its window scaled to scaledW×scaledH
 * reference pixels, and focal.x is a fraction of scaledW — so the focal delta
 * is exactly (dx/dispScale)/scaledW. Dragging right reveals more of the
 * photo's left side (focal decreases), matching direct-manipulation feel.
 */
export default function PreviewPane({ recipe, library, previewUrl, loading, error, onFocalChange }) {
  const containerRef = useRef(null);
  const [displayWidth, setDisplayWidth] = useState(0);
  const dragRef = useRef(null);
  const [draggingSlot, setDraggingSlot] = useState(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      setDisplayWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const windows = computeLayout(recipe.template, recipe.matte.borderWidth, 1);
  const dispScale = displayWidth > 0 ? displayWidth / CANVAS.width : 0;

  const startDrag = (e, slotIndex) => {
    const slot = recipe.slots[slotIndex];
    const win = windows[slotIndex];
    const dims = library?.[slot.imageId]?.dimensions;
    // Without stored dimensions, assume the photo covers twice its window —
    // the drag still pans, just with approximate sensitivity.
    const { scaledW, scaledH } = dims?.width > 0 && dims?.height > 0
      ? computeCoverCrop(dims.width, dims.height, win.width, win.height, slot.focal)
      : { scaledW: win.width * 2, scaledH: win.height * 2 };

    // The server clamps the crop to stay inside the photo, so focal values
    // past the pan limits change nothing visually. Clamp writes to the
    // achievable range [winHalf, 1 - winHalf] — the drag stops exactly when
    // the photo edge is reached instead of accumulating invisible overshoot
    // that would have to unwind before a reversed drag takes effect again.
    const fxHalf = Math.min(0.5, win.width / (2 * scaledW));
    const fyHalf = Math.min(0.5, win.height / (2 * scaledH));

    dragRef.current = {
      slotIndex,
      startX: e.clientX,
      startY: e.clientY,
      focal0: { ...slot.focal },
      scaledW,
      scaledH,
      fxHalf,
      fyHalf,
    };
    setDraggingSlot(slotIndex);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveDrag = (e) => {
    const drag = dragRef.current;
    if (!drag || dispScale === 0) return;
    const dxRef = (e.clientX - drag.startX) / dispScale;
    const dyRef = (e.clientY - drag.startY) / dispScale;
    onFocalChange(drag.slotIndex, {
      x: clamp(drag.focal0.x - dxRef / drag.scaledW, drag.fxHalf, 1 - drag.fxHalf),
      y: clamp(drag.focal0.y - dyRef / drag.scaledH, drag.fyHalf, 1 - drag.fyHalf),
    });
  };

  const endDrag = () => {
    dragRef.current = null;
    setDraggingSlot(null);
  };

  return (
    <section>
      <h2 className="text-sm font-medium text-neutral-300 mb-2">
        Preview{' '}
        <span className="text-neutral-500 font-normal">(drag inside a window to reposition)</span>
      </h2>
      <div
        ref={containerRef}
        className="relative w-full aspect-video overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 select-none"
      >
        {previewUrl && (
          <img
            src={previewUrl}
            alt="Collage preview"
            draggable={false}
            className="absolute inset-0 h-full w-full"
          />
        )}

        {dispScale > 0 &&
          recipe.slots.map((slot, i) => {
            const win = windows[i];
            return (
              <div
                key={i}
                onPointerDown={(e) => startDrag(e, i)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                title={`${slot.imageId} — drag to reposition`}
                className={`absolute touch-none ${
                  draggingSlot === i
                    ? 'cursor-grabbing ring-2 ring-sky-400/80'
                    : 'cursor-grab hover:ring-2 hover:ring-sky-400/40'
                }`}
                style={{
                  left: win.left * dispScale,
                  top: win.top * dispScale,
                  width: win.width * dispScale,
                  height: win.height * dispScale,
                }}
              />
            );
          })}

        {loading && (
          <div className="absolute right-2 top-2 rounded bg-neutral-950/80 px-2 py-1 text-xs text-neutral-300">
            Rendering…
          </div>
        )}

        {!previewUrl && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
            {loading ? 'Rendering preview…' : 'Preview appears here'}
          </div>
        )}

        {error && (
          <div className="absolute inset-x-0 bottom-0 bg-red-950/90 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
      </div>
    </section>
  );
}
