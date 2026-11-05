<script setup lang="ts">
import { computed } from 'vue';
import { aggregateStatus, useCompanion } from '../composables/useCompanion';
import { useDrag } from '../composables/useDrag';
import { tagStyle } from '../composables/useLabels';
import { useBoard } from '../composables/useBoard';
import { formatRelativeStamp, formatStamp } from '../format';
import { useNow } from '../composables/useNow';
import type { Card } from '../fs/board';
import IconGlyph from './IconGlyph.vue';
import { useBoardExtras } from '../composables/useCardExtras.ts';

const props = defineProps<{ card: Card; preview?: boolean }>();
const emit = defineEmits<{ open: [Card] }>();
const now = useNow();

const drag = useDrag();
const board = useBoard();
const associations = useCompanion(board.rootPath, props.card);
const status = computed(() => aggregateStatus(associations.value));
const statusLabel = computed(() => status.value?.replaceAll('_', ' '));
const isDragging = computed(() => drag.dragging.value?.id === props.card.id);
const extras = useBoardExtras(board, props.card.name);

const referenceRepresentations = computed(() =>
  Object.values(
    props.card.references.reduce(
      (acc, reference) => {
        acc[reference.kind] = reference;
        return acc;
      },
      {} as Record<string, (typeof props.card.references)[0]>,
    ),
  ),
);
</script>

<template>
  <article
    class="card"
    :class="[
      { 'is-dragging': isDragging, 'is-preview': preview },
      status ? `has-status status-${status}` : undefined,
    ]"
    :data-card-id="preview ? undefined : card.id"
    :draggable="!preview"
    @click="!preview && emit('open', card)"
    @dragstart="drag.start($event, card, extras.clipboardPath.value)"
    @dragend="drag.end()"
  >
    <svg v-if="!preview && drag.mergeTarget.value === card.id" class="merge-progress" aria-hidden="true">
      <rect x="0" y="0" width="100%" height="100%" pathLength="100" />
    </svg>
    <IconGlyph
      v-if="status && status !== 'closed'"
      :name="`status-${status}`"
      class="card-status-indicator"
      :class="`is-${status}`"
      role="img"
      :aria-label="`Session status: ${statusLabel}`"
      :title="statusLabel"
    />
    <h3 class="card-title">{{ card.title }}</h3>
    <footer class="card-meta">
      <ul v-if="card.tags.length" class="tags">
        <li v-for="tag in card.tags" :key="tag" class="tag" :style="tagStyle(tag)">{{ tag }}</li>
      </ul>
      <span class="card-meta-end">
        <span
          v-if="card.attachments.length"
          class="card-attachments"
          :title="`${card.attachments.length} attachment${card.attachments.length === 1 ? '' : 's'}`"
          aria-label="Attachments"
        >
          <IconGlyph name="paperclip" class="attachment-icon" aria-hidden="true" />
        </span>
        <span v-if="referenceRepresentations.length" class="card-refs">
          <img
            v-for="reference in referenceRepresentations"
            :key="reference.url"
            class="ref-icon"
            :src="reference.icon"
            :alt="reference.label"
            :title="reference.label"
          />
        </span>
        <span class="stamp" :title="formatStamp(card.modified)">{{ formatRelativeStamp(card.modified, now) }}</span>
      </span>
    </footer>
  </article>
</template>

<style scoped src="../styles/Card.css"></style>
