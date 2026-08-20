<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useBoard } from '../composables/useBoard';
import { formatStamp } from '../format';
import type { Card } from '../fs/board';
import { renderMarkdown } from '../markdown';
import { showToast } from '../composables/useToast';
import TagEditor from './TagEditor.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import Overlay from './Overlay.vue';

const props = defineProps<{ card: Card }>();
const emit = defineEmits<{ close: [] }>();

const board = useBoard();
const editing = ref(false);
const editor = ref<InstanceType<typeof MarkdownEditor> | null>(null);
const rendered = computed(() => renderMarkdown(props.card.body || '_No description_'));
const fullPath = computed(() => `${board.boardName.value}/${props.card.column}/${props.card.name}`);
/** Undefined until `path` is filled in inside the board's mdello.yml. */
const editorLink = computed(() => board.cardUrl(props.card));

async function copyPath(): Promise<void> {
  await navigator.clipboard.writeText(fullPath.value);
  showToast('Copied path');
}

/** Double-clicked block elements carry a data-line attribute, see markdown.ts. */
function lineFromEvent(event: MouseEvent): number {
  const el = (event.target as HTMLElement).closest('[data-line]');
  return Number(el?.getAttribute('data-line') ?? 0);
}

async function startEditing(event?: MouseEvent): Promise<void> {
  editing.value = true;
  await nextTick();
  await editor.value?.focus(event ? lineFromEvent(event) : 0);
}

async function save(): Promise<void> {
  editing.value = false;
  await board.flushCard(props.card);
}

async function close(): Promise<void> {
  await board.flushCard(props.card);
  emit('close');
}

/** Escape leaves the editor first, so it takes two presses to close a modal mid-edit. */
function onEscape(): void {
  if (editing.value) void save();
  else void close();
}
</script>

<template>
  <Overlay panel-class="modal" label="Card" @close="close" @escape="onEscape">
    <header class="modal-head">
      <input
        class="modal-title"
        aria-label="Card title"
        :value="card.title"
        @input="
          card.title = ($event.target as HTMLInputElement).value;
          board.queueSave(card);
        "
      />
      <button type="button" class="icon-button" title="Close" @click="close">×</button>
    </header>

    <dl class="meta">
      <dt>Created</dt>
      <dd>{{ formatStamp(card.created) }}</dd>
      <dt>Modified</dt>
      <dd>{{ formatStamp(card.modified) }}</dd>
      <template v-if="card.references.length">
        <dt>References</dt>
        <dd>
          <div class="ref-row">
            <a
              v-for="reference in card.references"
              :key="reference.url"
              class="ref"
              :href="reference.url"
              target="_blank"
              rel="noreferrer"
              :title="reference.url"
            >
              <img class="ref-icon" :src="reference.icon" alt="" />
              {{ reference.label }}
            </a>
          </div>
        </dd>
      </template>
      <dt>Assignee</dt>
      <dd>
        <input
          class="meta-input"
          aria-label="Assignee"
          placeholder="Unassigned"
          :value="card.assignee ?? ''"
          @input="
            card.assignee = ($event.target as HTMLInputElement).value;
            board.queueSave(card);
          "
        />
      </dd>
      <dt>File</dt>
      <dd>
        <button type="button" class="path" title="Click to copy path" @click="copyPath">
          {{ fullPath }}
        </button>
      </dd>
      <dt>Labels</dt>
      <dd><TagEditor :card="card" /></dd>
    </dl>

    <MarkdownEditor
      v-if="editing"
      ref="editor"
      :model-value="card.body"
      @update:model-value="
        card.body = $event;
        board.queueSave(card);
      "
    />
    <!-- eslint-disable-next-line vue/no-v-html -- markdown-it runs with html: false -->
    <div v-else class="body markdown" title="Double-click to edit" @dblclick="startEditing" v-html="rendered" />

    <footer class="modal-foot">
      <span class="save-state">{{ board.saveState.value }}</span>
      <a
        v-if="editorLink"
        class="editor-link"
        :href="editorLink"
        :title="editorLink"
      >
        Open in {{ board.editorName.value }}
      </a>
      <button v-if="editing" type="button" class="primary" @click="save">Save</button>
      <button v-else type="button" @click="startEditing">Edit</button>
    </footer>
  </Overlay>
</template>
