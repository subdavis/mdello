<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useBoard } from '../composables/useBoard';
import type { BoardRef } from '../fs/handle';

const emit = defineEmits<{ close: [] }>();

const board = useBoard();
const query = ref('');
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);

/** The picker sits at the end of the list, so opening a new folder is one more Down + Enter. */
type Entry = { kind: 'board'; board: BoardRef } | { kind: 'pick' };

const entries = computed<Entry[]>(() => {
  const needle = query.value.trim().toLowerCase();

  const matches = board.boards.value.filter(
    (entry) => !needle || `${entry.name} ${entry.path ?? ''}`.toLowerCase().includes(needle),
  );

  return [...matches.map((entry): Entry => ({ kind: 'board', board: entry })), { kind: 'pick' }];
});

function move(delta: number): void {
  const count = entries.value.length;
  active.value = (active.value + delta + count) % count;
}

async function choose(index = active.value): Promise<void> {
  const entry = entries.value[index];
  if (!entry) return;

  // Closed first so the file picker and any permission prompt still see the user gesture.
  emit('close');
  if (entry.kind === 'pick') await board.pick();
  else await board.switchBoard(entry.board.id);
}

async function forget(entry: BoardRef): Promise<void> {
  await board.forgetBoard(entry.id);
  active.value = 0;
}

/** Keeps the highlight on screen once the list is long enough to scroll. */
watch(active, async () => {
  await nextTick();
  list.value?.children[active.value]?.scrollIntoView({ block: 'nearest' });
});

onMounted(() => input.value?.focus());
</script>

<template>
  <div class="switcher-backdrop" @mousedown.self="emit('close')">
    <div class="switcher" role="dialog" aria-modal="true" aria-label="Switch board">
      <input
        ref="input"
        v-model="query"
        class="switcher-input"
        aria-label="Filter boards"
        placeholder="Switch board…"
        @input="active = 0"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="choose()"
        @keydown.esc.stop.prevent="emit('close')"
      />

      <ul ref="list" class="switcher-list">
        <li
          v-for="(entry, index) in entries"
          :key="entry.kind === 'board' ? entry.board.id : 'pick'"
          class="switcher-row"
          :class="{ selected: index === active }"
          @mousemove="active = index"
          @mousedown.prevent
          @click="choose(index)"
        >
          <template v-if="entry.kind === 'board'">
            <span class="switcher-name">{{ entry.board.name }}</span>
            <span class="switcher-path">{{ entry.board.path }}</span>
            <span v-if="entry.board.id === board.activeId.value" class="switcher-tag">current</span>
            <button
              type="button"
              class="switcher-forget"
              title="Forget this board"
              @click.stop="forget(entry.board)"
            >
              ×
            </button>
          </template>
          <span v-else class="switcher-name">Open folder…</span>
        </li>
      </ul>
    </div>
  </div>
</template>
