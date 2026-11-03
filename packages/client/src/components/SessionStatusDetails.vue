<script setup lang="ts">
import { computed } from 'vue';
import type { Association } from '../composables/useCompanion';
import { useNow } from '../composables/useNow';
import { formatRelativeStamp, formatStamp } from '../format';
import IconGlyph from './IconGlyph.vue';

const props = defineProps<{
  association: Association;
  resumeCommand?: string;
  canFocus?: boolean;
}>();
const emit = defineEmits<{ activate: [] }>();
const now = useNow();

const statusLabel = computed(() => props.association.status.replaceAll('_', ' '));
const displayedSessionLabel = computed(() =>
  [props.association.harness, props.association.herdrWorkspace, props.association.herdrTab]
    .filter(Boolean)
    .join(': '),
);
const actionLabel = computed(() => {
  if (props.resumeCommand && props.canFocus) return 'Copy resume command and focus session';
  if (props.resumeCommand) return 'Copy resume command';
  if (props.canFocus) return 'Focus session';
  return undefined;
});
const lastActive = computed(() => {
  const { status, updatedAt } = props.association;
  return status === 'closed' && Number.isFinite(Date.parse(updatedAt))
    ? formatRelativeStamp(updatedAt, now.value)
    : undefined;
});
</script>

<template>
  <button type="button" class="agent-session-copy" :disabled="!actionLabel"
    :aria-label="`${actionLabel ?? 'Session'} for ${displayedSessionLabel}, ${statusLabel}`"
    :title="actionLabel ?? `Resume unsupported for ${association.harness}`"
    @click="emit('activate')">
    <IconGlyph :name="`status-${association.status}`" class="agent-session-indicator" aria-hidden="true" />
    <span class="agent-session-heading">
      <span><strong class="agent-session-harness">{{ association.harness }}</strong></span>
      <span class="enriched-ref-status">{{ statusLabel }}</span>
      <span v-if="lastActive" class="agent-session-last-active">
        <time :datetime="association.updatedAt" :title="formatStamp(association.updatedAt)">{{ lastActive }}</time>
      </span>
    </span>
    <span v-if="association.herdrTab" class="agent-session-name">{{ association.herdrTab }}</span>
  </button>
</template>
