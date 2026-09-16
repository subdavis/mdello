<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { Card } from '../fs/board';
import { searchCardsAsync, type SearchMatch, type SearchResponse } from '../search';

const props = defineProps<{
  cards: Card[];
  focusRequest: number;
}>();

const emit = defineEmits<{
  close: [];
  select: [card: Card];
}>();

const query = ref('');
const caseSensitive = ref(false);
const regex = ref(false);
const input = ref<HTMLInputElement | null>(null);
const response = ref<SearchResponse>({ results: [] });
const searching = ref(false);
const matchCount = computed(() =>
  response.value.results.reduce(
    (count, result) =>
      count + result.matches.reduce((cardCount, match) => cardCount + match.ranges.length, 0),
    0,
  ),
);

interface Segment {
  text: string;
  highlighted: boolean;
}

function segments(match: SearchMatch): Segment[] {
  const output: Segment[] = [];
  let position = 0;

  for (const range of match.ranges) {
    if (range.start > position) {
      output.push({ text: match.text.slice(position, range.start), highlighted: false });
    }
    output.push({ text: match.text.slice(range.start, range.end), highlighted: true });
    position = range.end;
  }

  if (position < match.text.length) {
    output.push({ text: match.text.slice(position), highlighted: false });
  }
  return output;
}

async function focusInput(): Promise<void> {
  await nextTick();
  input.value?.focus();
  input.value?.select();
}

watch(
  () => [query.value, caseSensitive.value, regex.value, props.cards] as const,
  ([nextQuery, nextCaseSensitive, nextRegex, nextCards], _, onCleanup) => {
    if (!nextQuery) {
      response.value = { results: [] };
      searching.value = false;
      return;
    }

    searching.value = true;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const nextResponse = await searchCardsAsync(
        nextCards,
        nextQuery,
        { caseSensitive: nextCaseSensitive, regex: nextRegex },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      response.value = nextResponse;
      searching.value = false;
    }, 180);

    onCleanup(() => {
      window.clearTimeout(timer);
      controller.abort();
    });
  },
  { immediate: true },
);
watch(() => props.focusRequest, focusInput);
onMounted(focusInput);
</script>

<template>
  <aside class="search-sidebar" aria-label="Board search" @keydown.esc="emit('close')">
    <header class="search-header">
      <h2>Search</h2>
      <button type="button" class="icon-button search-close" aria-label="Close search" @click="emit('close')">
        ×
      </button>
    </header>

    <div class="search-controls">
      <input
        ref="input"
        v-model="query"
        type="text"
        aria-label="Search board"
        placeholder="Search"
        spellcheck="false"
      />
      <button
        type="button"
        class="search-toggle"
        :class="{ active: caseSensitive }"
        :aria-pressed="caseSensitive"
        title="Match Case"
        @click="caseSensitive = !caseSensitive"
      >
        Aa
      </button>
      <button
        type="button"
        class="search-toggle"
        :class="{ active: regex }"
        :aria-pressed="regex"
        title="Use Regular Expression"
        @click="regex = !regex"
      >
        .*
      </button>
    </div>

    <p v-if="!query" class="search-message">Type to search all cards.</p>
    <p v-else-if="searching && response.results.length === 0" class="search-message">Searching…</p>
    <p v-else-if="response.error" class="search-message search-error">{{ response.error }}</p>
    <p v-else-if="response.results.length === 0" class="search-message">No results found.</p>
    <template v-else>
      <p class="search-summary">{{ matchCount }} matches in {{ response.results.length }} cards</p>
      <div class="search-results">
        <details v-for="result in response.results" :key="result.card.id" open>
          <summary>
            <span class="search-file">{{ result.card.title }}</span>
          </summary>
          <button
            v-for="(match, index) in result.matches"
            :key="`${match.field}-${match.line ?? ''}-${index}`"
            type="button"
            class="search-result"
            @click="emit('select', result.card)"
          >
            <span v-if="match.field !== 'body'" class="search-result-location tag">
              {{ match.field }}
            </span>
            <span class="search-result-text">
              <template v-for="(segment, segmentIndex) in segments(match)" :key="segmentIndex">
                <mark v-if="segment.highlighted">{{ segment.text }}</mark>
                <template v-else>{{ segment.text }}</template>
              </template>
            </span>
          </button>
        </details>
      </div>
    </template>
  </aside>
</template>

<style src="../styles/SearchSidebar.css"></style>
