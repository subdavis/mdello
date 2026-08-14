<script setup lang="ts">
import { toast } from '../composables/useToast';
</script>

<template>
  <output v-if="toast" class="toast" aria-live="polite">{{ toast }}</output>
</template>
