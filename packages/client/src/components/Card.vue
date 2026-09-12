<script setup lang="ts">
import { computed } from 'vue';
import { aggregateStatus, useCompanion } from '../composables/useCompanion';
import { useDrag } from '../composables/useDrag';
import { tagStyle } from '../composables/useLabels';
import { useBoard } from '../composables/useBoard';
import { formatStamp } from '../format';
import type { Card } from '../fs/board';

const props = defineProps<{ card: Card }>();
const emit = defineEmits<{ open: [Card] }>();

const drag = useDrag();
const board = useBoard();
const associations = useCompanion(board.rootPath, props.card);
const status = computed(() => aggregateStatus(associations.value));
const statusLabel = computed(() => status.value?.replaceAll('_', ' '));
const isDragging = computed(() => drag.dragging.value?.id === props.card.id);
</script>

<template>
  <article
    class="card"
    :class="[
      { 'is-dragging': isDragging },
      status ? `has-status status-${status}` : undefined,
    ]"
    :data-card-id="card.id"
    draggable="true"
    @click="emit('open', card)"
    @dragstart="drag.start($event, card)"
    @dragend="drag.end()"
  >
    <span
      v-if="status"
      class="card-status-indicator"
      :class="`is-${status}`"
      role="img"
      :aria-label="`Session status: ${statusLabel}`"
      :title="statusLabel"
    />
    <h3 class="card-title">{{ card.title }}</h3>
    <ul v-if="card.tags.length" class="tags">
      <li v-for="tag in card.tags" :key="tag" class="tag" :style="tagStyle(tag)">{{ tag }}</li>
    </ul>
    <footer class="card-meta">
      <span class="stamp">{{ formatStamp(card.modified) }}</span>
      <span
        v-if="card.attachments.length"
        class="card-attachments"
        :title="`${card.attachments.length} attachment${card.attachments.length === 1 ? '' : 's'}`"
        aria-label="Attachments"
      >
        <svg class="attachment-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M11.5 4.5v7a3.5 3.5 0 0 1-7 0v-8a2.5 2.5 0 0 1 5 0V11a1.5 1.5 0 0 1-3 0V4.5" />
        </svg>
      </span>
      <span v-if="card.references.length" class="card-refs">
        <img
          v-for="reference in card.references"
          :key="reference.url"
          class="ref-icon"
          :src="reference.icon"
          :alt="reference.label"
          :title="reference.label"
        />
      </span>
      <span v-if="card.assignee" class="assignee">{{ card.assignee }}</span>
    </footer>
  </article>
</template>
