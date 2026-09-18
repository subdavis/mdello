<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useBoard } from '../composables/useBoard';
import {
  setAutofocus,
  setGitHubLinkEnrichment,
  useAutofocus,
  useCompanionStatus,
  useGitHubEnabled,
  useGitHubLinkEnrichment,
} from '../composables/useCompanion';
import { useTheme } from '../composables/useTheme';
import { CONFIG_FILE, DEFAULT_CONFIG } from '../fs/config';
import IconGlyph from './IconGlyph.vue';
import Overlay from './Overlay.vue';

const emit = defineEmits<{ close: [] }>();

/**
 * Only schemes that can open an arbitrary absolute path. Zed's `zed://` reaches internal
 * targets like settings but not files, and `jetbrains://.../navigate/reference` wants a
 * project name plus a project-relative path, so neither can be expressed as a template.
 */
const PRESETS = [
  { name: 'VS Code', template: 'vscode://file{path}' },
  { name: 'Cursor', template: 'cursor://file{path}' },
  { name: 'TextMate, BBEdit', template: 'txmt://open?url=file://{path}' },
  { name: 'Obsidian', template: 'obsidian://open?path={path}' },
];

const board = useBoard();
const { themePreference } = useTheme();
const companionStatus = useCompanionStatus();
const autofocus = useAutofocus();
const githubEnabled = useGitHubEnabled();
const githubLinkEnrichment = useGitHubLinkEnrichment();
const savingAutofocus = ref(false);
const savingGitHubLinkEnrichment = ref(false);
const path = ref(board.rootPath.value);
const editor = ref(board.editorTemplate.value);
const saving = ref(false);
const failed = ref(false);
const autofocusFailed = ref(false);
const pathInput = ref<HTMLInputElement | null>(null);

const editable = computed(
  () => board.access.value.state === 'ready' && board.configReady.value && !board.locked.value,
);

const dirty = computed(
  () =>
    path.value.trim() !== board.rootPath.value ||
    editor.value.trim() !== board.editorTemplate.value,
);

const status = computed(() => {
  if (!editable.value) return 'This board is read-only right now';
  if (saving.value) return 'Saving…';
  if (autofocusFailed.value) return 'Could not update companion settings';
  if (failed.value) return `Could not write ${CONFIG_FILE}`;
  return dirty.value ? 'Unsaved changes' : 'Saved';
});

async function save(): Promise<boolean> {
  if (!editable.value || !dirty.value) return true;

  saving.value = true;
  const saved = await board.saveSettings({
    path: path.value,
    editor: editor.value,
  });
  saving.value = false;
  failed.value = !saved;

  // Resync from config so a blanked editor shows the default it fell back to.
  if (saved) {
    path.value = board.rootPath.value;
    editor.value = board.editorTemplate.value;
  }
  return saved;
}

async function toggleAutofocus(event: Event): Promise<void> {
  savingAutofocus.value = true;
  const enabled = (event.target as HTMLInputElement).checked;
  autofocusFailed.value = !(await setAutofocus(enabled));
  savingAutofocus.value = false;
}

async function toggleGitHubLinkEnrichment(event: Event): Promise<void> {
  savingGitHubLinkEnrichment.value = true;
  const enabled = (event.target as HTMLInputElement).checked;
  autofocusFailed.value = !(await setGitHubLinkEnrichment(enabled));
  savingGitHubLinkEnrichment.value = false;
}

/**
 * Every way out of this dialog saves first — Done, the close button, Escape and click-away.
 * Nothing here is worth losing to a reflexive Escape, and the footer says so.
 */
async function done(): Promise<void> {
  if (await save()) emit('close');
}

onMounted(() => pathInput.value?.focus());
</script>

<template>
  <Overlay panel-class="settings" label="Settings" @close="done" @escape="done">
    <form class="settings-form" @submit.prevent="save">
      <header class="settings-head">
        <h2>Settings</h2>
        <button type="button" class="icon-button" title="Close" @click="done">
          <IconGlyph name="close" aria-hidden="true" />
        </button>
      </header>

      <section class="settings-note">
        <label class="settings-theme">
          <span>
            <span class="settings-label">Theme</span>
            <small class="settings-hint">System follows this device's appearance.</small>
          </span>
          <select v-model="themePreference">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>

      <section class="settings-note">
        <label class="settings-field">
          <span class="settings-label">Board folder</span>
        <input
          ref="pathInput"
          v-model="path"
          :disabled="!editable"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
          type="text"
          placeholder="/Users/you/Documents/mdello"
        />
          <small class="settings-hint">
            Absolute path of this folder. The browser never reveals real paths, so
            mdello cannot fill it in. Setting it turns on the "open in editor"
            link and is required for the companion to function properly.
          </small>
        </label>
      </section>

      <section class="settings-note">
        <label class="settings-field">
          <span class="settings-label">Editor URL</span>
        <input
          v-model="editor"
          :disabled="!editable"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
          type="text"
          :placeholder="DEFAULT_CONFIG.editor"
        />
          <small class="settings-hint">
            Editors that support custom schemes are the only way a web page can hand a file to a native app.
          </small>
        </label>
        <table class="settings-table">
        <tbody>
          <tr v-for="preset in PRESETS" :key="preset.template">
            <th scope="row">{{ preset.name }}</th>
            <td>
              <button
                type="button"
                class="copyable-details settings-preset"
                :disabled="!editable"
                :title="`Use ${preset.template}`"
                @click="editor = preset.template"
              >
                {{ preset.template }}
              </button>
            </td>
          </tr>
        </tbody>
        </table>
      </section>

      <section class="settings-note">
        <h3>Background image</h3>
        <p>
          Drag any image onto the board, or place a file named
          <code>background.&lt;ext&gt;</code>
          into the board folder by hand.
        </p>
      </section>

      <section v-if="companionStatus === 'connected'" class="settings-note">
        <label class="settings-toggle">
          <span>
            <span class="settings-label">Autofocus</span>
            <small class="settings-hint">Focus the active Herdr session when its card opens.</small>
          </span>
          <span class="settings-switch">
            <input
              type="checkbox"
              role="switch"
              :checked="autofocus"
              :disabled="savingAutofocus"
              @change="toggleAutofocus"
            />
            <span aria-hidden="true" />
          </span>
        </label>
      </section>

      <section v-if="companionStatus === 'connected'" class="settings-note">
        <label class="settings-toggle">
          <span>
            <span class="settings-label">GitHub link enrichment</span>
            <small class="settings-hint">
              Fetch PR and issue titles and statuses through <code>gh</code> when a card opens.
            </small>
          </span>
          <span class="settings-switch">
            <input
              type="checkbox"
              role="switch"
              :checked="githubLinkEnrichment"
              :disabled="savingGitHubLinkEnrichment || !githubEnabled"
              @change="toggleGitHubLinkEnrichment"
            />
            <span aria-hidden="true" />
          </span>
        </label>
      </section>

      <footer class="settings-foot">
        <span class="settings-state" :class="{ 'is-error': failed || autofocusFailed }">{{
          status
        }}</span>
        <button
          type="submit"
          class="primary"
          :disabled="!editable || !dirty || saving"
        >
          Save
        </button>
        <button type="button" @click="done">Done</button>
      </footer>
    </form>
  </Overlay>
</template>

<style src="../styles/SettingsDialog.css"></style>
