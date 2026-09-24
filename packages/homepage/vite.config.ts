import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

const CLIENT_SRC = fileURLToPath(new URL('../client/src', import.meta.url));

/**
 * The whole point of the storage abstraction: the marketing demo runs the real board UI over
 * `MemoryBoardStore`, so nothing here may reach the filesystem backend, the board registry
 * (IndexedDB), the cross-tab lock, or the service worker.
 *
 * Companion is deliberately absent from this list. `Card.vue` still imports the companion
 * singleton, which is inert without a local sidecar; injecting it per component is Phase 3.
 */
const FORBIDDEN = [
  /\/client\/src\/fs\//,
  /[/\\]idb-keyval[/\\]/,
  /\/migrations\/folderColumns/,
  /\/sw\.js$/,
];

/** Fails the build rather than the review: the exclusion stays true instead of being checked once. */
function forbidModules(): Plugin {
  return {
    name: 'mdello:forbid-modules',
    apply: 'build',
    moduleParsed({ id }) {
      const matched = FORBIDDEN.find((pattern) => pattern.test(id));
      if (!matched) return;
      this.error(
        `${id} is reachable from the marketing bundle but must not be (matched ${matched}).`,
      );
    },
  };
}

// Mirrors the client: relative URLs by default so one artifact works at any path.
export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH ?? (command === 'build' ? './' : '/'),
  plugins: [vue(), forbidModules()],
  resolve: {
    alias: { '@client': CLIENT_SRC },
    // The client is a symlinked workspace, so without this Vue resolves twice.
    dedupe: ['vue'],
  },
}));
