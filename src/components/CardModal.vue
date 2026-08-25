<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useBoard } from '../composables/useBoard';
import { showToast } from '../composables/useToast';
import { formatStamp } from '../format';
import type { Card } from '../fs/board';
import { renderMarkdown } from '../markdown';
import MarkdownEditor from './MarkdownEditor.vue';
import Overlay from './Overlay.vue';
import TagEditor from './TagEditor.vue';

const props = defineProps<{ card: Card }>();
const emit = defineEmits<{ close: [] }>();

const MODAL_WIDTH_KEY = 'mdello.cardModalWidth';
const DEFAULT_MODAL_WIDTH = 680;
const MIN_MODAL_WIDTH = 360;

function storedModalWidth(): number {
  const stored = Number(localStorage.getItem(MODAL_WIDTH_KEY));
  return Number.isFinite(stored) && stored >= MIN_MODAL_WIDTH ? stored : DEFAULT_MODAL_WIDTH;
}

const board = useBoard();
const editing = ref(false);
const editor = ref<InstanceType<typeof MarkdownEditor> | null>(null);
const modalWidth = ref(storedModalWidth());
const modalStyle = computed(() => ({ width: `${modalWidth.value}px` }));
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

function startResizing(event: PointerEvent, side: 'left' | 'right'): void {
  if (event.button !== 0) return;

  const handle = event.currentTarget as HTMLElement;
  const panel = handle.closest<HTMLElement>('.modal');
  if (!panel) return;

  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startWidth = panel.getBoundingClientRect().width;
  const direction = side === 'right' ? 1 : -1;

  const onPointerMove = (moveEvent: PointerEvent): void => {
    const requestedWidth = startWidth + (moveEvent.clientX - startX) * direction * 2;
    const viewportWidth = Math.max(MIN_MODAL_WIDTH, window.innerWidth - 24);
    modalWidth.value = Math.round(
      Math.min(viewportWidth, Math.max(MIN_MODAL_WIDTH, requestedWidth)),
    );
  };

  const finish = (): void => {
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
    localStorage.setItem(MODAL_WIDTH_KEY, String(modalWidth.value));
  };

  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

/** Escape leaves the editor first, so it takes two presses to close a modal mid-edit. */
function onEscape(): void {
  if (editing.value) void save();
  else void close();
}
</script>

<template>
  <Overlay :panel-style="modalStyle" panel-class="modal" label="Card" @close="close" @escape="onEscape">
    <div class="modal-resize-handle modal-resize-handle-left" @pointerdown="startResizing($event, 'left')" />
    <div class="modal-resize-handle modal-resize-handle-right" @pointerdown="startResizing($event, 'right')" />

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
