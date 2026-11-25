<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useBoard } from '../composables/useBoard';
import {
  dispatchPrompt,
  dispatchToOrchestrator,
  useOrchestratorStatus,
} from '../composables/useCompanion';
import { showToast } from '../composables/useToast';
import Overlay from './Overlay.vue';

const props = defineProps<{ cardPath: string }>();
const emit = defineEmits<{ close: [] }>();

const board = useBoard();
const prompt = ref(dispatchPrompt(props.cardPath, board.rootPath.value, board.description.value));
const sending = ref(false);
// The orchestrator can start working while this dialog is open.
const orchestratorStatus = useOrchestratorStatus();
const textarea = ref<HTMLTextAreaElement | null>(null);

async function send(): Promise<void> {
  sending.value = true;
  const ok = await dispatchToOrchestrator(prompt.value);
  sending.value = false;
  showToast(ok ? 'Dispatched to orchestrator' : 'Dispatch failed');
  if (ok) emit('close');
}

onMounted(() => textarea.value?.focus());
</script>

<template>
  <Overlay place="center" panel-class="dispatch-dialog" label="Dispatch" @close="emit('close')" @escape="emit('close')">
    <form class="dispatch-form" @submit.prevent="send">
      <h2>Dispatch to orchestrator</h2>
      <textarea ref="textarea" v-model="prompt" rows="6" aria-label="Dispatch prompt" spellcheck="false" />
      <footer class="dispatch-foot">
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="submit" class="primary" :disabled="sending || !prompt.trim() || orchestratorStatus !== 'idle'">Dispatch</button>
      </footer>
    </form>
  </Overlay>
</template>

<style src="../styles/DispatchDialog.css"></style>
