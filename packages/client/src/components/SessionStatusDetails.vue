<script setup lang="ts">
import { computed } from 'vue';
import type { Association } from '../composables/useCompanion';
import { formatStamp } from '../format';
import IconGlyph from './IconGlyph.vue';

const props = defineProps<{ association: Association; resumeCommand?: string }>();
const emit = defineEmits<{ copy: [] }>();

const statusLabel = computed(() => props.association.status.replaceAll('_', ' '));
const displayedSessionLabel = computed(() =>
  [props.association.harness, props.association.herdrWorkspace, props.association.herdrTab]
    .filter(Boolean)
    .join(': '),
);
const lastActive = computed(() => {
  const { status, updatedAt } = props.association;
  return status === 'closed' && Number.isFinite(Date.parse(updatedAt))
    ? formatStamp(updatedAt)
    : undefined;
});
</script>

<template>
  <button type="button" class="agent-session-copy" :disabled="!resumeCommand"
    :aria-label="`Copy resume command for ${displayedSessionLabel}, ${statusLabel}`"
    :title="resumeCommand ? 'Copy resume command' : `Resume unsupported for ${association.harness}`"
    @click="emit('copy')">
    <span class="agent-session-heading">
      <IconGlyph :name="`status-${association.status}`" class="agent-session-indicator" aria-hidden="true" />
      <span><strong class="agent-session-harness">{{ association.harness }}</strong></span>
      <span class="enriched-ref-status">{{ statusLabel }}</span>
      <span v-if="lastActive" class="agent-session-last-active">
        <time :datetime="association.updatedAt">{{ lastActive }}</time>
      </span>
    </span>
    <template v-if="association.herdrWorkspace && association.herdrTab">
      <span class="agent-session-name">{{ association.herdrTab }}</span>
    </template>

  </button>
</template>
