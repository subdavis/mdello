<script setup lang="ts">
import { computed, ref } from 'vue';
import { useBoard } from '../composables/useBoard';
import { useDrag } from '../composables/useDrag';
import { markdownFile, useMarkdownImport } from '../composables/useMarkdownImport';
import { ARCHIVE_DIR, type Card } from '../fs/board';
import CardModal from './CardModal.vue';
import Column from './Column.vue';
import '../styles/archive.css';

const board = useBoard();
const drag = useDrag();
const markdownImport = useMarkdownImport();
const openCard = ref<Card | null>(null);
const archiveDropzone = ref<HTMLElement | null>(null);
const archiveWarping = ref(false);
const archiveOver = computed(() => drag.target.value?.column === ARCHIVE_DIR);
const isEmpty = computed(
  () => board.configReady.value && !board.loading.value && board.columns.value.length === 0,
);

function findCard(id: string): Card | undefined {
  return board.columns.value.flatMap((column) => column.cards).find((card) => card.id === id);
}

function playArchiveWarp(
  cardId: string,
  event: DragEvent,
): { finished: Promise<void>; source: HTMLElement } | null {
  const cardElement = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(cardId)}"]`);
  const dropzone = archiveDropzone.value;
  if (!cardElement || !dropzone) return null;

  const cardRect = cardElement.getBoundingClientRect();
  const dropRect = dropzone.getBoundingClientRect();
  const clone = cardElement.cloneNode(true) as HTMLElement;
  const left = event.clientX ? event.clientX - drag.grabOffset.value.x : cardRect.left;
  const top = event.clientY ? event.clientY - drag.grabOffset.value.y : cardRect.top;
  const deltaX = dropRect.left + dropRect.width / 2 - (left + cardRect.width / 2);
  const deltaY = dropRect.top + dropRect.height / 2 - (top + cardRect.height / 2);

  clone.classList.remove('is-dragging');
  clone.classList.add('archive-warp-clone');
  delete clone.dataset.cardId;
  clone.setAttribute('aria-hidden', 'true');
  clone.style.setProperty('--archive-dx', `${deltaX}px`);
  clone.style.setProperty('--archive-dy', `${deltaY}px`);
  clone.style.left = `${left}px`;
  clone.style.top = `${top}px`;
  clone.style.width = `${cardRect.width}px`;
  clone.style.height = `${cardRect.height}px`;
  document.body.append(clone);
  cardElement.style.visibility = 'hidden';

  const finished = new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clone.remove();
      resolve();
    };

    clone.addEventListener('animationend', finish, { once: true });
    window.setTimeout(finish, 200);
  });

  return { finished, source: cardElement };
}

type DropTarget = NonNullable<typeof drag.target.value>;
type ArchiveWarp = NonNullable<ReturnType<typeof playArchiveWarp>>;

async function importMarkdown(file: File | undefined, target: DropTarget | null): Promise<boolean> {
  if (!file || !target || target.column === ARCHIVE_DIR) return false;
  const column = board.columns.value.find((entry) => entry.name === target.column);
  if (!column) return true;

  const card = await board.importCard(column, file, target.index);
  if (card) openCard.value = card;
  return true;
}

async function dropIntoArchive(card: Card, warp: ArchiveWarp | null): Promise<void> {
  try {
    await Promise.all([board.archive(card), warp?.finished]);
  } finally {
    if (warp) warp.source.style.visibility = '';
    archiveWarping.value = false;
  }
}

// Drops bubble up from columns and archive, so one handler covers whole board.
async function onDrop(event: DragEvent): Promise<void> {
  const source = drag.dragging.value;
  const target = drag.target.value;
  const movedColumn = drag.column.value;
  const file = markdownFile(event.dataTransfer);
  const archiveCard = source && target?.column === ARCHIVE_DIR ? findCard(source.id) : undefined;
  const warp = archiveCard ? playArchiveWarp(archiveCard.id, event) : null;
  if (warp) archiveWarping.value = true;
  drag.end();
  markdownImport.end();

  if (await importMarkdown(file, target)) return;
  if (movedColumn) return board.commitColumnOrder();
  if (!source || !target) return;

  const card = findCard(source.id);
  if (!card) return;
  if (target.column === ARCHIVE_DIR) return dropIntoArchive(card, warp);

  const column = board.columns.value.find((entry) => entry.name === target.column);
  if (column) await board.placeCard(card, column, target.index);
}

/** Fires after drop too, but by then the commit already cleared the preview snapshot. */
function onDragend(): void {
  drag.end();
  board.cancelColumnOrder();
}

function onArchiveDragover(event: DragEvent): void {
  if (markdownImport.draggingMarkdown.value) drag.clearTarget();
  else drag.over(event, ARCHIVE_DIR, 0);
}
</script>

<template>
  <div v-if="!board.configReady.value" class="init-gate">
    <p>Loading board…</p>
  </div>

  <div v-else-if="isEmpty" class="init-gate">
    <h1>{{ board.boardName.value }} is empty</h1>
    <button type="button" class="primary init-button" @click="board.initialize()">
      Initialize folder
    </button>
  </div>

  <!-- .self: gaps and padding only. Dragovers bubbling up from a column or archive
       have already set a target and must not be cleared here. -->
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
      :key="column.name"
      :column="column"
      :index="index"
      @open="openCard = $event"
      @add="(target, title) => board.addCard(target, title)"
      @rename="(target, label) => board.renameColumn(target, label)"
      @archive="(target) => board.archiveColumn(target)"
      @hover="(dir, index) => board.previewColumnOrder(dir, index)"
    />

    <section class="column archive-column">
      <div
        ref="archiveDropzone"
        class="archive-dropzone"
        :class="{ 'is-over': archiveOver, 'is-warping': archiveWarping }"
        @dragover="onArchiveDragover"
      >
        <span class="archive-vortex" aria-hidden="true" />
        <span class="archive-label">Archive</span>
      </div>
    </section>

    <CardModal v-if="openCard" :card="openCard" @close="openCard = null" />
  </div>
</template>
