<script setup lang="ts">
/**
 * Owns the companion/herdr business logic for one card: the session list.
 * SessionStatusDetails stays a presentation-only row underneath.
 */
import { watch } from 'vue';
import { useBoard } from '../composables/useBoard';
import {
  acknowledgeReadyForReview,
  type Association,
  focusSession,
  forgetSession,
  resumeCommand,
  useCompanion,
  useHerdrEnabled,
} from '../composables/useCompanion';
import { showToast } from '../composables/useToast';
import type { Card } from '../fs/board';
import ActionDropdown from './ActionDropdown.vue';
import IconGlyph from './IconGlyph.vue';
import SessionStatusDetails from './SessionStatusDetails.vue';

const props = defineProps<{ card: Card }>();

const board = useBoard();
const associations = useCompanion(board.rootPath, props.card);
const herdrEnabled = useHerdrEnabled();
const forgetActions = [
  { label: 'This card', value: 'card' },
  { label: 'All cards', value: 'all' },
];

watch(associations, (entries) => void acknowledgeReadyForReview(entries), { immediate: true });

async function copyResumeCommand(association: Association): Promise<void> {
  const command = resumeCommand(association);
  if (!command) return;
  await navigator.clipboard.writeText(command);
  showToast('Copied session resume command');
}

async function focus(association: Association): Promise<void> {
  showToast((await focusSession(association)) ? 'Focused session' : 'Focus failed');
}

async function forget(association: Association, scope: string): Promise<void> {
  if (scope !== 'card' && scope !== 'all') return;
  showToast((await forgetSession(association, scope)) ? 'Forgot session' : 'Forget failed');
}
</script>

<template>
  <template v-if="board.companionEnabled.value && associations.length">
    <dt>Agents</dt>
    <dd class="session-list">
      <div
        v-for="association in associations"
        :key="`${association.harness}:${association.sessionId}`"
        class="session-row"
      >
        <SessionStatusDetails
          :association="association"
          :resume-command="resumeCommand(association)"
          @copy="copyResumeCommand(association)"
        />
        <button
          v-if="herdrEnabled && association.status !== 'closed'"
          type="button"
          class="icon-button session-action-button session-focus-button"
          :class="`is-${association.status}`"
          style="padding: 0"
          title="Focus this session's pane"
          @click="focus(association)"
        >
          <IconGlyph name="focus" aria-hidden="true" />
        </button>
        <ActionDropdown
          class="session-forget-dropdown"
          title="Forget this session"
          :actions="forgetActions"
          :button-class="`session-action-button is-${association.status}`"
          @select="forget(association, $event)"
        >
          <IconGlyph name="close" aria-hidden="true" />
        </ActionDropdown>
      </div>
    </dd>
  </template>
</template>

