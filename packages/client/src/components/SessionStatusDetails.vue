<script setup lang="ts">
import { computed } from 'vue';
import type { Association } from '../composables/useCompanion';
import IconGlyph from './IconGlyph.vue';

const props = defineProps<{ association: Association; resumeCommand?: string }>();
const emit = defineEmits<{ copy: [] }>();

const statusLabel = computed(() => props.association.status.replaceAll('_', ' '));
const sessionLabel = computed(
  () => `${props.association.harness}:${props.association.sessionId.split('-').at(-1)}`,
);
</script>

<template>
  <button
    type="button"
    class="session-status-details copyable-details"
    :class="`is-${association.status}`"
    :disabled="!resumeCommand"
    :title="resumeCommand ? `Copy: ${resumeCommand}` : `Resume unsupported for ${association.harness}`"
    @click="emit('copy')"
  >
    <IconGlyph
      :name="`status-${association.status}`"
      class="card-status-indicator session-status-icon"
      :class="`is-${association.status}`"
      aria-hidden="true"
    />
    <code>{{ sessionLabel }}</code>
    <strong>{{ statusLabel }}</strong>
  </button>
</template>
