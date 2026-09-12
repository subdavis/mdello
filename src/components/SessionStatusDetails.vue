<script setup lang="ts">
import { computed } from 'vue';
import type { Association } from '../composables/useCompanion';
import { showToast } from '../composables/useToast';

const props = defineProps<{ association: Association }>();

const statusLabel = computed(() => props.association.status.replaceAll('_', ' '));
const sessionLabel = computed(
  () => `${props.association.harness}:${props.association.sessionId.split('-').at(-1)}`,
);
const resumeCommand = computed(() => {
  if (props.association.harness === 'pi' || props.association.harness === 'unknown') {
    return `pi --session ${props.association.sessionId}`;
  }
  return undefined;
});

async function copyResumeCommand(): Promise<void> {
  if (!resumeCommand.value) return;
  await navigator.clipboard.writeText(resumeCommand.value);
  showToast('Copied session resume command');
}
</script>

<template>
  <button
    type="button"
    class="session-status-details copyable-details"
    :class="`is-${association.status}`"
    :disabled="!resumeCommand"
    :title="resumeCommand ? `Copy: ${resumeCommand}` : `Resume unsupported for ${association.harness}`"
    @click="copyResumeCommand"
  >
    <span
      class="card-status-indicator session-status-icon"
      :class="`is-${association.status}`"
      aria-hidden="true"
    />
    <code>{{ sessionLabel }}</code>
    <strong>{{ statusLabel }}</strong>
  </button>
</template>

<style scoped>
.session-status-details {
  display: inline-flex;
  align-items: center;
  gap: 0.5em;
  width: fit-content;
  max-width: 100%;
  color: var(--muted);
  font-size: inherit;
  text-align: left;
}


.session-status-details.is-idle,
.session-status-details.is-ready_for_review {
  color: #1f845a;
}

.session-status-details.is-running,
.session-status-details.is-waiting_for_input {
  color: #b38600;
}

.session-status-icon {
  position: relative;
  top: auto;
  right: auto;
  flex: none;
}

.session-status-details code {
  overflow: hidden;
  color: inherit;
  text-overflow: ellipsis;
}

.session-status-details strong {
  color: inherit;
  white-space: nowrap;
}
</style>
