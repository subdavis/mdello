<script setup lang="ts">
import CardDetails from '@client/components/CardDetails.vue';
import { useBoard } from '@client/composables/useBoard';
import { computed } from 'vue';

/**
 * The card editor the app opens, in the page's flow rather than over it — no scrim, no close
 * button, nothing to dismiss. It runs on the same in-memory board as the demo above, so a
 * title typed here shows up on that board, and vice versa.
 */
const props = defineProps<{ uuid: string }>();

const board = useBoard();
const card = computed(() =>
  board.columns.value.flatMap((column) => column.cards).find((entry) => entry.uuid === props.uuid),
);
</script>

<template>
  <div class="inline-card">
    <CardDetails v-if="card" :card="card" :closable="false" />
  </div>
</template>
