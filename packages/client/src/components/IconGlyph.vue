<script setup lang="ts">
defineProps<{ name: string }>();
</script>

<template>
  <svg class="icon-glyph" viewBox="0 0 16 16" focusable="false">
    <path v-if="name === 'close'" d="M1 1l14 14M15 1 1 15" />
    <path v-else-if="name === 'plus'" d="M8 1v14M1 8h14" />
    <path v-else-if="name === 'back'" d="M11.5 1 4.5 8l7 7" />
    <path v-else-if="name === 'edit'" d="m1 15 1.1-4.1L12 1l3 3-9.9 9.9L1 15Zm10-13 3 3" />
    <path v-else-if="name === 'check'" d="m1 8 5 5 9-11" />
    <path v-else-if="name === 'more'" d="M2 8v.01M8 8v.01M14 8v.01" class="icon-glyph-dots" />
    <path
      v-else-if="name === 'paperclip'"
      d="M15 7 8 14a4.25 4.25 0 0 1-6-6l7-7a2.8 2.8 0 0 1 4 4l-7 7a1.4 1.4 0 0 1-2-2l6.5-6.5"
    />
    <circle v-else-if="name === 'status-idle'" cx="8" cy="8" r="7" />
    <template v-else-if="name === 'status-running'">
      <path d="M8 1a7 7 0 0 0 0 14V1Z" class="icon-glyph-fill" />
      <circle cx="8" cy="8" r="7" />
    </template>
    <template v-else-if="name === 'status-waiting_for_input'">
      <circle cx="8" cy="8" r="7" />
      <path d="M5.5 5.5A2.5 2.5 0 1 1 9 7.8C8.3 8.2 8 8.8 8 10M8 13v.01" />
    </template>
    <path v-else-if="name === 'status-ready_for_review'" d="m1 8 5 5 9-11" />
    <template v-else-if="name === 'focus'">
      <path d="M1 6V1H6M10 1H15V6M15 10V15H10M6 15H1V10" />
      <circle cx="8" cy="8" r="1.5" class="icon-glyph-fill" />
    </template>
    <template v-else-if="name === 'status-closed'">
      <circle cx="8" cy="8" r="8" class="icon-glyph-fill" />
      <path d="M4 8h8" class="icon-glyph-contrast" />
    </template>
  </svg>
</template>
