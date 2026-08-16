<script setup lang="ts">
import { onBeforeUnmount, onMounted, watchEffect } from 'vue';
import Board from './components/Board.vue';
import Toast from './components/Toast.vue';
import { useBoard } from './composables/useBoard';
import { showToast } from './composables/useToast';

const board = useBoard();

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
  if (board.locked.value) return board.retry();
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
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

/** An image dropped anywhere in the window becomes the board wallpaper. */
async function onDrop(event: DragEvent): Promise<void> {
  if (!isFileDrag(event)) return;
  event.preventDefault();

  const file = event.dataTransfer?.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Not an image');
    return;
  }

  if (await board.setBackground(file)) showToast('Background updated');
}

onMounted(async () => {
  await board.init();
  window.addEventListener('focus', onFocus);
  window.addEventListener('dragover', onDragover);
  window.addEventListener('drop', onDrop);
});

onBeforeUnmount(() => {
  window.removeEventListener('focus', onFocus);
  window.removeEventListener('dragover', onDragover);
  window.removeEventListener('drop', onDrop);
});
</script>

<template>
  <header class="topbar">
    <strong class="brand">🍺 mdello</strong>
    <span v-if="board.boardName.value" class="board-name">{{ board.rootPath.value ?? board.boardName.value }}</span>
    <span class="spacer" />
    <button
      v-if="board.access.value.state === 'ready' && !board.locked.value"
      type="button"
      @click="board.reload()"
    >
      Refresh
    </button>
    <button v-if="board.access.value.state !== 'unsupported'" type="button" @click="board.pick()">
      Open folder…
    </button>
  </header>

  <p v-if="board.error.value" class="error">{{ board.error.value }}</p>

  <main>
    <p v-if="board.access.value.state === 'unsupported'" class="gate">
      mdello needs the File System Access API. Use Chrome.
    </p>

    <div v-else-if="board.access.value.state === 'none'" class="gate">
      <p>Pick a board folder containing your columns (e.g. <code>content/</code>).</p>
      <button type="button" class="primary" @click="board.pick()">Open folder…</button>
    </div>

    <div v-else-if="board.locked.value" class="gate">
      <p>
        <code>{{ board.boardName.value }}</code> is already open in another mdello tab.
        Only one tab may edit a board, so this one stays closed.
      </p>
      <button type="button" class="primary" @click="board.retry()">Try again</button>
    </div>

    <div v-else-if="board.access.value.state === 'needs-permission'" class="gate">
      <p>Reconnect <code>{{ board.boardName.value }}</code> to grant read/write access again.</p>
      <button type="button" class="primary" @click="board.grant()">Reconnect</button>
    </div>

    <Board v-else />
  </main>

  <Toast />
</template>
