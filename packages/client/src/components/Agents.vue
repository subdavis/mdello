<script setup lang="ts">
/**
 * Owns the companion/herdr business logic for one card: the session list.
 * SessionStatusDetails presents the item's default copy action.
 */
import { watch } from 'vue';
import { useBoard } from '../composables/useBoard';
import {
  acknowledgeReadyForReview,
  type Association,
  focusSession,
  forgetSession,
  resumeCommand,
  useAutofocus,
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
const autofocus = useAutofocus();
const herdrEnabled = useHerdrEnabled();
const forgetActions = [
  { label: 'This card', value: 'card' },
  { label: 'All cards', value: 'all' },
];

watch(associations, (entries) => void acknowledgeReadyForReview(entries), { immediate: true });

let autofocusAttempted = false;
watch(
  [autofocus, herdrEnabled, associations],
  ([enabled, canFocus, entries]) => {
    const association = entries.find((entry) => entry.status !== 'closed');
    if (!enabled || !canFocus || autofocusAttempted || !association) return;
    autofocusAttempted = true;
    void focusSession(association);
  },
  { immediate: true },
);

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
    <dd>
      <ul class="agent-session-list">
        <li
          v-for="association in associations"
          :key="`${association.harness}:${association.sessionId}`"
          class="agent-session"
          :class="`status-${association.status}`"
        >
          <SessionStatusDetails
            :association="association"
            :resume-command="resumeCommand(association)"
            @copy="copyResumeCommand(association)"
          />
          <div class="agent-session-actions">
            <button
              v-if="herdrEnabled && association.status !== 'closed'"
              type="button"
              class="icon-button icon-button--small agent-session-action agent-session-focus"
              title="Focus this session's pane"
              @click="focus(association)"
            >
              <IconGlyph name="focus" aria-hidden="true" />
            </button>
            <ActionDropdown
              class="agent-session-dismiss"
              title="Dismiss session"
              :actions="forgetActions"
              button-class="icon-button icon-button--small agent-session-action"
              @select="forget(association, $event)"
            >
              <IconGlyph name="close" aria-hidden="true" />
            </ActionDropdown>
          </div>
        </li>
      </ul>
    </dd>
  </template>
</template>
