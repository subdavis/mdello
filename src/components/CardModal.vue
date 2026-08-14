<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useBoard } from '../composables/useBoard';
import { formatStamp } from '../format';
import type { Card } from '../fs/board';
import { renderMarkdown } from '../markdown';
import { showToast } from '../composables/useToast';
import TagEditor from './TagEditor.vue';
import MarkdownEditor from './MarkdownEditor.vue';

const props = defineProps<{ card: Card }>();
const emit = defineEmits<{ close: [] }>();

const board = useBoard();
const editing = ref(false);
// A drag that starts inside the modal and ends on the backdrop must not close it.
const pressedBackdrop = ref(false);
const editor = ref<InstanceType<typeof MarkdownEditor> | null>(null);
const rendered = computed(() => renderMarkdown(props.card.body || '_No description_'));
const fullPath = computed(() => `${board.boardName.value}/${props.card.column}/${props.card.name}`);
/** Undefined until `path` is filled in inside the board's .mdello.yml. */
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

/** Only a press that both started and ended on the backdrop counts as a click-away. */
async function onBackdropMouseup(event: MouseEvent): Promise<void> {
  const onBackdrop = event.target === event.currentTarget;
  const shouldClose = pressedBackdrop.value && onBackdrop;
  pressedBackdrop.value = false;
  if (shouldClose) await close();
}

async function close(): Promise<void> {
  await board.flushCard(props.card);
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (editing.value) {
    void save();
    return;
  }
  void close();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    class="backdrop"
    @mousedown.self="pressedBackdrop = true"
    @mouseup="onBackdropMouseup"
  >
    <div class="modal" role="dialog" aria-modal="true">
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
    </div>
  </div>
</template>
