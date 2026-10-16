<script setup lang="ts">
import { computed, ref } from 'vue';
import { useBoard } from '../composables/useBoard';
import type { Card } from '../types/board';
import CardDetails from './CardDetails.vue';
import Overlay from './Overlay.vue';

/**
 * The dialog around a card: scrim, dismissal, escape and the drag-to-resize width. The card
 * itself is `CardDetails.vue`, which knows nothing about any of that so it can also be
 * embedded in an ordinary page.
 */
const props = defineProps<{ card: Card }>();
const emit = defineEmits<{ close: [] }>();

const MODAL_WIDTH_KEY = 'mdello.cardModalWidth';
const DEFAULT_MODAL_WIDTH = 680;
const MIN_MODAL_WIDTH = 360;

function storedModalWidth(): number {
  const stored = Number(localStorage.getItem(MODAL_WIDTH_KEY));
  return Number.isFinite(stored) && stored >= MIN_MODAL_WIDTH ? stored : DEFAULT_MODAL_WIDTH;
}

const board = useBoard();
const details = ref<InstanceType<typeof CardDetails> | null>(null);
const modalWidth = ref(storedModalWidth());
const modalStyle = computed(() => ({ width: `${modalWidth.value}px` }));

async function close(): Promise<void> {
  await board.flushCard(props.card);
  emit('close');
}

function startResizing(event: PointerEvent, side: 'left' | 'right'): void {
  if (event.button !== 0) return;

  const handle = event.currentTarget as HTMLElement;
  const panel = handle.closest<HTMLElement>('.modal');
  if (!panel) return;

  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startWidth = panel.getBoundingClientRect().width;
  const direction = side === 'right' ? 1 : -1;

  const onPointerMove = (moveEvent: PointerEvent): void => {
    const requestedWidth = startWidth + (moveEvent.clientX - startX) * direction * 2;
    const viewportWidth = Math.max(MIN_MODAL_WIDTH, window.innerWidth - 24);
    modalWidth.value = Math.round(
      Math.min(viewportWidth, Math.max(MIN_MODAL_WIDTH, requestedWidth)),
    );
  };

  const finish = (): void => {
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
    localStorage.setItem(MODAL_WIDTH_KEY, String(modalWidth.value));
  };

  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

/** Escape leaves the editor first, so it takes two presses to close a modal mid-edit. */
function onEscape(): void {
  if (details.value?.editing) void details.value.save();
  else void close();
}
</script>

<template>
  <Overlay :panel-style="modalStyle" panel-class="modal" label="Card" @close="close" @escape="onEscape">
    <div class="modal-resize-handle modal-resize-handle-left" @pointerdown="startResizing($event, 'left')" />
    <div class="modal-resize-handle modal-resize-handle-right" @pointerdown="startResizing($event, 'right')" />
    <CardDetails ref="details" :card="card" @close="close" />
  </Overlay>
</template>
