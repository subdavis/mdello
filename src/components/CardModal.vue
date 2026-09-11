<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useBoard } from '../composables/useBoard';
import { useMarkdownImport } from '../composables/useMarkdownImport';
import { showToast } from '../composables/useToast';
import { formatStamp } from '../format';
import type { CardAttachment } from '../fs/attachments';
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
const markdownImport = useMarkdownImport();
const editing = ref(false);
const editor = ref<InstanceType<typeof MarkdownEditor> | null>(null);
const modalWidth = ref(storedModalWidth());
const modalStyle = computed(() => ({ width: `${modalWidth.value}px` }));
const rendered = computed(() => renderMarkdown(props.card.body || '_No description_'));
const fullPath = computed(() => `${board.boardName.value}/${props.card.column}/${props.card.name}`);
const clipboardPath = computed(() => {
  const root = board.rootPath.value;
  if (!root) return fullPath.value;

  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return [root.replace(/[\\/]+$/, ''), props.card.column, props.card.name].join(separator);
});
/** Undefined until `path` is filled in inside the board's mdello.yml. */
const editorLink = computed(() => board.cardUrl(props.card));

interface LoadedAttachment extends CardAttachment {
  source: File;
  url: string;
  size: number;
  image: boolean;
}

const loadedAttachments = ref<LoadedAttachment[]>([]);
const openImage = ref<LoadedAttachment | null>(null);
const draggingFiles = ref(false);
let draggingAttachmentOut = false;
let attachmentLoad = 0;

function revokeAttachments(): void {
  for (const attachment of loadedAttachments.value) URL.revokeObjectURL(attachment.url);
  loadedAttachments.value = [];
}

function imageFile(attachment: CardAttachment, file: File): boolean {
  const type = file.type || attachment.type;
  return (
    type.startsWith('image/') || /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(attachment.name)
  );
}

async function loadAttachments(): Promise<void> {
  const load = ++attachmentLoad;
  const next: LoadedAttachment[] = [];
  for (const attachment of props.card.attachments) {
    const file = await board.attachmentFile(attachment);
    if (!file) continue;
    next.push({
      ...attachment,
      source: file,
      url: URL.createObjectURL(file),
      size: file.size,
      image: imageFile(attachment, file),
    });
  }

  if (load !== attachmentLoad) {
    for (const attachment of next) URL.revokeObjectURL(attachment.url);
    return;
  }
  revokeAttachments();
  loadedAttachments.value = next;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isFileDrag(event: DragEvent): boolean {
  return !draggingAttachmentOut && (event.dataTransfer?.types.includes('Files') ?? false);
}

function startAttachmentDrag(event: DragEvent, attachment: LoadedAttachment): void {
  const transfer = event.dataTransfer;
  if (!transfer) return;

  draggingAttachmentOut = true;
  draggingFiles.value = false;
  transfer.clearData();
  transfer.effectAllowed = 'copy';
  transfer.items.add(attachment.source);

  // Chromium uses DownloadURL when dragging a browser-backed file into native apps.
  const type = attachment.source.type || attachment.type || 'application/octet-stream';
  const name = attachment.name.replaceAll(':', '-');
  transfer.setData('DownloadURL', `${type}:${name}:${attachment.url}`);
}

function finishAttachmentDrag(): void {
  draggingAttachmentOut = false;
  draggingFiles.value = false;
}

function onDragover(event: DragEvent): void {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  markdownImport.end();
  draggingFiles.value = true;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onDragleave(event: DragEvent): void {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const outside =
    event.clientX <= bounds.left ||
    event.clientX >= bounds.right ||
    event.clientY <= bounds.top ||
    event.clientY >= bounds.bottom;
  if (outside) draggingFiles.value = false;
}

async function onDrop(event: DragEvent): Promise<void> {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  markdownImport.end();
  draggingFiles.value = false;
  const files = [...(event.dataTransfer?.files ?? [])];
  const added = await board.addAttachments(props.card, files);
  if (added) showToast(`Attached ${added} file${added === 1 ? '' : 's'}`);
}

async function removeAttachment(attachment: LoadedAttachment): Promise<void> {
  if (await board.removeAttachment(props.card, attachment)) {
    if (openImage.value?.file === attachment.file) openImage.value = null;
    showToast(`Removed ${attachment.name}`);
  }
}

watch(
  () => props.card.attachments.map((attachment) => attachment.file).join('\n'),
  () => void loadAttachments(),
  { immediate: true },
);

onBeforeUnmount(() => {
  attachmentLoad += 1;
  revokeAttachments();
});

async function copyPath(): Promise<void> {
  await navigator.clipboard.writeText(clipboardPath.value);
  showToast('Copied path');
}

/** Double-clicked block elements carry a data-line attribute, see markdown.ts. */
function lineFromEvent(event: MouseEvent): number {
  const el = (event.target as HTMLElement).closest<HTMLElement>('[data-line]');
  return Number(el?.dataset.line ?? 0);
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
    <div
      class="modal-drop-surface"
      @dragover.stop="onDragover"
      @dragleave.stop="onDragleave"
      @drop.stop="onDrop"
    >
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
      <dt>History</dt>
      <dd>
          <span class="history-item">Created <span class="history-item-date">{{ formatStamp(card.created) }}</span></span>
          <span class="history-item">Modified <span class="history-item-date">{{ formatStamp(card.modified) }}</span></span>
      </dd>
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

    <section class="card-content">
      <div v-if="draggingFiles" class="attachment-dropzone">
        <strong>Drop files to attach</strong>
      </div>
      <template v-else>
        <div v-if="loadedAttachments.length" class="attachments" aria-label="Attachments">
          <article
            v-for="attachment in loadedAttachments"
            :key="attachment.file"
            class="attachment"
            draggable="true"
            @dragstart="startAttachmentDrag($event, attachment)"
            @dragend="finishAttachmentDrag"
          >
            <button
              type="button"
              class="icon-button attachment-remove"
              :title="`Remove ${attachment.name}`"
              aria-label="Remove attachment"
              draggable="false"
              @pointerdown.stop
              @dragstart.stop.prevent
              @click.stop="removeAttachment(attachment)"
            >
              ×
            </button>
            <button
              v-if="attachment.image"
              type="button"
              class="attachment-image"
              :title="`Open ${attachment.name}`"
              @click="openImage = attachment"
            >
              <img :src="attachment.url" :alt="attachment.name" />
            </button>
            <a
              v-else
              class="attachment-file"
              :href="attachment.url"
              target="_blank"
              rel="noopener noreferrer"
              :title="`Open ${attachment.name}`"
            >
              <span class="attachment-file-icon" aria-hidden="true">📎</span>
              <strong>{{ attachment.name }}</strong>
              <small>{{ formatSize(attachment.size) }}</small>
            </a>
            <span class="attachment-caption" :title="attachment.name">{{ attachment.name }}</span>
          </article>
        </div>

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
        <div
          v-else
          class="body markdown"
          title="Double-click to edit"
          @dblclick="startEditing"
          v-html="rendered"
        />
      </template>
    </section>

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
  </Overlay>

  <Overlay
    v-if="openImage"
    place="center"
    panel-class="image-viewer"
    :label="openImage.name"
    @close="openImage = null"
    @escape="openImage = null"
  >
    <img class="image-viewer-image" :src="openImage.url" :alt="openImage.name" />
  </Overlay>
</template>

<style scoped >
.history-item {
  margin-right: 0.5em;
  padding: 0.15em 0.25em;
  background: var(--column-bg);
  border-color: var(--accent);
  border-radius: var(--radius);
  color: var(--muted);
}

.history-item-date {
  font-weight: bold;
  color: var(--text);
}
</style>