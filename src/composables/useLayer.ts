import { onBeforeUnmount, watch, type Ref } from 'vue';

/**
 * Dismissible layers — overlays and the popovers inside them — in the order they opened.
 * Escape belongs to whatever opened last, so only the top of this stack hears it. Without
 * the stack every layer listens on `window` and one keypress closes all of them, which is
 * why nested layers used to need capture-phase `stopPropagation` to defend themselves.
 */
const stack: Layer[] = [];

interface Layer {
  escape: () => void;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;

  const top = stack[stack.length - 1];
  if (!top) return;

  // Nothing below this layer should also react, including a native dialog or the browser's
  // own Escape handling on a focused input.
  event.preventDefault();
  event.stopPropagation();
  top.escape();
}

function push(layer: Layer): void {
  // The listener exists only while something can be dismissed.
  if (stack.length === 0) window.addEventListener('keydown', onKeydown, true);
  stack.push(layer);
}

function pop(layer: Layer): void {
  const index = stack.lastIndexOf(layer);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length === 0) window.removeEventListener('keydown', onKeydown, true);
}

/**
 * Registers `escape` as the top layer for this component's lifetime. Pass `active` for a
 * layer that opens and closes without unmounting, such as a popover inside a modal: it
 * joins the stack above the modal each time it opens, so it gets Escape first.
 */
export function useLayer(escape: () => void, active?: Ref<boolean>): void {
  // Identity matters more than the callback: `pop` finds this layer by reference, so a
  // component that opens and closes repeatedly keeps reusing the same entry.
  const layer: Layer = { escape };

  if (!active) {
    push(layer);
    onBeforeUnmount(() => pop(layer));
    return;
  }

  watch(
    active,
    (open) => {
      if (open) push(layer);
      else pop(layer);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => pop(layer));
}
