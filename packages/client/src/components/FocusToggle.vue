<script setup lang="ts">
defineProps<{ active: boolean; label: string; title?: string }>();
</script>

<template>
  <button type="button" class="focus-toggle" :class="{ 'is-on': active }" :aria-pressed="active" :title="title">
    <span class="focus-toggle-dot" aria-hidden="true" />
    {{ label }}
  </button>
</template>

<style scoped src="../styles/FocusToggle.css"></style>
