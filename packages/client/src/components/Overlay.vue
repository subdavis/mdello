<script setup lang="ts">
/**
 * Shared scrim for full-window layers. Teleporting keeps layers out of ancestor overflow and
 * stacking contexts.
 */
import { ref } from 'vue';
import { useLayer } from '../composables/useLayer';

const props = withDefaults(
  defineProps<{
    /** Where the panel sits: `drop` hugs the top edge, `top` leaves room to breathe. */
    place?: 'drop' | 'top' | 'center';
    /** Sizing and padding for this particular panel; the chrome comes from `.panel`. */
    panelClass?: string;
    panelStyle?: Record<string, string>;
    label?: string;
  }>(),
  { place: 'top' },
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
  if (dismiss) emit('close');
}

useLayer(() => emit('escape'));
</script>

<template>
  <Teleport to="body">
    <div
      class="scrim"
      :class="`scrim-${place}`"
      @mousedown="onMousedown"
      @mouseup="onMouseup"
    >
      <div
        class="panel"
        :class="panelClass"
        :style="panelStyle"
        role="dialog"
        aria-modal="true"
        :aria-label="label"
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>
