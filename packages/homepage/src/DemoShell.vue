<script setup lang="ts">
import Board from '@client/components/Board.vue';
import Toast from '@client/components/Toast.vue';
import { useBoard } from '@client/composables/useBoard';
import { provideOverlayHost } from '@client/composables/useOverlayHost';
import { nextTick, ref } from 'vue';

/**
 * The demo, dressed as a desktop window: an OS titlebar, then the board's real toolbar, then
 * the board. Deliberately not the client's `App.vue`, which also owns the folder picker,
 * permission gates, settings and companion status — none of which mean anything here.
 */
const board = useBoard();

/**
 * Modals teleport into the window's body rather than into `<body>`, so a dialog dims the app
 * and not the marketing page. `.demo-window` carries `contain: paint`, which makes it the
 * containing block the scrim's `position: fixed` resolves against — and it starts below the
 * titlebar, so the OS chrome stays undimmed.
 */
const layers = ref<HTMLElement | null>(null);
provideOverlayHost(layers);

const addingColumn = ref(false);
const draftColumn = ref('');
const columnInput = ref<HTMLInputElement | null>(null);

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
</script>

<template>
  <div class="demo-app">
    <!-- The OS's share of the window. Decorative, and outside everything below. -->
    <div class="demo-titlebar" aria-hidden="true">
      <span class="demo-light is-close" />
      <span class="demo-light is-minimize" />
      <span class="demo-light is-zoom" />
    </div>

    <div class="demo-window">
      <header class="topbar">
        <strong class="brand">🍺</strong>
        <span class="board-name">{{ board.boardName.value }}</span>
        <span class="spacer" />
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
      </header>

      <div class="demo-board">
        <Board />
      </div>

      <Toast />
      <div ref="layers" class="demo-layers" />
    </div>
  </div>
</template>
