<script setup lang="ts">
import { computed, ref } from 'vue';
import { useBoard } from '../composables/useBoard';
import { useCompanionConnectionStatus } from '../composables/useCompanion';

const board = useBoard();
const status = useCompanionConnectionStatus(
  board.companionEnabled,
  board.boardUuid,
  board.rootPath,
);
const saving = ref(false);
const label = computed(() => status.value.replace('_', ' '));
const canToggle = computed(
  () =>
    board.access.value.state === 'ready' &&
    board.configReady.value &&
    Boolean(board.rootPath.value) &&
    !board.locked.value &&
    !saving.value,
);
const action = computed(() => (board.companionEnabled.value ? 'Disable' : 'Enable'));
const title = computed(() =>
  board.rootPath.value ? `${action.value} companion connection` : 'Set path in mdello.yml first',
);

async function toggle(): Promise<void> {
  if (!canToggle.value) return;
  saving.value = true;
  await board.setCompanionEnabled(!board.companionEnabled.value);
  saving.value = false;
}
</script>

<template>
  <button
    type="button"
    class="companion-status"
    :class="`is-${status}`"
    :disabled="!canToggle"
    :aria-pressed="board.companionEnabled.value"
    :title="title"
    @click="toggle"
  >
    <span class="companion-status-dot" aria-hidden="true" />
    Companion {{ label }}
  </button>
</template>

<style scoped src="../styles/CompanionStatus.css"></style>
