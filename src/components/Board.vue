<script setup lang="ts">
import { computed, ref } from 'vue';
import { useBoard } from '../composables/useBoard';
import { useDrag } from '../composables/useDrag';
import { ARCHIVE_DIR, type Card } from '../fs/board';
import CardModal from './CardModal.vue';
import Column from './Column.vue';

const board = useBoard();
const drag = useDrag();
const openCard = ref<Card | null>(null);
const archiveOver = computed(() => drag.target.value?.column === ARCHIVE_DIR);
const isEmpty = computed(() => !board.loading.value && board.columns.value.length === 0);

function findCard(id: string): Card | undefined {
  return board.columns.value.flatMap((column) => column.cards).find((card) => card.id === id);
}

// Drops bubble up from columns and the archive strip, so one handler covers the whole board.
async function onDrop(): Promise<void> {
  const source = drag.dragging.value;
  const target = drag.target.value;
  const movedColumn = drag.column.value;
  drag.end();

  if (movedColumn) {
    await board.commitColumnOrder();
    return;
  }

  if (!source || !target) return;

  const card = findCard(source.id);
  if (!card) return;

  if (target.column === ARCHIVE_DIR) {
    await board.archive(card);
    return;
  }

  const column = board.columns.value.find((entry) => entry.dir === target.column);
  if (column) await board.placeCard(card, column, target.index);
}

/** Fires after drop too, but by then the commit already cleared the preview snapshot. */
function onDragend(): void {
  drag.end();
  board.cancelColumnOrder();
}
</script>

<template>
  <div v-if="isEmpty" class="init-gate">
    <h1>{{ board.boardName.value }} is empty</h1>
    <button type="button" class="primary init-button" @click="board.initialize()">
      Initialize folder
    </button>
  </div>

  <!-- .self: gaps and padding only. Dragovers bubbling up from a column or the archive
       strip have already set a target and must not be cleared here. -->
  <div
    v-else
    class="board"
    @dragover.self="drag.clearTarget()"
    @dragleave.self="drag.clearTarget()"
    @drop.prevent="onDrop"
    @dragend="onDragend"
  >
    <Column
      v-for="(column, index) in board.columns.value"
      :key="column.dir"
      :column="column"
      :index="index"
      @open="openCard = $event"
      @add="(target, title) => board.addCard(target, title)"
      @rename="(target, label) => board.renameColumn(target, label)"
      @archive="(target) => board.archiveColumn(target)"
      @hover="(dir, index) => board.previewColumnOrder(dir, index)"
    />

    <aside
      class="archive-strip"
      :class="{ 'is-over': archiveOver }"
      @dragover="drag.over($event, ARCHIVE_DIR, 0)"
    >
      <span class="archive-label">🗑️ Archive</span>
    </aside>

    <CardModal v-if="openCard" :card="openCard" @close="openCard = null" />
  </div>
</template>
