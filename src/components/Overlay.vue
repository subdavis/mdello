<script setup lang="ts">
/**
 * The scrim every full-window layer sits on: the card modal, the board switcher and the
 * busy indicator. Teleported to <body> so a layer is never trapped by an ancestor's
 * `overflow` or stacking context — the card modal used to render inside the horizontally
 * scrolling `.board`, below the column menus.
 */
import { ref } from 'vue';
import { useLayer } from '../composables/useLayer';

const props = withDefaults(
  defineProps<{
    /** Where the panel sits: `drop` hugs the top edge, `top` leaves room to breathe. */
    place?: 'drop' | 'top' | 'center';
    /** A layer that reports progress rather than asks a question cannot be dismissed. */
    blocking?: boolean;
    /** Sizing and padding for this particular panel; the chrome comes from `.panel`. */
    panelClass?: string;
    label?: string;
  }>(),
  { place: 'top', blocking: false },
);

const emit = defineEmits<{ close: []; escape: [] }>();

// A press that starts inside the panel and drifts onto the scrim is a sloppy drag, not a
// click-away, so both ends of the press have to land on the scrim itself.
const pressed = ref(false);

function onMousedown(event: MouseEvent): void {
  if (event.target === event.currentTarget) pressed.value = true;
}

function onMouseup(event: MouseEvent): void {
  const onScrim = event.target === event.currentTarget;
  const dismiss = pressed.value && onScrim;
  pressed.value = false;
  if (dismiss && !props.blocking) emit('close');
}

if (!props.blocking) useLayer(() => emit('escape'));
</script>

<template>
  <Teleport to="body">
    <div
      class="scrim"
      :class="[`scrim-${place}`, { 'is-blocking': blocking }]"
      @mousedown="onMousedown"
      @mouseup="onMouseup"
    >
      <div
        class="panel"
        :class="panelClass"
        :role="blocking ? 'status' : 'dialog'"
        :aria-modal="blocking ? undefined : 'true'"
        :aria-live="blocking ? 'polite' : undefined"
        :aria-label="label"
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>
