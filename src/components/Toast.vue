<script setup lang="ts">
import { dismissToast, toast } from '../composables/useToast';

async function run(): Promise<void> {
  const action = toast.value?.action;
  dismissToast();
  await action?.run();
}
</script>

<template>
  <output
    v-if="toast"
    :key="toast.id"
    class="toast"
    aria-live="polite"
    :style="{ '--toast-duration': `${toast.duration}ms` }"
  >
    {{ toast.message }}
    <button v-if="toast.action" type="button" class="toast-action" @click="run">
      {{ toast.action.label }}
    </button>
  </output>
</template>
