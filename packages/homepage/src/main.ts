import { MemoryBoardStore } from '@client/board/stores/memoryBoardStore';
import { openBoardStore } from '@client/composables/useBoard';
import { initializeTheme } from '@client/composables/useTheme';
import '@client/styles/style.css';
import '@client/styles/Topbar.css';
import { createApp } from 'vue';
import DemoShell from './DemoShell.vue';
import { demoSeed } from './demoSeed';
import './homepage.css';

/**
 * The marketing entry. It opens a memory-backed board and mounts the same board UI the real
 * app uses — no picker, no permissions, no service worker, no registry.
 */
async function start(): Promise<void> {
  initializeTheme();
  await openBoardStore(new MemoryBoardStore(demoSeed, 'demo', 'demo board'));
  createApp(DemoShell).mount('#demo');
}

void start();
