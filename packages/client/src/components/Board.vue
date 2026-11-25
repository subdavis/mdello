<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useBoard } from '../composables/useBoard';
import { useDrag } from '../composables/useDrag';
import { pruneTriageSeen } from '../composables/useTriageSeen';
import { markdownFile, useMarkdownImport } from '../composables/useMarkdownImport';
import { ARCHIVE_DIR, type Card, triageSources } from '../fs/board';
import CardModal from './CardModal.vue';
import CardTile from './Card.vue';
import Column from './Column.vue';
import Overlay from './Overlay.vue';
import SearchSidebar from './SearchSidebar.vue';

const props = defineProps<{ searchOpen: boolean; searchFocusRequest: number }>();
const emit = defineEmits<{ closeSearch: [] }>();

const board = useBoard();
const drag = useDrag();
const markdownImport = useMarkdownImport();
const openCard = ref<Card | null>(null);
const mergePair = ref<{ source: Card; destination: Card } | null>(null);
let mergeTimer: ReturnType<typeof setTimeout> | undefined;
let lastMergeHover = 0;

function clearMergeHover(): void {
  clearTimeout(mergeTimer);
  mergeTimer = undefined;
  drag.mergeTarget.value = null;
}

onUnmounted(clearMergeHover);

function onMergeHover(destination: Card | null): void {
  lastMergeHover = Date.now();
  if (drag.mergeTarget.value === destination?.id) return;
  clearMergeHover();
  const source = drag.dragging.value && findCard(drag.dragging.value.id);
  if (!source || !destination) return;
  drag.mergeTarget.value = destination.id;
  mergeTimer = setTimeout(() => {
    // Dragover repeats while the pointer rests; silence means it left without a dragleave we see.
    if (Date.now() - lastMergeHover > 500) return clearMergeHover();
    mergePair.value = { source, destination };
    drag.end();
    mergeTimer = undefined;
  }, 3000); // 1s hold + 2s charge, matching merge-charge in Card.css
}

const archiveDropzone = ref<HTMLElement | null>(null);
const archiveWarping = ref(false);
const archiveOver = computed(() => drag.target.value?.column === ARCHIVE_DIR);
const archiveBlocked = computed(() => {
  const card = drag.dragging.value && findCard(drag.dragging.value.id);
  return !!card && triageSources(card).length > 0;
});
const allCards = computed(() => board.columns.value.flatMap((column) => column.cards));
watch(() => allCards.value.map(({ id, column }) => ({ id, column })), pruneTriageSeen, {
  immediate: true,
});
const searchMounted = ref(false);
watch(
  () => props.searchOpen,
  (open) => {
    if (!open) return;
    searchMounted.value = true;
    void board.flushPending();
  },
  { immediate: true },
);
const isEmpty = computed(
  () => board.configReady.value && !board.loading.value && board.columns.value.length === 0,
);

function findCard(id: string): Card | undefined {
  return allCards.value.find((card) => card.id === id);
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
  // Inline style beats Card.vue's scoped `.card` rule, which otherwise keeps this relative.
  clone.style.position = 'fixed';
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
  clearMergeHover();
  const movedColumn = drag.column.value;
  const file = markdownFile(event.dataTransfer);
  const archiveCard = source && target?.column === ARCHIVE_DIR ? findCard(source.id) : undefined;
  const warp = archiveCard ? playArchiveWarp(archiveCard.id, event) : null;
  if (warp) archiveWarping.value = true;
  drag.end();
  markdownImport.end();

  if (await importMarkdown(file, target)) return;
  if (movedColumn !== null) return board.commitColumnOrder(movedColumn);
  if (!source || !target) return;

  const card = findCard(source.id);
  if (!card) return;
  if (target.column === ARCHIVE_DIR) return dropIntoArchive(card, warp);

  const column = board.columns.value.find((entry) => entry.name === target.column);
  if (column) await board.placeCard(card, column, target.index);
}

/** Fires after drop too, but by then the commit already cleared the preview snapshot. */
function onDragend(): void {
  clearMergeHover();
  drag.end();
  board.cancelColumnOrder();
}

function onArchiveDragover(event: DragEvent): void {
  clearMergeHover();
  // Not calling preventDefault refuses the drop.
  if (markdownImport.draggingMarkdown.value || archiveBlocked.value) {
    drag.clearTarget();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
  } else drag.over(event, ARCHIVE_DIR, 0);
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

  <div v-else class="board-shell">
    <!-- Mounted on first open; v-show inside keeps query, toggles, and results across closes. -->
    <SearchSidebar
      v-if="searchMounted"
      :cards="allCards"
      :open="searchOpen"
      :focus-request="searchFocusRequest"
      @close="emit('closeSearch')"
      @select="openCard = $event"
    />
    <!-- .self: gaps and padding only. Dragovers bubbling up from a column or archive
         have already set a target and must not be cleared here. -->
    <div
      class="board"
      @dragover.self="clearMergeHover(); drag.clearTarget()"
      @dragleave.self="clearMergeHover(); drag.clearTarget()"
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
        @merge-hover="onMergeHover"
      />
  
      <section class="column archive-column">
        <div
          ref="archiveDropzone"
          class="archive-dropzone"
          :class="{ 'is-over': archiveOver, 'is-warping': archiveWarping }"
          @dragover="onArchiveDragover"
        >
          <span class="archive-vortex" aria-hidden="true" />
          <span v-if="archiveBlocked" class="archive-label">
            🚫 Archive Blocked<small>Clear triage first</small>
          </span>
          <span v-else class="archive-label">Archive</span>
        </div>
      </section>
  
      <CardModal v-if="openCard" :card="openCard" @close="openCard = null" />
      <Overlay
        v-if="mergePair"
        panel-class="merge-confirm"
        label="Merge cards"
        place="center"
        @close="mergePair = null"
        @escape="mergePair = null"
      >
        <h2>Merge cards?</h2>
        <div class="merge-confirm-cards" role="group" aria-label="Source card merges into destination card">
          <CardTile :card="mergePair.source" preview />
          <span aria-hidden="true">→</span>
          <CardTile :card="mergePair.destination" preview />
        </div>
        <div class="merge-confirm-actions">
          <button type="button" @click="board.mergeCard(mergePair.source, mergePair.destination); mergePair = null">Merge</button>
          <button type="button" class="primary" @click="mergePair = null">Cancel</button>
        </div>
      </Overlay>
    </div>
  </div>
</template>

<style src="../styles/Board.css"></style>
