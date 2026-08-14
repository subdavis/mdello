<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue';
import { useDrag } from '../composables/useDrag';
import type { Card as CardType, Column } from '../fs/board';
import CardTile from './Card.vue';

const props = defineProps<{ column: Column }>();
const emit = defineEmits<{ open: [CardType]; add: [Column, string] }>();

const drag = useDrag();
const body = useTemplateRef<HTMLElement>('body');
const adding = ref(false);
const draftTitle = ref('');
const draftInput = ref<HTMLInputElement | null>(null);

const slot = computed(() =>
  drag.target.value?.column === props.column.dir ? drag.target.value.index : null,
);
const slotStyle = computed(() => ({ height: `${drag.slotHeight.value}px` }));

/** Insertion point = first card whose vertical midpoint is below the pointer. */
function slotAt(event: DragEvent): number {
  const tiles = body.value ? [...body.value.querySelectorAll<HTMLElement>('.card')] : [];

  for (const [index, tile] of tiles.entries()) {
    const rect = tile.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) return index;
  }

  return tiles.length;
}

/** Index of the held card when it came from this column, else -1. */
const sourceIndex = computed(() => {
  const held = drag.dragging.value;
  if (held?.column !== props.column.dir) return -1;
  return props.column.cards.findIndex((card) => card.id === held.id);
});

/**
 * Slots either side of the held card put it back where it started, so they are not offered:
 * no slot is drawn and the drop is a no-op.
 */
function onDragover(event: DragEvent): void {
  const index = slotAt(event);
  const from = sourceIndex.value;

  if (from !== -1 && (index === from || index === from + 1)) {
    // Still claim the drop so the cursor does not flip to "no drop".
    event.preventDefault();
    drag.clearTarget();
    return;
  }

  drag.over(event, props.column.dir, index);
}

async function startAdding(): Promise<void> {
  adding.value = true;
  draftTitle.value = '';
  await nextTick();
  draftInput.value?.focus();
}

// Enter submits and can be followed by blur, so the draft is cleared to keep it single-shot.
function submitDraft(): void {
  const title = draftTitle.value.trim();
  draftTitle.value = '';
  adding.value = false;
  if (title) emit('add', props.column, title);
}
</script>

<template>
  <section class="column" @dragover="onDragover">
    <header class="column-head">
      <h2>{{ column.label }}</h2>
      <span class="count">{{ column.cards.length }}</span>
    </header>

    <div ref="body" class="column-body">
      <template v-for="(card, index) in column.cards" :key="card.id">
        <div v-if="slot === index" class="slot" :style="slotStyle" />
        <CardTile :card="card" @open="emit('open', $event)" />
      </template>
      <div v-if="slot !== null && slot >= column.cards.length" class="slot" :style="slotStyle" />
      <p v-if="!column.cards.length && slot === null" class="empty">No cards</p>
    </div>

    <form v-if="adding" class="add-form" @submit.prevent="submitDraft">
      <input
        ref="draftInput"
        v-model="draftTitle"
        aria-label="New card title"
        placeholder="Card title"
        @blur="submitDraft"
        @keydown.esc="
          draftTitle = '';
          adding = false;
        "
      />
    </form>
    <button v-else type="button" class="add-button" @click="startAdding">+ Add card</button>
  </section>
</template>
