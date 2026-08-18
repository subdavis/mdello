import { ref } from 'vue';
import type { Card } from '../fs/board';

const dragging = ref<{ id: string; column: string } | null>(null);
// Driven only by dragover, so it never flickers the way dragenter/dragleave pairs do.
const target = ref<{ column: string; index: number } | null>(null);
// Height of the card being held, so the open slot matches it exactly.
const slotHeight = ref(30);

// Column drags are a separate track: `dragging` stays null, so card handlers ignore them.
const column = ref<string | null>(null);

/**
 * Chrome drops a transform set on the dragged element itself, so the tilt has to live on a
 * child of the element handed to setDragImage. Offscreen wrapper, padded so the rotated
 * corners are not clipped.
 */
function tiltedImage(el: HTMLElement, width: number, height: number): HTMLElement {
  const pad = 12;
  const wrapper = document.createElement('div');
  wrapper.style.cssText = `position:fixed;left:-9999px;top:0;padding:${pad}px;width:${width + pad * 2}px;height:${height + pad * 2}px;pointer-events:none;`;

  const clone = el.cloneNode(true) as HTMLElement;
  clone.classList.remove('is-dragging');
  clone.style.cssText = `width:${width}px;height:${height}px;transform:rotate(3deg);box-shadow:0 6px 12px rgb(9 30 66 / 0.25);`;

  wrapper.append(clone);
  document.body.append(wrapper);
  return wrapper;
}

export function useDrag() {
  return {
    dragging,
    target,
    slotHeight,
    column,

    /** The header is the handle, but `el` (the whole column) is what the ghost shows. */
    startColumn(event: DragEvent, dir: string, el: HTMLElement | null): void {
      column.value = dir;
      if (!event.dataTransfer) return;

      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dir);

      if (!el) return;
      const rect = el.getBoundingClientRect();
      const image = tiltedImage(el, rect.width, rect.height);
      event.dataTransfer.setDragImage(
        image,
        event.clientX - rect.left + 12,
        event.clientY - rect.top + 12,
      );
      setTimeout(() => image.remove());
    },

    /** Claims the drop so the cursor stays "move"; reordering itself is a live preview. */
    overColumn(event: DragEvent): void {
      if (!column.value) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    },

    start(event: DragEvent, card: Card): void {
      dragging.value = { id: card.id, column: card.column };
      const el = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
      const rect = el?.getBoundingClientRect();
      if (rect) slotHeight.value = rect.height;

      // The payload is for external drop targets; internal drops read `dragging` instead.
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.id);

        if (el && rect) {
          const image = tiltedImage(el, rect.width, rect.height);
          // Keep the grab point under the cursor, offset by the wrapper's padding.
          event.dataTransfer.setDragImage(
            image,
            event.clientX - rect.left + 12,
            event.clientY - rect.top + 12,
          );
          // The snapshot is taken synchronously after this handler; then it can go.
          setTimeout(() => image.remove());
        }
      }
    },

    over(event: DragEvent, column: string, index: number): void {
      if (!dragging.value) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      target.value = { column, index };
    },

    /** Pointer moved onto neutral board background: no drop slot until it re-enters one. */
    clearTarget(): void {
      target.value = null;
    },

    end(): void {
      dragging.value = null;
      target.value = null;
      column.value = null;
    },
  };
}
