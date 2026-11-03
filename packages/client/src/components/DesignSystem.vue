<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useTheme } from '../composables/useTheme';
import { showToast } from '../composables/useToast';
import { readDesignTokens } from '../designTokens';
import tokenSource from '../styles/style.css?raw';
import IconGlyph from './IconGlyph.vue';
import Overlay from './Overlay.vue';

defineEmits<{ close: [] }>();
const { themePreference } = useTheme();
const query = ref('');
const search = ref<HTMLInputElement | null>(null);
const definitions = readDesignTokens(tokenSource);
const values = ref<Record<string, string>>({});
const activeTheme = ref('');
const sections = [
  {
    id: 'color',
    title: 'Colors',
    description: 'Surfaces, text, borders, status, agents, editor, and archive.',
  },
  { id: 'type', title: 'Typography', description: 'The type scale and monospace family.' },
  {
    id: 'space',
    title: 'Spacing',
    description: 'A 4px base scale, from compact rows to generous gutters.',
  },
  {
    id: 'effect',
    title: 'Shape & layers',
    description: 'Corner radius, shadows, filters, and stacking order.',
  },
];
const icons = [
  'close',
  'plus',
  'back',
  'edit',
  'check',
  'clock',
  'more',
  'paperclip',
  'focus',
  'status-idle',
  'status-running',
  'status-waiting_for_input',
  'status-ready_for_review',
  'status-closed',
];
const statuses = ['success', 'warning', 'danger'] as const;

const tokens = computed(() =>
  definitions.map((token) => {
    const value = values.value[token.name] ?? '';
    const kind = token.name.startsWith('--space-')
      ? 'space'
      : token.name.startsWith('--font-') || token.name === '--mono'
        ? 'type'
        : CSS.supports('color', value)
          ? 'color'
          : 'effect';
    return { ...token, value, kind };
  }),
);
const filteredSections = computed(() => {
  const term = query.value.trim().toLowerCase();
  return sections
    .map((section) => ({
      ...section,
      tokens: tokens.value.filter(
        (token) =>
          token.kind === section.id &&
          `${token.name} ${token.value} ${token.light} ${token.dark} ${section.title}`
            .toLowerCase()
            .includes(term),
      ),
    }))
    .filter((section) => section.tokens.length);
});
const resultCount = computed(() =>
  filteredSections.value.reduce((count, section) => count + section.tokens.length, 0),
);

function refresh(): void {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  values.value = Object.fromEntries(
    definitions.map(({ name }) => [name, styles.getPropertyValue(name).trim()]),
  );
  activeTheme.value = root.dataset.theme ?? 'light';
}

async function copy(name: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(`var(${name})`);
    showToast(`Copied var(${name})`);
  } catch {
    showToast('Could not copy token');
  }
}

const observer = new MutationObserver(refresh);
onMounted(() => {
  refresh();
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style'],
  });
  search.value?.focus();
});
onBeforeUnmount(() => observer.disconnect());
</script>

<template>
  <Overlay panel-class="design-system" label="Design system" @close="$emit('close')" @escape="$emit('close')">
    <header class="ds-header">
      <div>
        <p class="ds-eyebrow">mdello / reference</p>
        <h1>Design system</h1>
        <p class="ds-description">{{ definitions.length }} global tokens · {{ activeTheme }} theme · click a token to copy its CSS variable</p>
      </div>
      <button type="button" class="icon-button" aria-label="Back to settings" title="Back to settings" @click="$emit('close')">
        <IconGlyph name="close" aria-hidden="true" />
      </button>
    </header>

    <div class="ds-toolbar">
      <input ref="search" v-model="query" type="search" aria-label="Search design tokens" placeholder="Find a token or value…" />
      <label class="ds-theme">
        Theme
        <select v-model="themePreference">
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </div>

    <div class="ds-content">
      <nav class="ds-nav" aria-label="Design system sections">
        <a v-for="section in filteredSections" :key="section.id" :href="`#ds-${section.id}`">{{ section.title }} <span>{{ section.tokens.length }}</span></a>
        <a v-if="!query.trim()" href="#ds-components">Components</a>
        <small>{{ resultCount }} / {{ definitions.length }} tokens</small>
      </nav>

      <div class="ds-sections">
        <p v-if="!resultCount" class="ds-empty">No tokens match “{{ query }}”.</p>
        <section v-for="section in filteredSections" :id="`ds-${section.id}`" :key="section.id" class="ds-section">
          <h2>{{ section.title }} <span>{{ section.tokens.length }}</span></h2>
          <p class="ds-description">{{ section.description }}</p>
          <div class="ds-token-grid" :class="{ 'ds-type-grid': section.id === 'type' }">
            <button v-for="token in section.tokens" :key="token.name" type="button" class="ds-token" :class="{ 'ds-type-token': token.kind === 'type' }" :title="`Copy var(${token.name})\nLight: ${token.light}\nDark: ${token.dark}`" @click="copy(token.name)">
              <span v-if="token.kind !== 'type'" class="ds-preview" aria-hidden="true">
                <span v-if="token.kind === 'color'" class="ds-swatch" :style="{ background: `var(${token.name})` }" />
                <span v-else-if="token.kind === 'space'" class="ds-space" :style="{ width: `var(${token.name})` }" />
                <span v-else-if="token.name === '--radius'" class="ds-shape" :style="{ borderRadius: 'var(--radius)' }" />
                <span v-else-if="token.name === '--panel-shadow'" class="ds-shape" :style="{ boxShadow: 'var(--panel-shadow)' }" />
                <span v-else class="ds-effect">{{ token.name.startsWith('--z-') ? token.value : 'ƒ' }}</span>
              </span>
              <span class="ds-token-text">
                <code>{{ token.name }}</code>
                <span class="ds-value">{{ token.value }}</span>
              </span>
              <span v-if="token.kind === 'type'" class="ds-type-sample" :style="token.name === '--mono' ? { fontFamily: 'var(--mono)' } : { fontSize: `var(${token.name})` }">
                <span>The quick brown fox jumps over the lazy dog.</span>
                <span><strong>Ready for review</strong> · <em>Updated 19h ago</em> · 0123456789</span>
                <span class="ds-type-characters">ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz · Il1 O0 · !? @#% &amp; () [] {}</span>
              </span>
            </button>
          </div>
        </section>

        <section v-if="!query.trim()" id="ds-components" class="ds-section">
          <h2>Components</h2>
          <p class="ds-description">Existing controls and semantic colors in context.</p>
          <div class="ds-samples">
            <div class="ds-sample">
              <h3>Actions & labels</h3>
              <div class="ds-sample-row">
                <button type="button">Default</button>
                <button type="button" class="primary">Primary</button>
                <button type="button" class="icon-button" aria-label="Example edit button"><IconGlyph name="edit" aria-hidden="true" /></button>
                <span class="tag">Label</span>
              </div>
              <label class="ds-sample-field">Text input<input placeholder="A card title…" /></label>
            </div>
            <div class="ds-sample">
              <h3>Semantic states</h3>
              <div v-for="status in statuses" :key="status" class="ds-status" :style="{ background: `var(--${status}-bg)`, borderColor: `var(--${status}-line)`, color: `var(--${status}-text)` }">
                <span class="ds-dot" :style="{ background: `var(--${status}-dot)` }" />{{ status }}
              </div>
            </div>
            <div class="ds-sample ds-icons">
              <h3>Icons</h3>
              <div v-for="icon in icons" :key="icon" class="ds-icon-sample">
                <IconGlyph :name="icon" aria-hidden="true" /><code>{{ icon }}</code>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </Overlay>
</template>

<style src="../styles/DesignSystem.css"></style>
