<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { Card } from '../fs/board';
import { type SearchDoc, type SearchResponse, stringifyValue } from '../search/engine';
import { fitSnippet, segments } from '../search/fit';
import type { WorkerRequest, WorkerResponse } from '../search/worker';

const props = defineProps<{ cards: Card[]; open: boolean; focusRequest: number }>();
const emit = defineEmits<{ close: []; select: [card: Card] }>();

const SEARCH_TIMEOUT_MS = 1000;
const INITIAL_MATCHES_PER_CARD = 20;
const HIDDEN_FIELDS = new Set(['title', 'uuid']);

const query = ref('');
const caseSensitive = ref(false);
const regex = ref(false);
const input = ref<HTMLInputElement | null>(null);
const response = shallowRef<SearchResponse>({ results: [] });
const expandedCards = shallowRef<ReadonlySet<string>>(new Set());
const pending = ref(false);

const sent = new Map<string, number>();
let latestRequest = 0;
let inFlightRequest = 0;
let searchTimeout: ReturnType<typeof setTimeout> | undefined;
let syncDebounce: ReturnType<typeof setTimeout> | undefined;
let worker = createWorker();

function createWorker(): Worker {
  const instance = new Worker(new URL('../search/worker.ts', import.meta.url), { type: 'module' });
  instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
    if (event.data.requestId !== latestRequest) {
      if (pending.value) armTimeout(latestRequest);
      else {
        clearTimeout(searchTimeout);
        inFlightRequest = 0;
      }
      return;
    }
    clearTimeout(searchTimeout);
    inFlightRequest = 0;
    expandedCards.value = new Set();
    response.value = event.data.response;
    pending.value = false;
  };
  return instance;
}

// Kills a worker wedged on catastrophic regex backtracking and restores the index.
function armTimeout(requestId: number): void {
  clearTimeout(searchTimeout);
  inFlightRequest = requestId;
  searchTimeout = setTimeout(() => {
    worker.terminate();
    worker = createWorker();
    sent.clear();
    syncCards();
    inFlightRequest = 0;
    if (requestId !== latestRequest) {
      if (query.value) search();
      return;
    }
    pending.value = false;
    response.value = { results: [], error: 'Search timed out.' };
  }, SEARCH_TIMEOUT_MS);
}

function post(message: WorkerRequest): void {
  worker.postMessage(message);
}

function toDoc(card: Card): SearchDoc {
  return {
    id: card.id,
    title: card.title,
    body: card.body,
    fields: Object.entries(card.data)
      .filter(([key]) => !HIDDEN_FIELDS.has(key))
      .map(([key, value]) => [key, stringifyValue(value)]),
  };
}

function syncCards(): boolean {
  const upsert: SearchDoc[] = [];
  const seen = new Set<string>();
  for (const card of props.cards) {
    seen.add(card.id);
    if (sent.get(card.id) === card.modified) continue;
    sent.set(card.id, card.modified);
    upsert.push(toDoc(card));
  }
  const remove: string[] = [];
  for (const id of sent.keys()) {
    if (!seen.has(id)) {
      sent.delete(id);
      remove.push(id);
    }
  }
  if (!upsert.length && !remove.length) return false;
  post({ type: 'update', upsert, remove });
  return true;
}

function flushSync(): void {
  clearTimeout(syncDebounce);
  syncDebounce = undefined;
  if (syncCards() && query.value) search();
}

function search(): void {
  if (syncDebounce !== undefined) {
    clearTimeout(syncDebounce);
    syncDebounce = undefined;
    syncCards();
  }
  latestRequest += 1;
  if (!query.value) {
    expandedCards.value = new Set();
    response.value = { results: [] };
    pending.value = false;
    return;
  }
  pending.value = true;
  if (!inFlightRequest) armTimeout(latestRequest);
  post({
    type: 'search',
    requestId: latestRequest,
    query: query.value,
    options: { caseSensitive: caseSensitive.value, regex: regex.value },
  });
}

// Pauses tracking while hidden; coalesces multi-card saves (e.g. persistOrder) while open.
watch(
  () => {
    if (!props.open) return null;
    let digest = '';
    for (const card of props.cards) digest += `${card.id}:${card.modified}\n`;
    return digest;
  },
  (digest, previous) => {
    if (digest === null) {
      clearTimeout(syncDebounce);
      syncDebounce = undefined;
      return;
    }
    if (previous === null || previous === undefined) {
      flushSync();
      return;
    }
    clearTimeout(syncDebounce);
    syncDebounce = setTimeout(flushSync, 60);
  },
  { immediate: true },
);

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(query, () => {
  clearTimeout(debounce);
  debounce = setTimeout(search, 180);
});
watch([caseSensitive, regex], search);

// Snippet lead-ins are trimmed to the rendered row width, measured from a hidden probe row.
const aside = ref<HTMLElement | null>(null);
const probe = ref<HTMLElement | null>(null);
const metrics = shallowRef({ width: 0, snippetFont: '', tagFont: '', tagExtra: 0 });
const context = document.createElement('canvas').getContext('2d');
let activeFont = '';

function measureText(text: string, font: string): number {
  if (!context || !font) return 0;
  if (font !== activeFont) {
    context.font = font;
    activeFont = font;
  }
  return context.measureText(text).width;
}

function measureRows(): void {
  const row = probe.value;
  const snippet = row?.querySelector<HTMLElement>('.search-snippet');
  const tag = row?.querySelector<HTMLElement>('.tag');
  if (!row || !snippet || !tag || row.clientWidth === 0) return;
  const style = getComputedStyle(row);
  const tagStyle = getComputedStyle(tag);
  const next = {
    width:
      row.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight),
    snippetFont: getComputedStyle(snippet).font,
    tagFont: tagStyle.font,
    tagExtra:
      Number.parseFloat(tagStyle.paddingLeft) +
      Number.parseFloat(tagStyle.paddingRight) +
      Number.parseFloat(style.columnGap || '0'),
  };
  const current = metrics.value;
  if (
    current.width !== next.width ||
    current.snippetFont !== next.snippetFont ||
    current.tagFont !== next.tagFont ||
    current.tagExtra !== next.tagExtra
  ) {
    metrics.value = next;
  }
}

let resizeDebounce: ReturnType<typeof setTimeout> | undefined;
const observer = new ResizeObserver(() => {
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(measureRows, 150);
});
onMounted(() => {
  measureRows();
  if (aside.value) observer.observe(aside.value);
});
onBeforeUnmount(() => {
  observer.disconnect();
  clearTimeout(debounce);
  clearTimeout(resizeDebounce);
  clearTimeout(syncDebounce);
  clearTimeout(searchTimeout);
  worker.terminate();
});

function expandCard(id: string): void {
  const next = new Set(expandedCards.value);
  next.add(id);
  expandedCards.value = next;
}

const fittedResults = computed(() => {
  const { width, snippetFont, tagFont, tagExtra } = metrics.value;
  const expanded = expandedCards.value;
  const results = response.value.results;

  const tagWidths = new Map<string, number>();
  for (const result of results) {
    const limit = expanded.has(result.id) ? result.matches.length : INITIAL_MATCHES_PER_CARD;
    for (let i = 0; i < result.matches.length && i < limit; i += 1) {
      const field = result.matches[i].field;
      if (field && !tagWidths.has(field)) {
        tagWidths.set(field, measureText(field, tagFont) + tagExtra);
      }
    }
  }

  const measure = (text: string) => measureText(text, snippetFont);
  return results.map((result) => {
    const visible = expanded.has(result.id)
      ? result.matches
      : result.matches.slice(0, INITIAL_MATCHES_PER_CARD);
    return {
      id: result.id,
      titleSegments: segments(result.title, result.titleRanges),
      hiddenMatches: result.matches.length - visible.length,
      matches: visible.map((match) => {
        const available = match.field ? width - (tagWidths.get(match.field) ?? 0) : width;
        const fitted = fitSnippet(match, available, measure);
        return { field: match.field, segments: segments(fitted.snippet, fitted.ranges) };
      }),
    };
  });
});

const matchCount = computed(() =>
  response.value.results.reduce((total, result) => total + result.count, 0),
);

function select(id: string): void {
  const card = props.cards.find((entry) => entry.id === id);
  if (card) emit('select', card);
}

const WIDTH_KEY = 'mdello.searchWidth';
const MIN_WIDTH = 200;
const MIN_BOARD_WIDTH = 300;
const width = ref(clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || 300));

function clampWidth(requested: number): number {
  const max = Math.max(MIN_WIDTH, window.innerWidth - MIN_BOARD_WIDTH);
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, requested)));
}

function resize(requested: number): void {
  width.value = clampWidth(requested);
  localStorage.setItem(WIDTH_KEY, String(width.value));
}

function startResizing(event: PointerEvent): void {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  event.preventDefault();
  handle.focus();
  handle.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startWidth = width.value;
  let draggedWidth = startWidth;
  const onPointerMove = (moveEvent: PointerEvent): void => {
    draggedWidth = clampWidth(startWidth + moveEvent.clientX - startX);
    if (aside.value) aside.value.style.width = `${draggedWidth}px`;
  };
  const finish = (): void => {
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('lostpointercapture', finish);
    resize(draggedWidth);
  };
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('lostpointercapture', finish);
}

watch(
  () => [props.open, props.focusRequest],
  async () => {
    if (!props.open) return;
    await nextTick();
    measureRows();
    input.value?.focus();
    input.value?.select();
  },
  { immediate: true },
);
</script>

<template>
  <aside
    ref="aside"
    v-show="open"
    class="search-sidebar"
    :style="{ width: `${width}px` }"
    aria-label="Search cards"
    @keydown.esc.prevent="emit('close')"
  >
    <div ref="probe" class="search-match search-probe" aria-hidden="true">
      <span class="tag" />
      <span class="search-snippet" />
    </div>
    <button
      type="button"
      class="search-resize-handle"
      aria-label="Resize search panel"
      title="Drag to resize search panel, or use the left and right arrow keys"
      @pointerdown="startResizing"
      @keydown.left.prevent="resize(width - 16)"
      @keydown.right.prevent="resize(width + 16)"
    />
    <header class="search-header">
      <h2>Search</h2>
      <button type="button" class="search-close" aria-label="Close search" @click="emit('close')">
        ×
      </button>
    </header>

    <div class="search-controls">
      <input
        ref="input"
        v-model="query"
        type="search"
        aria-label="Search query"
        placeholder="Search"
        spellcheck="false"
      />
      <button
        type="button"
        class="search-toggle"
        :aria-pressed="caseSensitive"
        title="Match Case"
        @click="caseSensitive = !caseSensitive"
      >
        Aa
      </button>
      <button
        type="button"
        class="search-toggle"
        :aria-pressed="regex"
        title="Use Regular Expression"
        @click="regex = !regex"
      >
        .*
      </button>
    </div>

    <p v-if="response.error" class="search-message search-error">{{ response.error }}</p>
    <p v-else-if="!query" class="search-message">Type to search all cards.</p>
    <p v-else-if="!response.results.length" class="search-message">
      {{ pending ? 'Searching…' : 'No results found.' }}
    </p>
    <template v-else>
      <p class="search-message" aria-live="polite">
        {{ matchCount }} {{ matchCount === 1 ? 'result' : 'results' }} in
        {{ response.results.length }} {{ response.results.length === 1 ? 'card' : 'cards' }}
      </p>
      <div class="search-results">
        <details v-for="result in fittedResults" :key="result.id" v-memo="[result]" open>
          <!-- Title opens the card (title-only hits have no rows); the marker toggles. -->
          <summary>
            <span class="search-title" @click.prevent="select(result.id)">
              <template v-for="(part, i) in result.titleSegments" :key="i">
                <mark v-if="part.mark">{{ part.text }}</mark>
                <template v-else>{{ part.text }}</template>
              </template>
            </span>
          </summary>
          <button
            v-for="(match, index) in result.matches"
            :key="index"
            type="button"
            class="search-match"
            @click="select(result.id)"
          >
            <span v-if="match.field" class="tag">{{ match.field }}</span>
            <span class="search-snippet">
              <template v-for="(part, i) in match.segments" :key="i">
                <mark v-if="part.mark">{{ part.text }}</mark>
                <template v-else>{{ part.text }}</template>
              </template>
            </span>
          </button>
          <button
            v-if="result.hiddenMatches"
            type="button"
            class="search-match search-more"
            @click="expandCard(result.id)"
          >
            {{ result.hiddenMatches }} more {{ result.hiddenMatches === 1 ? 'match' : 'matches' }}…
          </button>
        </details>
      </div>
    </template>
  </aside>
</template>

<style src="../styles/SearchSidebar.css"></style>
