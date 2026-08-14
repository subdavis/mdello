<script setup lang="ts">
import { computed } from 'vue';
import { useDrag } from '../composables/useDrag';
import { tagStyle } from '../composables/useLabels';
import { formatStamp } from '../format';
import type { Card } from '../fs/board';

const props = defineProps<{ card: Card }>();
const emit = defineEmits<{ open: [Card] }>();

const drag = useDrag();
const isDragging = computed(() => drag.dragging.value?.id === props.card.id);
</script>

<template>
  <article
    class="card"
    :class="{ 'is-dragging': isDragging }"
    draggable="true"
    @click="emit('open', card)"
    @dragstart="drag.start($event, card)"
    @dragend="drag.end()"
  >
    <h3 class="card-title">{{ card.title }}</h3>
    <ul v-if="card.tags.length" class="tags">
      <li v-for="tag in card.tags" :key="tag" class="tag" :style="tagStyle(tag)">{{ tag }}</li>
    </ul>
    <footer class="card-meta">
      <span>{{ formatStamp(card.modified) }}</span>
      <span v-if="card.assignee" class="assignee">{{ card.assignee }}</span>
    </footer>
  </article>
</template>
