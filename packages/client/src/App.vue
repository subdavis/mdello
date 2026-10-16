<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue';
import Board from './components/Board.vue';
import BoardSwitcher from './components/BoardSwitcher.vue';
import CompanionStatus from './components/CompanionStatus.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import Toast from './components/Toast.vue';
import { useBoard } from './composables/useBoard';
import { useFilesystemBoards } from './composables/useFilesystemBoards';
import { isMarkdownFile, useMarkdownImport } from './composables/useMarkdownImport';
import { showToast } from './composables/useToast';

const board = useBoard();
const fs = useFilesystemBoards();
const markdownImport = useMarkdownImport();

const addingColumn = ref(false);
const draftColumn = ref('');
const columnInput = ref<HTMLInputElement | null>(null);
const switching = ref(false);
const settingsOpen = ref(false);

async function startAddingColumn(): Promise<void> {
  addingColumn.value = true;
  draftColumn.value = '';
  await nextTick();
  columnInput.value?.focus();
}

async function submitColumn(): Promise<void> {
  const label = draftColumn.value.trim();
  draftColumn.value = '';
  addingColumn.value = false;
  if (label) await board.addColumn(label);
}

// Wallpaper lives on <body> so it stays put while the board scrolls sideways.
watchEffect(() => {
  const url = board.background.value;
  // CSS.escape-free quoting: a URL containing " or a newline is not one we can use.
  const safe = url && !/["\n\\]/.test(url) ? `url("${url}")` : '';
  document.body.style.setProperty('--board-bg', safe || 'none');
});

// Fallback when FileSystemObserver is unavailable: re-scan when the window regains focus.
async function onFocus(): Promise<void> {
  // A locked board polls for the lock instead: the other tab may have closed.
  if (fs.locked.value) return fs.retry();
  if (board.watching.value) return;
  await board.reload();
}

/** Card drags carry no files, so this never competes with the board's own drag handling. */
function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

function onDragover(event: DragEvent): void {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  markdownImport.update(event.dataTransfer);
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onDragleave(event: DragEvent): void {
  if (event.relatedTarget === null) markdownImport.end();
}

/** An image dropped outside a column dropzone becomes the board wallpaper. */
async function onDrop(event: DragEvent): Promise<void> {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  markdownImport.end();

  const file = event.dataTransfer?.files[0];
  if (!file || isMarkdownFile(file)) return;
  if (!file.type.startsWith('image/')) {
    showToast('Not an image');
    return;
  }

  if (await board.setBackground(file)) showToast('Background updated');
}

/** The shortcut the panel imitates; on a board app, print is the lesser feature. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'p' || event.altKey || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  switching.value = !switching.value;
}

onMounted(async () => {
  await fs.init();
  window.addEventListener('focus', onFocus);
  window.addEventListener('dragover', onDragover);
  window.addEventListener('dragleave', onDragleave);
  window.addEventListener('drop', onDrop);
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('focus', onFocus);
  window.removeEventListener('dragover', onDragover);
  window.removeEventListener('dragleave', onDragleave);
  window.removeEventListener('drop', onDrop);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <header class="topbar">
    <strong class="brand">🍺</strong>
    <button
      v-if="fs.folderName.value"
      type="button"
      class="board-switch"
      title="Switch board (⌘P)"
      @click="switching = true"
    >
      {{ board.rootPath.value || fs.folderName.value }}
    </button>
    <span class="spacer" />
    <template v-if="fs.access.value.state === 'ready' && !fs.locked.value">
      <form v-if="addingColumn" class="add-column-form" @submit.prevent="submitColumn">
        <input
          ref="columnInput"
          v-model="draftColumn"
          aria-label="New column name"
          placeholder="Column name"
          @blur="submitColumn"
          @keydown.esc="
            draftColumn = '';
            addingColumn = false;
          "
        />
      </form>
      <button v-else type="button" @click="startAddingColumn">Add column</button>
    </template>
    <button
      v-if="fs.access.value.state === 'ready' && !fs.locked.value"
      type="button"
      @click="board.reload()"
    >
      Refresh
    </button>
    <button v-if="fs.access.value.state !== 'unsupported'" type="button" @click="fs.pick()">
      Open folder
    </button>
    <CompanionStatus />
    <button v-if="fs.access.value.state === 'ready'" type="button" @click="settingsOpen = true">
      Settings
    </button>
  </header>

  <p v-if="board.error.value" class="error">{{ board.error.value }}</p>

  <main>
    <p v-if="fs.access.value.state === 'unsupported'" class="gate">
      mdello needs the File System Access API. Use Chrome.
    </p>

    <div v-else-if="fs.access.value.state === 'none'" class="gate">
      <p>Pick a board folder containing <code>mdello.yml</code> and markdown cards.</p>
      <button type="button" class="primary" @click="fs.pick()">Open folder…</button>
    </div>

    <div v-else-if="fs.locked.value" class="gate">
      <p>
        <code>{{ fs.folderName.value }}</code> is already open in another mdello tab.
        Only one tab may edit a board, so this one stays closed.
      </p>
      <button type="button" class="primary" @click="fs.retry()">Try again</button>
    </div>

    <div v-else-if="fs.access.value.state === 'needs-permission'" class="gate">
      <p>Reconnect <code>{{ fs.folderName.value }}</code> to grant read/write access again.</p>
      <button type="button" class="primary" @click="fs.grant()">Reconnect</button>
    </div>

    <Board v-else />
  </main>

  <BoardSwitcher v-if="switching" @close="switching = false" />

  <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />

  <Toast />
</template>

<style scoped src="./styles/App.css"></style>
