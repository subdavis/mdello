import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// BASE_PATH lets a deploy target pin an absolute subpath. Builds default to relative URLs so
// the same artifact works at / or /apps/mdello/; the dev server still needs an absolute base.
export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH ?? (command === 'build' ? './' : '/'),
  plugins: [vue()],
}));
