<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';

interface DropdownAction {
  label: string;
  value: string;
}

const props = defineProps<{
  title: string;
  actions: DropdownAction[];
  buttonClass?: string;
}>();
const emit = defineEmits<{ select: [value: string] }>();

const open = ref(false);
const root = useTemplateRef<HTMLElement>('root');

function onPointerDown(event: PointerEvent): void {
  if (!open.value || root.value?.contains(event.target as Node)) return;
  open.value = false;
}

function select(value: string): void {
  open.value = false;
  emit('select', value);
}

onMounted(() => document.addEventListener('pointerdown', onPointerDown));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown));
</script>

<template>
  <div ref="root" class="action-dropdown" @keydown.esc="open = false">
    <button
      type="button"
      class="icon-button action-dropdown-trigger"
      :class="buttonClass"
      :aria-expanded="open"
      aria-haspopup="menu"
      :title="title"
      @click="open = !open"
    >
      <slot />
    </button>
    <div v-if="open" class="action-dropdown-menu" role="menu">
      <button
        v-for="action in props.actions"
        :key="action.value"
        type="button"
        role="menuitem"
        @click="select(action.value)"
      >
        {{ action.label }}
      </button>
    </div>
  </div>
</template>

<style scoped src="../styles/ActionDropdown.css"></style>
