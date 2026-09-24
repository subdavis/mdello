import { MemoryBoardStore } from '@client/board/stores/memoryBoardStore';
import { openBoardStore } from '@client/composables/useBoard';
import { initializeTheme } from '@client/composables/useTheme';
import '@client/styles/style.css';
import '@client/styles/Topbar.css';
/* Global in the app too, and the card modal's session panel is styled from it. */
import '@client/styles/Agents.css';
import { createApp } from 'vue';
import DemoShell from './DemoShell.vue';
import { demoSeed, GUIDE_CARD_UUID } from './demoSeed';
import InlineCard from './InlineCard.vue';
import ThemeToggle from './ThemeToggle.vue';
import './homepage.css';

/**
 * Copy-to-clipboard for the install command. Plain DOM rather than a component: the button is
 * one line of behaviour attached to static marketing markup, and mounting an app for it would
 * cost more than it saves.
 */
function wireCopyButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy ?? '');
      } catch {
        return; // Clipboard denied; leaving the label alone is the honest outcome.
      }
      button.textContent = 'Copied';
      button.classList.add('is-copied');
      setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('is-copied');
      }, 1600);
    });
  }
}

/**
 * The marketing entry. It opens a memory-backed board and mounts the same board UI the real
 * app uses — no picker, no permissions, no service worker, no registry. The inline card modal
 * is a second mount over that same board, so an edit there lands on the demo above it.
 */
async function start(): Promise<void> {
  initializeTheme();
  await openBoardStore(new MemoryBoardStore(demoSeed, 'demo', 'demo board'));

  createApp(DemoShell).mount('#demo');

  createApp(InlineCard, { uuid: GUIDE_CARD_UUID }).mount('#card-modal');

  createApp(ThemeToggle).mount('#theme-toggle');

  wireCopyButtons();
}

void start();
