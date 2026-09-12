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
  resumeCommand,
  useCompanion,
  useHerdrEnabled,
} from '../composables/useCompanion';
import { showToast } from '../composables/useToast';
import type { Card } from '../fs/board';
import SessionStatusDetails from './SessionStatusDetails.vue';
import IconGlyph from './IconGlyph.vue';

const props = defineProps<{ card: Card }>();

const board = useBoard();
const associations = useCompanion(board.rootPath, props.card);
const herdrEnabled = useHerdrEnabled();

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
          class="icon-button session-focus-button"
          :class="`is-${association.status}`"
          style="padding: 0"
          title="Focus this session's pane"
          @click="focus(association)"
        >
          <IconGlyph name="focus" aria-hidden="true" />
        </button>
      </div>
    </dd>
  </template>
</template>

