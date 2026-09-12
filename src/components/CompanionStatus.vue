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

<style scoped>
.companion-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border: 1px solid #d8dae0;
  border-radius: var(--radius);
  background: #f1f2f4;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}

.companion-status:not(:disabled):hover {
  filter: brightness(0.95);
}

.companion-status:disabled {
  cursor: default;
  opacity: 0.65;
}

.companion-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #7e8188;
}

.companion-status.is-connecting {
  border-color: #f5cd47;
  background: #fff7d6;
  color: #7f5f01;
}

.companion-status.is-connecting .companion-status-dot {
  background: #b38600;
}

.companion-status.is-connected {
  border-color: #7ee2b8;
  background: #dcfff1;
  color: #216e4e;
}

.companion-status.is-connected .companion-status-dot {
  background: #1f845a;
}

.companion-status.is-disconnected {
  border-color: #f5a79e;
  background: #ffecea;
  color: #ae2a19;
}

.companion-status.is-disconnected .companion-status-dot {
  background: #c9372c;
}
</style>
