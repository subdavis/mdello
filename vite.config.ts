import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// BASE_PATH lets deploy targets (GitHub Pages, internal platform) set a subpath.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [vue()],
});
