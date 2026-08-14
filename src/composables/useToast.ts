import { ref } from 'vue';

export const toast = ref<string | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string, duration = 1600): void {
  toast.value = message;
  clearTimeout(timer);
  timer = setTimeout(() => (toast.value = null), duration);
}
