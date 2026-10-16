<script setup lang="ts">
import { useTheme } from '@client/composables/useTheme';
import type { ThemePreference } from '@client/theme';

/**
 * The page has honoured `data-theme` since it was built but never offered a way to change it.
 * Same composable and same localStorage key as the app, so a visitor's choice here is already
 * in place the first time they open a board.
 */
const { themePreference } = useTheme();

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];
</script>

<template>
  <div class="theme-toggle" role="group" aria-label="Colour theme">
    <button
      v-for="option in OPTIONS"
      :key="option.value"
      type="button"
      class="theme-option"
      :class="{ 'is-active': themePreference === option.value }"
      :aria-pressed="themePreference === option.value"
      @click="themePreference = option.value"
    >
      {{ option.label }}
    </button>
  </div>
</template>
