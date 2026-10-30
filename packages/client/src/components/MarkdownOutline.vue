<script setup lang="ts">
import type { MarkdownHeading } from '../markdown';

defineProps<{ headings: MarkdownHeading[] }>();
defineEmits<{ navigate: [line: number] }>();
</script>

<template>
  <ul class="outline-list">
    <li v-for="heading in headings" :key="heading.line">
      <button
        type="button"
        class="outline-heading"
        :style="{ paddingInlineStart: `${(heading.level - 1) * 12 + 4}px` }"
        :title="heading.text || 'Untitled heading'"
        @click="$emit('navigate', heading.line)"
      >
        {{ heading.text || 'Untitled heading' }}
      </button>
      <MarkdownOutline
        v-if="heading.children.length"
        :headings="heading.children"
        @navigate="$emit('navigate', $event)"
      />
    </li>
  </ul>
</template>
