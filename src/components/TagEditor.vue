<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useBoard } from '../composables/useBoard';
import { chipStyle, labels, PALETTE, tagStyle, type Label } from '../composables/useLabels';
import { showToast } from '../composables/useToast';
import type { Card } from '../fs/board';

interface Row {
  name: string;
  color?: string;
  index?: number;
}

const props = defineProps<{ card: Card }>();

const board = useBoard();
const open = ref(false);
const query = ref('');
const editing = ref<Label | null>(null);
const editIndex = ref<number | null>(null);
const rootEl = ref<HTMLElement | null>(null);
const titleEl = ref<HTMLInputElement | null>(null);

// Tags that match no label are listed too, so they can be unchecked away.
const rows = computed<Row[]>(() => {
  const known = labels.value.map((label, index) => ({ ...label, index }));
  const extras = props.card.tags
    .filter((tag) => !labels.value.some((label) => label.name === tag))
    .map((name) => ({ name }));
  const needle = query.value.trim().toLowerCase();

  return [...known, ...extras].filter((row) => row.name.toLowerCase().includes(needle));
});

function toggle(name: string): void {
  const index = props.card.tags.indexOf(name);
  if (index === -1) props.card.tags.push(name);
  else props.card.tags.splice(index, 1);

  board.queueSave(props.card);
}

async function edit(index?: number): Promise<void> {
  editIndex.value = index ?? null;
  editing.value = index === undefined ? { name: '', color: PALETTE[0] } : { ...labels.value[index] };
  await nextTick();
  titleEl.value?.focus();
}

function submit(): void {
  if (!editing.value) return;

  const name = editing.value.name.trim();
  if (!name) return;

  const clash = labels.value.findIndex((label) => label.name === name);
  if (clash !== -1 && clash !== editIndex.value) {
    showToast(`Label "${name}" already exists`);
    return;
  }

  const next: Label = { name, color: editing.value.color };
  if (editIndex.value === null) {
    labels.value.push(next);
  } else {
    const previous = labels.value[editIndex.value].name;
    labels.value[editIndex.value] = next;
    if (previous !== name) board.renameTag(previous, name);
  }

  editing.value = null;
}

/** Deleting only drops the option; cards keep the tag and it resurfaces as an unknown label. */
function remove(): void {
  if (editIndex.value === null) return;
  labels.value.splice(editIndex.value, 1);
  editing.value = null;
}

function onPointerDown(event: PointerEvent): void {
  if (!open.value || rootEl.value?.contains(event.target as Node)) return;
  open.value = false;
}

// Escape must not reach the modal's handler while the popover is the topmost layer.
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return;
  event.stopPropagation();

  if (editing.value) editing.value = null;
  else open.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown);
  window.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <div ref="rootEl" class="tag-row">
    <button
      v-for="tag in card.tags"
      :key="tag"
      type="button"
      class="tag"
      title="Edit labels"
      :style="tagStyle(tag)"
      @click="open = true"
    >
      {{ tag }}
    </button>

    <button type="button" class="tag-add" title="Labels" @click="open = !open">+</button>

    <div v-if="open" class="labels-pop">
      <header class="labels-head">
        <button
          v-if="editing"
          type="button"
          class="icon-button"
          title="Back to labels"
          @click="editing = null"
        >
          ‹
        </button>
        <strong>
          {{ editing ? (editIndex === null ? 'Create label' : 'Edit label') : 'Labels' }}
        </strong>
        <button type="button" class="icon-button" title="Close" @click="open = false">×</button>
      </header>

      <template v-if="editing">
        <div class="label-preview">
          <span class="label-chip" :style="chipStyle(editing.color)">{{ editing.name }}</span>
        </div>

        <label class="field">
          <span>Title</span>
          <input ref="titleEl" v-model="editing.name" @keydown.enter="submit" />
        </label>

        <div class="field">
          <span>Select a color</span>
          <div class="swatches">
            <button
              v-for="color in PALETTE"
              :key="color"
              type="button"
              class="swatch"
              :class="{ 'is-active': editing.color === color }"
              :style="{ background: color }"
              :title="color"
              @click="editing.color = color"
            >
              {{ editing.color === color ? '✓' : '' }}
            </button>
          </div>
        </div>

        <footer class="label-foot">
          <button type="button" class="primary" @click="submit">
            {{ editIndex === null ? 'Create' : 'Save' }}
          </button>
          <button v-if="editIndex !== null" type="button" class="danger" @click="remove">
            Delete
          </button>
        </footer>
      </template>

      <template v-else>
        <input v-model="query" aria-label="Search labels" placeholder="Search labels…" />

        <p v-if="!rows.length" class="empty">No labels yet.</p>

        <ul v-else class="labels-list">
          <li v-for="row in rows" :key="row.name" class="labels-item">
            <input
              type="checkbox"
              :checked="card.tags.includes(row.name)"
              :aria-label="row.name"
              @change="toggle(row.name)"
            />

            <button
              type="button"
              class="label-chip"
              :class="{ 'is-plain': !row.color }"
              :style="row.color ? chipStyle(row.color) : {}"
              @click="toggle(row.name)"
            >
              {{ row.name }}
            </button>

            <button
              v-if="row.index !== undefined"
              type="button"
              class="icon-button"
              title="Edit label"
              @click="edit(row.index)"
            >
              ✎
            </button>
          </li>
        </ul>

        <button type="button" class="label-create" @click="edit()">Create a new label</button>
      </template>
    </div>
  </div>
</template>
