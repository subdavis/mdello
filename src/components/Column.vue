<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
import { useDrag } from '../composables/useDrag';
import type { Card as CardType, Column } from '../fs/board';
import CardTile from './Card.vue';

const props = defineProps<{ column: Column; index: number }>();
const emit = defineEmits<{
  open: [CardType];
  add: [Column, string];
  rename: [Column, string];
  archive: [Column];
  hover: [string, number];
}>();

const drag = useDrag();
const body = useTemplateRef<HTMLElement>('body');
const root = useTemplateRef<HTMLElement>('root');
const adding = ref(false);
const draftTitle = ref('');
const draftInput = ref<HTMLInputElement | null>(null);
const renaming = ref(false);
const draftLabel = ref('');
const labelInput = ref<HTMLInputElement | null>(null);
const menuOpen = ref(false);
const head = useTemplateRef<HTMLElement>('head');

function onPointerDown(event: PointerEvent): void {
  if (!menuOpen.value || head.value?.contains(event.target as Node)) return;
  menuOpen.value = false;
}

onMounted(() => document.addEventListener('pointerdown', onPointerDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown));

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
  // A column drag reorders the board live; cards are not involved.
  const held = drag.column.value;
  if (held) {
    drag.overColumn(event);
    if (held !== props.column.dir) emit('hover', held, props.index);
    return;
  }

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

async function startRenaming(): Promise<void> {
  menuOpen.value = false;
  renaming.value = true;
  draftLabel.value = props.column.label;
  await nextTick();
  labelInput.value?.select();
}

function submitLabel(): void {
  const label = draftLabel.value;
  draftLabel.value = '';
  if (!renaming.value) return;
  renaming.value = false;
  if (label) emit('rename', props.column, label);
}

function archiveColumn(): void {
  menuOpen.value = false;
  const count = props.column.cards.length;
  const detail = count ? `Its ${count} card${count === 1 ? '' : 's'} move to the archive.` : '';
  // Cards survive in archive/, the folder does not: worth one confirmation.
  if (!confirm(`Archive "${props.column.label}"? ${detail}`)) return;

  emit('archive', props.column);
}
</script>

<template>
  <section
    ref="root"
    class="column"
    :class="{ 'is-dragging': drag.column.value === column.dir }"
    @dragover="onDragover"
  >
    <header
      ref="head"
      class="column-head"
      :draggable="!renaming"
      @dragstart="drag.startColumn($event, column.dir, root)"
    >
      <form v-if="renaming" class="rename-form" @submit.prevent="submitLabel">
        <input
          ref="labelInput"
          v-model="draftLabel"
          aria-label="Column name"
          @blur="submitLabel"
          @keydown.esc="
            renaming = false;
            draftLabel = '';
          "
        />
      </form>
      <template v-else>
        <h2 title="Double-click to rename, drag to reorder" @dblclick="startRenaming">
          {{ column.label }}
        </h2>
        <span class="count">{{ column.cards.length }}</span>
        <button
          type="button"
          class="kebab"
          :aria-expanded="menuOpen"
          title="Column actions"
          @click="menuOpen = !menuOpen"
        >
          ⋮
        </button>
        <div v-if="menuOpen" class="column-menu">
          <button type="button" @click="startRenaming">Rename</button>
          <button type="button" @click="archiveColumn">Archive</button>
        </div>
      </template>
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
